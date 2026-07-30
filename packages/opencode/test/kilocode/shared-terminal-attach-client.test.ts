// kilocode_change - new file
// Focused attach-client tests. These directly prove the behavior of the
// `attach` module without going through Hono routes — exercising stdin/stdout
// relay, resize emission, Ctrl+] menu dispatch, raw-mode restoration on every
// exit path, and ticket secrecy from the `command` module.
//
// Mocking strategy:
//   - Replaces global WebSocket with a fake whose send() records frames and
//     lets the test drive onopen/onmessage/onerror/onclose explicitly.
//   - Replaces process.stdin/stdout with PassThrough streams so we can set
//     isRaw, emit "data" and "resize" without touching the real TTY, and
//     assert that setRawMode() was restored on every exit path.
//   - Asserts the ticket never appears in argv passed to spawn (we spy on
//     global WebSocket constructor args).

import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { PassThrough } from "node:stream"

// Fake WebSocket: records sends and lets the test drive lifecycle events.
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static lastArgs: { url: string; protocols: string[] } | null = null

  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3

  url: string
  protocols: string[]
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev?: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null
  sent: any[] = []
  closed = false

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols ? (Array.isArray(protocols) ? protocols : [protocols]) : []
    FakeWebSocket.lastArgs = { url, protocols: this.protocols }
    FakeWebSocket.instances.push(this)
  }
  send(data: any) {
    this.sent.push(data)
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
    if (this.onclose) this.onclose({})
  }
  // Test helpers
  fireOpen() {
    this.readyState = FakeWebSocket.OPEN
    if (this.onopen) this.onopen()
  }
  fireMessage(data: string | Buffer | Uint8Array) {
    if (this.onmessage) this.onmessage({ data } as MessageEvent)
  }
  fireError() {
    if (this.onerror) this.onerror(new Event("error"))
  }
  fireClose() {
    if (this.closed) return
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
    if (this.onclose) this.onclose({})
  }
}

describe("shared-terminal attach client — stdin/stdout relay", () => {
  let realWS: typeof WebSocket
  let realStdin: typeof process.stdin
  let realStdout: typeof process.stdout
  let fakeStdin: PassThrough & {
    isRaw?: boolean
    setRawMode?: (v: boolean) => void
    isTTY?: boolean
  }
  let fakeStdout: PassThrough & { columns?: number; rows?: number; isTTY?: boolean }
  let setRawCalls: boolean[]

  beforeEach(() => {
    realWS = (global as any).WebSocket
    ;(global as any).WebSocket = FakeWebSocket
    realStdin = process.stdin
    realStdout = process.stdout
    setRawCalls = []

    fakeStdin = new PassThrough() as any
    fakeStdin.isTTY = true
    fakeStdin.isRaw = false
    fakeStdin.setRawMode = (v: boolean) => {
      setRawCalls.push(v)
      ;(fakeStdin as any).isRaw = v
    }
    ;(process as any).stdin = fakeStdin

    fakeStdout = new PassThrough() as any
    fakeStdout.isTTY = true
    fakeStdout.columns = 80
    fakeStdout.rows = 24
    ;(process as any).stdout = fakeStdout

    FakeWebSocket.instances = []
    FakeWebSocket.lastArgs = null
  })

  afterEach(() => {
    ;(global as any).WebSocket = realWS
    ;(process as any).stdin = realStdin
    ;(process as any).stdout = realStdout
  })

  test("stdin bytes reach the WebSocket", async () => {
    const { attach } = await import("../../src/kilocode/shared-terminal/attach")
    const p = attach({ url: "http://127.0.0.1:0", terminalID: "st-relay", ticket: "duc-ticket", cols: 80, rows: 24 })
    await new Promise((r) => setTimeout(r, 10))
    const ws = FakeWebSocket.instances[0]
    expect(ws).toBeDefined()
    ws.fireOpen()
    await new Promise((r) => setTimeout(r, 5))
    fakeStdin.write(Buffer.from([0x41]))
    await new Promise((r) => setTimeout(r, 10))
    expect(ws.sent.some((s) => s instanceof Uint8Array && s[0] === 0x41)).toBe(true)
    ws.fireClose()
    await p
    expect(setRawCalls).toEqual([true, false])
  })

  test("WebSocket output frame renders to stdout as base64-decoded bytes", async () => {
    const { attach } = await import("../../src/kilocode/shared-terminal/attach")
    const received: Buffer[] = []
    fakeStdout.on("data", (c: Buffer) => received.push(c))
    const p = attach({ url: "http://127.0.0.1:0", terminalID: "st-out", ticket: "duc-ticket", cols: 80, rows: 24 })
    await new Promise((r) => setTimeout(r, 10))
    const ws = FakeWebSocket.instances[0]
    ws.fireOpen()
    await new Promise((r) => setTimeout(r, 5))
    const bytes = Buffer.from("hello")
    ws.fireMessage(JSON.stringify({ type: "output", bytes: bytes.toString("base64") }))
    await new Promise((r) => setTimeout(r, 10))
    const all = Buffer.concat(received).toString()
    expect(all).toContain("hello")
    ws.fireClose()
    await p
    expect(setRawCalls).toEqual([true, false])
  })

  test("resize event sends JSON resize message after onopen", async () => {
    const { attach } = await import("../../src/kilocode/shared-terminal/attach")
    const p = attach({ url: "http://127.0.0.1:0", terminalID: "st-rsz", ticket: "duc-ticket", cols: 80, rows: 24 })
    await new Promise((r) => setTimeout(r, 10))
    const ws = FakeWebSocket.instances[0]
    ws.fireOpen()
    await new Promise((r) => setTimeout(r, 10))
    // First resize from onopen has cols=80; we'll trigger another with 132/43
    fakeStdout.columns = 132
    fakeStdout.rows = 43
    fakeStdout.emit("resize")
    await new Promise((r) => setTimeout(r, 10))
    // findLast gets the most recent resize we triggered
    const resizeMsg = ws.sent.filter((s) => typeof s === "string" && s.includes('"type":"resize"')).pop()
    expect(resizeMsg).toBeDefined()
    const parsed = JSON.parse(resizeMsg as string)
    expect(parsed.cols).toBe(132)
    expect(parsed.rows).toBe(43)
    ws.fireClose()
    await p
    expect(setRawCalls).toEqual([true, false])
  })

  test("Ctrl+] opens menu and choice 3 sends pty.detach and detaches", async () => {
    const { attach } = await import("../../src/kilocode/shared-terminal/attach")
    const p = attach({ url: "http://127.0.0.1:0", terminalID: "st-detach", ticket: "duc-ticket", cols: 80, rows: 24 })
    await new Promise((r) => setTimeout(r, 10))
    const ws = FakeWebSocket.instances[0]
    ws.fireOpen()
    await new Promise((r) => setTimeout(r, 10))
    fakeStdin.write(Buffer.from([0x1d]))
    await new Promise((r) => setTimeout(r, 10))
    fakeStdin.write(Buffer.from([0x33]))
    await new Promise((r) => setTimeout(r, 10))
    const detachMsg = ws.sent.find((s) => typeof s === "string" && s.includes('"type":"pty.detach"'))
    expect(detachMsg).toBeDefined()
    expect(ws.closed).toBe(true)
    const reason = await p
    expect(reason).toBe("detached")
    expect(setRawCalls).toEqual([true, false])
  })

  test("Ctrl+] choice 4 sends pty.kill and closes with pty_terminated", async () => {
    const { attach } = await import("../../src/kilocode/shared-terminal/attach")
    const p = attach({ url: "http://127.0.0.1:0", terminalID: "st-kill", ticket: "duc-ticket", cols: 80, rows: 24 })
    await new Promise((r) => setTimeout(r, 10))
    const ws = FakeWebSocket.instances[0]
    ws.fireOpen()
    await new Promise((r) => setTimeout(r, 10))
    fakeStdin.write(Buffer.from([0x1d]))
    await new Promise((r) => setTimeout(r, 10))
    fakeStdin.write(Buffer.from([0x34]))
    await new Promise((r) => setTimeout(r, 10))
    const killMsg = ws.sent.find((s) => typeof s === "string" && s.includes('"type":"pty.kill"'))
    expect(killMsg).toBeDefined()
    expect(ws.closed).toBe(true)
    const reason = await p
    expect(reason).toBe("pty_terminated")
    expect(setRawCalls).toEqual([true, false])
  })

  test("Ctrl+] choice 2 sends private control message without closing", async () => {
    const { attach } = await import("../../src/kilocode/shared-terminal/attach")
    const p = attach({ url: "http://127.0.0.1:0", terminalID: "st-priv", ticket: "duc-ticket", cols: 80, rows: 24 })
    await new Promise((r) => setTimeout(r, 10))
    const ws = FakeWebSocket.instances[0]
    ws.fireOpen()
    await new Promise((r) => setTimeout(r, 10))
    fakeStdin.write(Buffer.from([0x1d]))
    await new Promise((r) => setTimeout(r, 10))
    fakeStdin.write(Buffer.from([0x32]))
    await new Promise((r) => setTimeout(r, 10))
    const privMsg = ws.sent.find((s) => typeof s === "string" && s.includes('"type":"private"'))
    expect(privMsg).toBeDefined()
    const parsed = JSON.parse(privMsg as string)
    expect(parsed.active).toBe(true)
    expect(ws.closed).toBe(false)
    ws.fireClose()
    await p
    expect(setRawCalls).toEqual([true, false])
  })

  test("Ctrl+] choice 1 returns to terminal without side effects", async () => {
    const { attach } = await import("../../src/kilocode/shared-terminal/attach")
    const p = attach({ url: "http://127.0.0.1:0", terminalID: "st-return", ticket: "duc-ticket", cols: 80, rows: 24 })
    await new Promise((r) => setTimeout(r, 10))
    const ws = FakeWebSocket.instances[0]
    ws.fireOpen()
    await new Promise((r) => setTimeout(r, 10))
    const beforeSent = ws.sent.length
    fakeStdin.write(Buffer.from([0x1d]))
    await new Promise((r) => setTimeout(r, 10))
    fakeStdin.write(Buffer.from([0x31]))
    await new Promise((r) => setTimeout(r, 10))
    // No extra control messages from the menu choice 1
    expect(ws.sent.length).toBe(beforeSent)
    // Stream stdin again — passes through now
    fakeStdin.write(Buffer.from([0x42]))
    await new Promise((r) => setTimeout(r, 10))
    expect(ws.sent.some((s) => s instanceof Uint8Array && s[0] === 0x42)).toBe(true)
    ws.fireClose()
    await p
    expect(setRawCalls).toEqual([true, false])
  })

  test("ws error after open restores raw mode", async () => {
    const { attach } = await import("../../src/kilocode/shared-terminal/attach")
    const p = attach({ url: "http://127.0.0.1:0", terminalID: "st-err", ticket: "duc-ticket", cols: 80, rows: 24 })
    await new Promise((r) => setTimeout(r, 10))
    const ws = FakeWebSocket.instances[0]
    ws.fireOpen()
    await new Promise((r) => setTimeout(r, 10))
    ws.fireError()
    const reason = await p
    expect(reason).toBe("error")
    expect(setRawCalls).toEqual([true, false])
  })

  test("ws constructor throwing restores raw mode (setup partially fails)", async () => {
    ;(global as any).WebSocket = class {
      constructor() {
        throw new Error("boom")
      }
    }
    const { attach } = await import("../../src/kilocode/shared-terminal/attach")
    const reason = await attach({
      url: "http://127.0.0.1:0",
      terminalID: "st-fail",
      ticket: "duc-ticket",
      cols: 80,
      rows: 24,
    })
    expect(reason).toBe("error")
    expect(setRawCalls).toEqual([true, false])
  })

  test("attach rejects missing url/terminalID/ticket without touching raw mode", async () => {
    const { attach } = await import("../../src/kilocode/shared-terminal/attach")
    const reason = await attach({ url: "", terminalID: "", ticket: "", cols: 0, rows: 0 })
    expect(reason).toBe("error")
    expect(setRawCalls).toEqual([])
  })
})

describe("shared-terminal attach client ticket secrecy", () => {
  test("ticket is carried only via the WS subprotocol bearer, never in argv/url", async () => {
    const realWS = (global as any).WebSocket
    ;(global as any).WebSocket = FakeWebSocket
    try {
      const { attach } = await import("../../src/kilocode/shared-terminal/attach")
      const p = attach({
        url: "http://127.0.0.1:0",
        terminalID: "st-secret",
        ticket: "SECRET-TICKET-VALUE",
        cols: 80,
        rows: 24,
      })
      await new Promise((r) => setTimeout(r, 10))
      const ws = FakeWebSocket.instances[0]
      ws.fireOpen()
      await new Promise((r) => setTimeout(r, 10))
      // Contract: ticket NEVER appears in argv (we are calling attach
      // directly, so there is no argv) and NEVER in the URL. The WS URL
      // contains the terminal ID but not the ticket. The subprotocol
      // `ticket.<raw>` is the bearer transport — by design — and is the
      // only legitimate channel for the raw secret.
      expect(ws.url).toContain("st-secret")
      expect(ws.url).not.toContain("SECRET")
      expect(ws.protocols).toContain("kilo.shared-terminal.v1")
      expect(ws.protocols.some((s) => s.startsWith("ticket."))).toBe(true)
      const bearer = ws.protocols.find((s) => s.startsWith("ticket."))
      expect(bearer?.endsWith("SECRET-TICKET-VALUE")).toBe(true)
      ws.fireClose()
      await p
    } finally {
      ;(global as any).WebSocket = realWS
    }
  })
})

describe("shared-terminal command ticket secrecy (Gap 8)", () => {
  test("command deletes KILO_SHARED_TERMINAL_TICKET from process.env before any work", async () => {
    process.env.KILO_SHARED_TERMINAL_TICKET = "TEST-ENV-TICKET-VALUE"
    const realWS = (global as any).WebSocket
    const realStdin = process.stdin
    let envAtConstruct: string | undefined
    ;(global as any).WebSocket = class {
      constructor() {
        envAtConstruct = process.env.KILO_SHARED_TERMINAL_TICKET
      }
      readyState = 0
      onopen: any = null
      onmessage: any = null
      onclose: ((ev?: any) => void) | null = null
      onerror: any = null
      send() {}
      close() {
        if (this.onclose) this.onclose({})
      }
    }
    // Force attach's stdin to look non-TTY so we don't enter raw mode in
    // the test harness.
    const fakeStream = new PassThrough() as any
    fakeStream.isTTY = false
    ;(process as any).stdin = fakeStream
    let wsInstance: any = null
    ;(global as any).WebSocket = class {
      constructor() {
        envAtConstruct = process.env.KILO_SHARED_TERMINAL_TICKET
      }
      readyState = 0
      onopen: any = null
      onmessage: any = null
      onclose: ((ev?: any) => void) | null = null
      onerror: any = null
      send() {}
      close() {
        if (this.onclose) this.onclose({})
      }
    }
    // Capture the instance to close it
    const OriginalWS = (global as any).WebSocket
    ;(global as any).WebSocket = function (...args: any[]) {
      const inst = new OriginalWS(...args)
      wsInstance = inst
      return inst
    } as any
    try {
      const { SharedTerminalCommand } = await import("../../src/kilocode/shared-terminal/command")
      const handler = (SharedTerminalCommand as any).handler
      const ctx = {
        url: "http://127.0.0.1:0",
        "terminal-id": "st-env",
        cols: 80,
        rows: 24,
      }
      const p = handler(ctx)
      // Fire close on the WS so attach promise resolves
      await new Promise((r) => setTimeout(r, 10))
      if (wsInstance?.onclose) wsInstance.onclose({})
      await p
      // ticket env was deleted BEFORE attach's WebSocket constructor ran
      expect(envAtConstruct).toBeUndefined()
      // After handler exits, env is STILL gone
      expect(process.env.KILO_SHARED_TERMINAL_TICKET).toBeUndefined()
    } finally {
      ;(global as any).WebSocket = realWS
      ;(process as any).stdin = realStdin
      delete process.env.KILO_SHARED_TERMINAL_TICKET
    }
  })

  test("SharedTerminalCommand positional shape never accepts ticket as argv", async () => {
    const { SharedTerminalCommand } = await import("../../src/kilocode/shared-terminal/command")
    expect(SharedTerminalCommand.command).toBe("shared-terminal <url> <terminal-id>")
    expect(SharedTerminalCommand.command).not.toContain("ticket")
    const yargsStub: any = {
      positionals: [] as string[],
    }
    yargsStub.positional = (name: string, _opts: any) => {
      yargsStub.positionals.push(name)
      return yargsStub
    }
    yargsStub.option = (name: string, _opts: any) => {
      expect(name).not.toBe("ticket")
      return yargsStub
    }
    const builder = (SharedTerminalCommand as any).builder
    if (typeof builder === "function") builder(yargsStub)
    expect(yargsStub.positionals).toEqual(["url", "terminal-id"])
  })
})
