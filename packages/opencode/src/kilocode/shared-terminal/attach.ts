// kilocode_change - new file
// WebSocket attach client for the shared-terminal. Connects to the real
// WebSocket route, relays stdin to the PTY, renders PTY output, forwards
// resize, supports a local Ctrl+] control menu, and always restores raw
// terminal mode on every exit path.
//
// Control menu (Ctrl+]):
//   1. return to terminal
//   2. toggle human private mode (requires write attachment)
//   3. detach without terminating the PTY
//   4. explicitly terminate the PTY
//
// The visible shared-terminal MUST restore raw mode on:
//   - normal ws close
//   - ws error
//   - detach (Ctrl+] menu option 3)
//   - PTY kill (Ctrl+] menu option 4)
//   - setup partially failing after setRawMode(true) (e.g. ws throws)

export type ExitReason = "detached" | "closed" | "error" | "pty_terminated" | "menu_canceled"

export interface AttachOpts {
  url: string
  terminalID: string
  ticket: string
  cols: number
  rows: number
}

// State machine for the Ctrl+] menu. The prompt is rendered via the same
// stdin raw-mode channel; if the user just presses Enter without typing a
// number, we treat it as a no-op and return to terminal.
type MenuState = "closed" | "open" | "consumed"

function pad(n: number, w: number): string {
  return n.toString().padStart(w, "0")
}

export async function attach(opts: AttachOpts): Promise<ExitReason> {
  // Validate arguments synchronously before mutating terminal mode. A bad
  // argv shape (e.g. no url, no terminal-id) MUST NOT leave raw mode set on
  // the controlling TTY.
  if (!opts.url || !opts.terminalID || !opts.ticket) {
    return "error"
  }
  const cols = Number.isFinite(opts.cols) && opts.cols > 0 ? opts.cols : 80
  const rows = Number.isFinite(opts.rows) && opts.rows > 0 ? opts.rows : 24

  const stdin = process.stdin
  const stdout = process.stdout

  // Capture raw-mode state BEFORE mutating it. Restoring to undefined/false
  // is acceptable when isRaw was undefined (e.g. a redirected stdin pipe).
  const wasRaw = stdin.isRaw
  const hadIsTTY = stdin.isTTY === true
  if (hadIsTTY) stdin.setRawMode(true)

  // Bail to a partial-failure cleanup. We may have already called setRawMode,
  // so the cleanup restores the original raw mode.
  let restoreRaw: () => void
  try {
    restoreRaw = () => {
      if (hadIsTTY) stdin.setRawMode(wasRaw ?? false)
    }
  } catch {
    restoreRaw = () => {}
  }

  let done = false
  let menu: MenuState = "closed"
  let pendingReason: ExitReason | undefined
  let resolve: (r: ExitReason) => void = () => {}

  const p = new Promise<ExitReason>((r) => {
    resolve = r
  })

  function cleanup(reason: ExitReason) {
    if (done) return
    // If we're inside a menu dispatch that already chose a more specific
    // reason, that reason wins over the synthetic "closed" that ws.close()
    // triggers synchronously.
    const r = pendingReason ?? reason
    pendingReason = undefined
    done = true
    restoreRaw()
    stdin.off("data", onStdinData)
    stdout.off("resize", onResize)
    try {
      ws.close()
    } catch {}
    resolve(r)
  }

  function sendStdin(chunk: Buffer): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(new Uint8Array(chunk))
      return true
    } catch {
      return false
    }
  }

  function sendJSON(payload: Record<string, unknown>): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  function renderMenu() {
    if (!hadIsTTY) return
    const prompt =
      "\r\n\x1b[7m  shared-terminal menu  \x1b[0m\r\n" +
      "  1) return to terminal\r\n" +
      "  2) toggle human private mode\r\n" +
      "  3) detach (keep PTY running)\r\n" +
      "  4) terminate PTY\r\n" +
      "\x1b[7m  choice > \x1b[0m"
    process.stdout.write(prompt)
  }

  function clearMenu() {
    // Erase the menu by writing ANSI escape sequences: clear line + cursor up.
    if (!hadIsTTY) return
    process.stdout.write("\x1b[2K\r")
    process.stdout.write("\x1b[1A\x1b[2K\r".repeat(5))
  }

  function dispatchMenuChoice(choice: string): ExitReason | undefined {
    switch (choice) {
      case "1":
        clearMenu()
        return undefined // continue
      case "2":
        clearMenu()
        sendJSON({ type: "private", active: true })
        return undefined
      case "3":
        clearMenu()
        sendJSON({ type: "pty.detach" })
        pendingReason = "detached"
        // Force-close the local WS so the cleanup path runs. The reason
        // "detached" is preserved even though ws.close() triggers a "closed"
        // event -- cleanup() honors the pending reason first.
        try {
          ws.close()
        } catch {}
        return "detached"
      case "4":
        clearMenu()
        sendJSON({ type: "pty.kill" })
        pendingReason = "pty_terminated"
        try {
          ws.close()
        } catch {}
        return "pty_terminated"
      default:
        // Unknown choice — re-render prompt
        renderMenu()
        return undefined
    }
  }

  function onStdinData(chunk: Buffer) {
    if (done) return
    // Handle menu input first when menu is open. Only single-byte keypresses
    // are routed; longer buffers (paste of multi-char data) defer to the
    // terminal after closing the menu.
    if (menu === "open") {
      if (chunk.length === 1) {
        const b = chunk[0]
        // Escape / Ctrl+C / Enter all close the menu without acting.
        if (b === 0x1b || b === 0x03 || b === 0x0d || b === 0x0a) {
          clearMenu()
          menu = "closed"
          return
        }
        if (b >= 0x31 && b <= 0x34) {
          menu = "consumed"
          const next = dispatchMenuChoice(String.fromCharCode(b))
          if (next !== undefined) {
            cleanup(next)
          } else {
            menu = "closed"
          }
          return
        }
        // Other single-byte input while menu is open is ignored — the user
        // should pick 1–4 or escape.
        return
      }
      // Multi-byte input — close the menu and forward everything to stdin.
      clearMenu()
      menu = "closed"
    }

    // Ctrl+] opens the menu
    if (chunk.length === 1 && chunk[0] === 0x1d) {
      menu = "open"
      renderMenu()
      return
    }
    // Forward everything else to the PTY
    sendStdin(chunk)
  }

  function onResize() {
    const c = stdout.columns ?? 80
    const r = stdout.rows ?? 24
    sendJSON({ type: "resize", cols: c, rows: r })
  }

  if (hadIsTTY) {
    stdin.on("data", onStdinData)
    if ("on" in stdout && typeof stdout.on === "function") {
      stdout.on("resize", onResize)
    }
  }

  // Open the WebSocket AFTER attaching stdin listener — that way a failed
  // WebSocket constructor still routes through cleanup() with raw mode
  // restored. ticket stays only in this closure; we never echo it.
  const wsUrl = `${opts.url.replace(/^http/, "ws")}/shared-terminal/${opts.terminalID}/connect`
  let ws: WebSocket
  try {
    ws = new WebSocket(wsUrl, ["kilo.shared-terminal.v1", `ticket.${opts.ticket}`])
  } catch {
    cleanup("error")
    return p
  }

  ws.onopen = () => {
    onResize()
  }

  ws.onmessage = (evt: MessageEvent) => {
    const raw = evt.data
    if (typeof raw === "string") {
      try {
        const msg = JSON.parse(raw)
        if (msg && msg.type === "output" && typeof msg.bytes === "string") {
          const decoded = Buffer.from(msg.bytes, "base64")
          process.stdout.write(decoded)
          return
        }
      } catch {}
      // Non-JSON strings are treated as raw stdout.
      process.stdout.write(raw)
      return
    }
    if (raw instanceof Buffer || raw instanceof Uint8Array) {
      process.stdout.write(Buffer.from(raw))
    }
  }

  ws.onclose = () => cleanup("closed")
  ws.onerror = () => cleanup("error")

  return p
}
