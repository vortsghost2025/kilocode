import { describe, expect, test } from "bun:test"
import { BoxRenderable, parseKeypress, type KeyEvent } from "@opentui/core"
import { createTestRenderer, type MockInput } from "@opentui/core/testing"
import { createRoot } from "solid-js"
import { dispatchLocalInput } from "../../src/cli/cmd/tui/component/prompt/slash-dispatch"
import {
  createTuiTerminal,
  dispatchActiveTerminalKey,
  dispatchTerminalKey,
  renderTerminalOutput,
  terminalLabel,
  type TuiTerminalClient,
  type TuiTerminalEvent,
  type TuiTerminalInfo,
  type TuiTerminalState,
} from "../../src/kilocode/shared-terminal/tui"

class Client implements TuiTerminalClient {
  info: TuiTerminalInfo = {
    sessionID: "session-tui",
    terminalID: "st-shared",
    generation: 7,
    attachmentID: "att-0",
    title: "terminal",
    status: "running",
    cols: 80,
    rows: 24,
  }
  calls = {
    open: 0,
    detach: [] as string[],
    write: [] as Array<{ attachmentID: string; data: string }>,
    resize: [] as Array<{ attachmentID: string; cols: number; rows: number }>,
    terminate: 0,
  }
  handlers = new Set<(event: TuiTerminalEvent) => void>()
  detachGate: Promise<void> | undefined
  resizeGates: Promise<void>[] = []
  resizeActive = 0
  resizeMax = 0

  async open(input: { sessionID: string; directory: string; cursor: number; cols: number; rows: number }) {
    this.calls.open++
    this.info = {
      ...this.info,
      sessionID: input.sessionID,
      attachmentID: `att-${this.calls.open}`,
      status: "running",
      cols: input.cols,
      rows: input.rows,
    }
    return this.info
  }

  async detach(input: { sessionID: string; attachmentID: string }) {
    this.calls.detach.push(input.attachmentID)
    await this.detachGate
  }

  async write(input: { sessionID: string; attachmentID: string; data: string }) {
    this.calls.write.push({ attachmentID: input.attachmentID, data: input.data })
    return this.info
  }

  async resize(input: { sessionID: string; attachmentID: string; cols: number; rows: number }) {
    this.calls.resize.push({ attachmentID: input.attachmentID, cols: input.cols, rows: input.rows })
    this.resizeActive++
    this.resizeMax = Math.max(this.resizeMax, this.resizeActive)
    await this.resizeGates.shift()
    this.resizeActive--
    const result = { ...this.info, attachmentID: input.attachmentID, cols: input.cols, rows: input.rows }
    if (this.info.attachmentID === input.attachmentID) this.info = result
    return result
  }

  async terminate(_input: { sessionID: string }) {
    this.calls.terminate++
  }

  subscribe(handler: (event: TuiTerminalEvent) => void) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  emit(event: TuiTerminalEvent) {
    for (const handler of this.handlers) handler(event)
  }
}

async function withTerminal<T>(
  client: Client,
  fn: (terminal: TuiTerminalState, focus: { count: number }) => Promise<T>,
) {
  return new Promise<T>((resolve, reject) => {
    createRoot((dispose) => {
      const focus = { count: 0 }
      const terminal = createTuiTerminal({
        client,
        sessionID: "session-tui",
        directory: () => "C:/workspace",
        size: () => ({ cols: 80, rows: 24 }),
        focus: () => focus.count++,
        error: (message) => reject(new Error(message)),
      })
      fn(terminal, focus).then(resolve, reject).finally(dispose)
    })
  })
}

const tick = () => Bun.sleep(0)

interface KeyCapture {
  writes: string[]
  events: KeyEvent[]
  hidden: number
  scroll: number[]
  prehandled: boolean
}

async function withKeys(fn: (input: MockInput, capture: KeyCapture) => void | Promise<void>, kittyKeyboard = true) {
  const test = await createTestRenderer({ width: 80, height: 20, kittyKeyboard })
  const capture: KeyCapture = { writes: [], events: [], hidden: 0, scroll: [], prehandled: false }
  const box = new BoxRenderable(test.renderer, {
    id: "shared-terminal-key-test",
    focusable: true,
    onKeyDown(event) {
      capture.events.push(event)
      if (capture.prehandled) event.preventDefault()
      dispatchTerminalKey(event, {
        hide: () => {
          capture.hidden++
        },
        scroll: (lines) => capture.scroll.push(lines),
        write: (data) => capture.writes.push(data),
      })
    },
  })
  test.renderer.root.add(box)
  box.focus()
  try {
    await fn(test.mockInput, capture)
    await tick()
  } finally {
    await test.renderer.destroy()
  }
}

describe("integrated shared terminal TUI state", () => {
  test("terminal panel opens and closes", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      await terminal.open()
      expect(terminal.visible()).toBe(true)
      expect(terminal.attached()).toBe(true)
      await terminal.hide()
      expect(terminal.visible()).toBe(false)
      expect(terminal.attached()).toBe(false)
    })
  })

  test("closing the panel detaches without terminating", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      await terminal.open()
      await terminal.hide()
      expect(client.calls.detach).toEqual(["att-1"])
      expect(client.calls.terminate).toBe(0)
      expect(terminal.info()?.terminalID).toBe("st-shared")
      expect(terminal.status()).toBe("detached")
      expect(terminalLabel(terminal)).toBe("detached")
    })
  })

  test("reopening the panel keeps terminal ID and generation", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      const first = await terminal.open()
      await terminal.hide()
      const second = await terminal.open()
      expect(second.terminalID).toBe(first.terminalID)
      expect(second.generation).toBe(first.generation)
      expect(second.attachmentID).not.toBe(first.attachmentID)
      expect(client.calls.open).toBe(2)
      expect(terminal.attached()).toBe(true)
      expect(terminal.status()).toBe("running")
      expect(terminalLabel(terminal)).toBe("running/attached")
    })
  })

  test("explicit terminate clears the panel terminal", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      await terminal.open()
      await terminal.terminate()
      expect(client.calls.terminate).toBe(1)
      expect(terminal.info()).toBeUndefined()
      expect(terminal.visible()).toBe(false)
      expect(terminal.status()).toBe("terminated")
    })
  })

  test("PTY output events appear in panel output", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      await terminal.open()
      client.emit({
        type: "output",
        sessionID: "session-tui",
        terminalID: "st-shared",
        generation: 7,
        attachmentID: "att-1",
        data: Buffer.from("\u001b[32mAGENT_SHARED_TERMINAL_OK\u001b[0m\r\n").toString("base64"),
        next: 36,
        replay: false,
      })
      expect(renderTerminalOutput(terminal.output())).toContain("AGENT_SHARED_TERMINAL_OK")
    })
  })

  test("panel resize reaches the terminal client", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      await terminal.open()
      await terminal.resize(132, 43)
      expect(client.calls.resize).toEqual([{ attachmentID: "att-1", cols: 132, rows: 43 }])
      expect(terminal.info()).toMatchObject({ cols: 132, rows: 43 })
    })
  })

  test("identical terminal dimensions suppress duplicate resize RPCs", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      await terminal.open()
      await terminal.resize(120, 36)
      await terminal.resize(120, 36)
      expect(client.calls.resize).toEqual([{ attachmentID: "att-1", cols: 120, rows: 36 }])
    })
  })

  test("rapid resize changes coalesce to one latest queued RPC", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      await terminal.open()
      const gate = Promise.withResolvers<void>()
      client.resizeGates.push(gate.promise)
      const first = terminal.resize(100, 30)
      await tick()
      const second = terminal.resize(110, 32)
      const latest = terminal.resize(120, 34)
      expect(client.calls.resize).toEqual([{ attachmentID: "att-1", cols: 100, rows: 30 }])
      expect(client.resizeMax).toBe(1)
      gate.resolve()
      await Promise.all([first, second, latest])
      expect(client.calls.resize).toEqual([
        { attachmentID: "att-1", cols: 100, rows: 30 },
        { attachmentID: "att-1", cols: 120, rows: 34 },
      ])
      expect(client.resizeMax).toBe(1)
    })
  })

  test("resize acknowledgement does not recurse or replace running status", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      const info = await terminal.open()
      await terminal.resize(100, 30)
      client.emit({
        type: "status",
        sessionID: "session-tui",
        terminalID: info.terminalID,
        generation: info.generation,
        attachmentID: info.attachmentID,
        status: "resize",
      })
      await tick()
      expect(client.calls.resize).toHaveLength(1)
      expect(terminal.status()).toBe("running")
      expect(terminal.attached()).toBe(true)
    })
  })

  test("stale resize result from an old attachment is ignored", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      await terminal.open()
      const gate = Promise.withResolvers<void>()
      client.resizeGates.push(gate.promise)
      const resizing = terminal.resize(100, 30)
      await tick()
      await terminal.hide()
      const current = await terminal.open()
      gate.resolve()
      await resizing
      expect(current.attachmentID).toBe("att-2")
      expect(terminal.info()?.attachmentID).toBe("att-2")
      expect(terminal.status()).toBe("running")
      expect(terminal.attached()).toBe(true)
    })
  })

  test("rapid zoom settles on only the final dimensions", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      await terminal.open()
      const gate = Promise.withResolvers<void>()
      client.resizeGates.push(gate.promise)
      const pending = [
        terminal.resize(80, 20),
        terminal.resize(90, 22),
        terminal.resize(100, 24),
        terminal.resize(110, 26),
        terminal.resize(120, 28),
      ]
      await tick()
      gate.resolve()
      await Promise.all(pending)
      expect(client.calls.resize).toEqual([
        { attachmentID: "att-1", cols: 80, rows: 20 },
        { attachmentID: "att-1", cols: 120, rows: 28 },
      ])
      expect(terminal.info()).toMatchObject({ attachmentID: "att-1", cols: 120, rows: 28 })
    })
  })

  test("hiding the panel returns focus to the prompt", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal, focus) => {
      await terminal.open()
      await terminal.hide()
      expect(focus.count).toBe(1)
    })
  })

  test("successful open reports attached and running", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      const info = await terminal.open()
      expect(info.attachmentID).toBe("att-1")
      expect(terminal.attached()).toBe(true)
      expect(terminal.status()).toBe("running")
    })
  })

  test("stale detach from an older attachment is ignored", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      const first = await terminal.open()
      const gate = Promise.withResolvers<void>()
      client.detachGate = gate.promise
      const hiding = terminal.hide()
      await tick()
      const second = await terminal.open()
      client.emit({
        type: "status",
        sessionID: "session-tui",
        terminalID: first.terminalID,
        generation: first.generation,
        attachmentID: first.attachmentID,
        status: "detached",
      })
      gate.resolve()
      await hiding
      expect(second.attachmentID).toBe("att-2")
      expect(terminal.info()?.attachmentID).toBe("att-2")
      expect(terminal.attached()).toBe(true)
      expect(terminal.status()).toBe("running")
    })
  })

  test("input against a detached panel successfully reopens first", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      await terminal.open()
      await terminal.hide()
      await terminal.write("x")
      expect(client.calls.open).toBe(2)
      expect(client.calls.write).toEqual([{ attachmentID: "att-2", data: "x" }])
      expect(terminal.attached()).toBe(true)
      expect(terminal.status()).toBe("running")
    })
  })

  test("/shared-terminal toggles locally with zero provider submissions", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      const calls = { clear: 0, provider: 0 }
      const handled = dispatchLocalInput({
        inputText: "/shared-terminal",
        shellMode: false,
        localSlashes: [{ display: "/shared-terminal", onSelect: () => terminal.toggle() }],
        bang: (command) => terminal.run(command),
        callbacks: {
          clearInput: () => calls.clear++,
          invokeLocal: (slash) => slash.onSelect(),
          reportLocalError: (error) => {
            throw error
          },
        },
      })
      if (!handled) calls.provider++
      await tick()
      expect(terminal.visible()).toBe(true)
      expect(calls.clear).toBe(1)
      expect(calls.provider).toBe(0)
    })
  })

  test("!command creates or reuses the session terminal with zero provider submissions", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      const calls = { provider: 0 }
      for (const value of ["!cd C:/workspace", '!node -e "console.log(process.cwd())"']) {
        const handled = dispatchLocalInput({
          inputText: value,
          shellMode: false,
          localSlashes: [],
          bang: (command) => terminal.run(command),
          callbacks: {
            clearInput() {},
            invokeLocal: (slash) => slash.onSelect(),
            reportLocalError: (error) => {
              throw error
            },
          },
        })
        if (!handled) calls.provider++
        await tick()
      }
      expect(client.calls.open).toBe(1)
      expect(client.calls.write).toEqual([
        { attachmentID: "att-1", data: "cd C:/workspace\r" },
        { attachmentID: "att-1", data: 'node -e "console.log(process.cwd())"\r' },
      ])
      expect(calls.provider).toBe(0)
    })
  })

  test("bare ! toggles the terminal panel", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      const dispatch = () =>
        dispatchLocalInput({
          inputText: "!",
          shellMode: false,
          localSlashes: [],
          bang: (command) => terminal.run(command),
          callbacks: {
            clearInput() {},
            invokeLocal: (slash) => slash.onSelect(),
            reportLocalError: (error) => {
              throw error
            },
          },
        })
      expect(dispatch()).toBe(true)
      await tick()
      expect(terminal.visible()).toBe(true)
      expect(dispatch()).toBe(true)
      await tick()
      expect(terminal.visible()).toBe(false)
    })
  })

  test("legacy /terminal registration still invokes its existing local handler", async () => {
    const calls = { legacy: 0, bang: 0, provider: 0 }
    const handled = dispatchLocalInput({
      inputText: "/terminal",
      shellMode: false,
      localSlashes: [
        {
          display: "/terminal",
          onSelect: () => {
            calls.legacy++
          },
        },
      ],
      bang: () => {
        calls.bang++
      },
      callbacks: {
        clearInput() {},
        invokeLocal: (slash) => slash.onSelect(),
        reportLocalError: (error) => {
          throw error
        },
      },
    })
    if (!handled) calls.provider++
    await tick()
    expect(calls).toEqual({ legacy: 1, bang: 0, provider: 0 })
  })

  test("session global owner routes Return before prompt and restores prompt ownership after hide", async () => {
    const client = new Client()
    await withTerminal(client, async (terminal) => {
      await terminal.open()
      terminal.activate()
      const test = await createTestRenderer({ width: 80, height: 20, kittyKeyboard: false })
      const calls = { global: 0, prompt: 0, provider: 0, panel: 0 }
      const global = (event: KeyEvent) => {
        calls.global++
        dispatchActiveTerminalKey(event, terminal)
      }
      const normal = (event: KeyEvent) => {
        if (event.defaultPrevented) return
        if (!["return", "enter", "linefeed"].includes(event.name)) return
        calls.prompt++
        calls.provider++
      }
      const panel = new BoxRenderable(test.renderer, {
        id: "full-session-terminal-panel",
        focusable: true,
        onKeyDown(event) {
          calls.panel++
          if (event.name.length === 1) void terminal.write(event.sequence)
        },
      })
      test.renderer.root.add(panel)
      panel.focus()
      test.renderer.keyInput.on("keypress", global)
      test.renderer.keyInput.on("keypress", normal)
      try {
        test.mockInput.pressEnter()
        await tick()
        expect(terminal.inputActive()).toBe(true)
        expect(client.calls.write).toEqual([{ attachmentID: "att-1", data: "\r" }])
        expect(calls).toEqual({ global: 1, prompt: 0, provider: 0, panel: 0 })

        test.mockInput.pressBackspace()
        await tick()
        expect(client.calls.write).toEqual([
          { attachmentID: "att-1", data: "\r" },
          { attachmentID: "att-1", data: "\x08" },
        ])
        expect(calls.panel).toBe(0)

        test.mockInput.pressKey("a")
        await tick()
        expect(client.calls.write).toEqual([
          { attachmentID: "att-1", data: "\r" },
          { attachmentID: "att-1", data: "\x08" },
          { attachmentID: "att-1", data: "a" },
        ])
        expect(calls.panel).toBe(1)
        expect(calls.prompt).toBe(0)
        expect(calls.provider).toBe(0)

        await terminal.hide()
        expect(terminal.inputActive()).toBe(false)
        test.mockInput.pressEnter()
        await tick()
        expect(calls.prompt).toBe(1)
        expect(calls.provider).toBe(1)
        expect(client.calls.write).toHaveLength(3)
      } finally {
        test.renderer.keyInput.off("keypress", global)
        test.renderer.keyInput.off("keypress", normal)
        await test.renderer.destroy()
      }
    })
  })
})

describe("integrated terminal real OpenTUI key parser", () => {
  test('type "abc" forwards a, b, and c', async () => {
    await withKeys(async (input, capture) => {
      input.pressKey("a")
      input.pressKey("b")
      input.pressKey("c")
      await tick()
      expect(capture.writes).toEqual(["a", "b", "c"])
    })
  })

  test('type "abc" then Backspace forwards the proven erase byte', async () => {
    await withKeys(async (input, capture) => {
      input.pressKey("a")
      input.pressKey("b")
      input.pressKey("c")
      input.pressBackspace()
      await tick()
      expect(capture.writes).toEqual(["a", "b", "c", "\x7f"])
      expect(capture.events.at(-1)).toMatchObject({
        name: "backspace",
        code: "[127u",
        raw: "\x1b[127u",
        eventType: "press",
        source: "kitty",
      })
    })
  })

  test("raw-mode Backspace preserves the parser erase byte", async () => {
    await withKeys(async (input, capture) => {
      input.pressBackspace()
      await tick()
      expect(capture.events[0]).toMatchObject({ name: "backspace", raw: "\x08", source: "raw" })
      expect(capture.writes).toEqual(["\x08"])
    }, false)
  })

  test("Enter forwards carriage return and is not swallowed", async () => {
    await withKeys(async (input, capture) => {
      input.pressEnter()
      await tick()
      expect(capture.writes).toEqual(["\r"])
      expect(capture.events[0]).toMatchObject({
        name: "return",
        code: "[13u",
        raw: "\x1b[13u",
        eventType: "press",
        source: "kitty",
      })
      expect(capture.events[0].defaultPrevented).toBe(true)
      expect(capture.events[0].propagationStopped).toBe(true)
    })
  })

  test("Delete forwards the terminal forward-delete sequence", async () => {
    await withKeys(async (input, capture) => {
      input.pressKey("DELETE")
      await tick()
      expect(capture.writes).toEqual(["\x1b[3~"])
      expect(capture.events[0]).toMatchObject({
        name: "delete",
        code: "[57349u",
        raw: "\x1b[57349u",
        source: "kitty",
      })
    })
  })

  test("Left and Right forward cursor sequences", async () => {
    await withKeys(async (input, capture) => {
      input.pressArrow("left")
      input.pressArrow("right")
      await tick()
      expect(capture.writes).toEqual(["\x1b[D", "\x1b[C"])
    })
  })

  test("Up forwards the shell-history sequence", async () => {
    await withKeys(async (input, capture) => {
      input.pressArrow("up")
      await tick()
      expect(capture.writes).toEqual(["\x1b[A"])
    })
  })

  test("Down forwards the next-history sequence", async () => {
    await withKeys(async (input, capture) => {
      input.pressArrow("down")
      await tick()
      expect(capture.writes).toEqual(["\x1b[B"])
    })
  })

  test("Home and End forward line-navigation sequences", async () => {
    await withKeys(async (input, capture) => {
      input.pressKey("HOME")
      input.pressKey("END")
      await tick()
      expect(capture.writes).toEqual(["\x1b[H", "\x1b[F"])
    })
  })

  test("Tab reaches the shell", async () => {
    await withKeys(async (input, capture) => {
      input.pressTab()
      await tick()
      expect(capture.writes).toEqual(["\t"])
    })
  })

  test("Ctrl+C forwards one interrupt byte", async () => {
    await withKeys(async (input, capture) => {
      input.pressCtrlC()
      await tick()
      expect(capture.writes).toEqual(["\x03"])
    })
  })

  test("key release sends no duplicate write", async () => {
    await withKeys(async (input, capture) => {
      input.pressCtrlC()
      await input.pressKeys(["\x1b[99;5:3u"])
      await tick()
      expect(parseKeypress("\x1b[99;5:3u", { useKittyKeyboard: true })?.eventType).toBe("release")
      expect(capture.events).toHaveLength(1)
      expect(capture.writes).toEqual(["\x03"])
    })
  })

  test("Kitty repeat events forward one repeated byte", async () => {
    await withKeys(async (input, capture) => {
      await input.pressKeys(["\x1b[97;1:2u"])
      await tick()
      expect(capture.events[0]).toMatchObject({ name: "a", eventType: "press", repeated: true })
      expect(capture.writes).toEqual(["a"])
    })
  })

  test("handled special key prevents default and stops propagation", async () => {
    await withKeys(async (input, capture) => {
      input.pressKey("DELETE")
      await tick()
      expect(capture.events[0].defaultPrevented).toBe(true)
      expect(capture.events[0].propagationStopped).toBe(true)
    })
  })

  test("globally handled terminal toggle key is not handled twice by the panel", async () => {
    await withKeys(async (input, capture) => {
      capture.prehandled = true
      input.pressKey("j")
      await tick()
      expect(capture.events[0].defaultPrevented).toBe(true)
      expect(capture.writes).toEqual([])
      expect(capture.hidden).toBe(0)
    })
  })

  test("focused panel forwards complete KEY_OK command plus submit byte", async () => {
    await withKeys(async (input, capture) => {
      for (const key of "echo KEY_OK") input.pressKey(key)
      input.pressEnter()
      await tick()
      expect(capture.writes.join("")).toBe("echo KEY_OK\r")
    })
  })
})
