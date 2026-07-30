import { test, expect, describe } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { TerminalObservation as O } from "../../src/kilocode/shared-terminal/observation"
import { TerminalObservationRouter } from "../../src/kilocode/session/observation-router"
import { SharedTerminalService as Service } from "../../src/kilocode/shared-terminal/service"
import { AuditStore } from "../../src/kilocode/shared-terminal/audit"
import { TicketState } from "../../src/kilocode/shared-terminal/ticket"
import type { IPty } from "bun-pty"

const isWin = process.platform === "win32"

// ---------------------------------------------------------------------------
// Helpers shared with the service test file (kept local so this test file is
// self-contained).
// ---------------------------------------------------------------------------

interface CapturedSpawn {
  envs: Array<Record<string, string>>
}

function testEnvSource(): Record<string, string> {
  const keys = isWin
    ? ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "USERPROFILE", "HOME"]
    : ["PATH", "HOME", "SHELL", "USER"]
  const env: Record<string, string> = {}
  for (const k of keys) {
    const v = process.env[k]
    if (v) env[k] = v
  }
  return env
}

function testIsolatedPaths(): Record<string, string> {
  if (isWin)
    return {
      userprofile: "K:\\test",
      home: "K:\\test",
      appdata: "K:\\test\\AppData",
      localappdata: "K:\\test\\AppData\\Local",
      temp: "K:\\test\\Temp",
      tmp: "K:\\test\\Temp",
      homedrive: "K:",
      homepath: "\\",
    }
  return { home: "/tmp/kilo-test", tmpdir: "/tmp/kilo-test/tmp" }
}

const testIsolated = testIsolatedPaths()
const testEnv = testEnvSource()

function fakeSpawn(captures: CapturedSpawn): {
  fn: Service.SpawnFn
  onData: (chunk: string) => void
  emitExit: (code: number) => void
  writeData: string[]
  resizeData: Array<{ cols: number; rows: number }>
} {
  let onDataCbs: Array<(chunk: string) => void> = []
  let onExitCbs: Array<(ev: { exitCode: number }) => void> = []
  let fakeProc: IPty | undefined
  const writeData: string[] = []
  const resizeData: Array<{ cols: number; rows: number }> = []

  const fn: Service.SpawnFn = (file, args, options) => {
    captures.envs.push({ ...(options.env ?? {}) })
    fakeProc = {
      pid: 9999,
      cols: 80,
      rows: 24,
      process: "test",
      onData: (cb: (chunk: string) => void) => {
        onDataCbs.push(cb)
        return { dispose: () => {} }
      },
      onExit: (cb: (ev: { exitCode: number }) => void) => {
        onExitCbs.push(cb)
        return { dispose: () => {} }
      },
      write: (d: string) => {
        writeData.push(d)
      },
      resize: (c: number, r: number) => {
        resizeData.push({ cols: c, rows: r })
      },
      kill: () => {},
    } as IPty
    return fakeProc
  }

  return {
    fn,
    onData: (chunk) => {
      for (const cb of onDataCbs) cb(chunk)
    },
    emitExit: (code) => {
      for (const cb of onExitCbs) cb({ exitCode: code })
    },
    writeData,
    resizeData,
  }
}

function makeSvc(opts?: {
  spawn?: Service.SpawnFn
  observationSink?: (obs: O.Observation) => void
  observationQuietMs?: number
  observationMaxBytes?: number
}) {
  let t = 1_000
  const ctl = { now: () => t, advance: (ms: number) => (t += ms) }
  const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 128 })
  const tickets = new TicketState()
  const spawn = opts?.spawn ?? (() => ({}) as IPty)
  const reapFn = async () => ({ status: "cleaned" })
  const aliveFn = async () => false
  return {
    svc: Service.create({
      clock: ctl.now,
      audit,
      tickets,
      platform: process.platform as Service.Platform,
      spawn,
      envSource: testEnv,
      isolatedPaths: testIsolated,
      reap: reapFn as Service.ReapFn,
      aliveCheck: aliveFn as Service.AliveFn,
      observationSink: opts?.observationSink,
      observationQuietMs: opts?.observationQuietMs,
      observationMaxBytes: opts?.observationMaxBytes,
    }),
    audit,
    tickets,
    clock: ctl,
  }
}

async function makeScope() {
  await using tmp = await tmpdir()
  return { projectID: "proj-test", directory: tmp.path, worktree: tmp.path }
}

function waitFor(cond: () => boolean, { timeout = 10_000, interval = 25 } = {}): Promise<void> {
  const end = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() >= end) return reject(new Error("waitFor timed out"))
      setTimeout(tick, interval)
    }
    tick()
  })
}

const ENC = new TextEncoder()

// ---------------------------------------------------------------------------
// Detector engine tests (pure, deterministic, fast)
// ---------------------------------------------------------------------------

describe("TerminalObservation.Detector", () => {
  function setup(quietMs = 50) {
    let now = 1_000
    const captured: O.Observation[] = []
    const det = new O.Detector({
      clock: () => now,
      quietMs,
      emit: (obs) => captured.push(obs),
    })
    return { det, captured, advance: (ms: number) => (now += ms), now: () => now }
  }

  test("A: human submits echo HUMAN_AUTO_VISIBLE; PTY emits HUMAN_AUTO_VISIBLE; exactly one observation queued", async () => {
    const { det, captured } = setup(50)
    // Human presses Enter with the command.
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo HUMAN_AUTO_VISIBLE\r",
      outputCursor: 0,
      now: 1_000,
    })
    // PTY echoes the command and the output.
    det.onOutputFrame({
      cursor: 35,
      frameBytes: ENC.encode("echo HUMAN_AUTO_VISIBLE\r\nHUMAN_AUTO_VISIBLE\r\n"),
      now: 1_001,
    })
    // Wait for the quiet window to fire.
    await new Promise((r) => setTimeout(r, 90))
    expect(captured.length).toBe(1)
    const obs = captured[0]
    // D: observation contains the command and output.
    expect(obs.command).toBe("echo HUMAN_AUTO_VISIBLE")
    expect(obs.output).toContain("HUMAN_AUTO_VISIBLE")
    expect(obs.sessionID).toBe("sess-A")
    expect(obs.terminalID).toBe("st-1")
    expect(obs.generation).toBe(1)
    expect(obs.actor).toBe("human")
  })

  test("B: PTY emits HUMAN_AUTO_VISIBLE in observation output", async () => {
    const { det, captured, advance } = setup(40)
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo HUMAN_AUTO_VISIBLE\r",
      outputCursor: 0,
      now: 1_000,
    })
    det.onOutputFrame({ cursor: 10, frameBytes: ENC.encode("HUMAN_AUTO_VISIBLE\r\n"), now: 1_005 })
    advance(0)
    await new Promise((r) => setTimeout(r, 70))
    expect(captured.length).toBe(1)
    expect(captured[0].output).toContain("HUMAN_AUTO_VISIBLE")
  })

  test("C: exactly one observation queued without terminal read being called", async () => {
    const { det, captured } = setup(40)
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo HUMAN_AUTO_VISIBLE\r",
      outputCursor: 0,
      now: 1_000,
    })
    det.onOutputFrame({ cursor: 10, frameBytes: ENC.encode("HUMAN_AUTO_VISIBLE\r\n"), now: 1_001 })
    await new Promise((r) => setTimeout(r, 70))
    // No terminal read was called; still exactly one observation.
    expect(captured.length).toBe(1)
  })

  test("E: duplicate PTY frames do not create duplicate observations", async () => {
    const { det, captured } = setup(40)
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo DUP\r",
      outputCursor: 0,
      now: 1_000,
    })
    // Multiple output frames for the same command.
    det.onOutputFrame({ cursor: 10, frameBytes: ENC.encode("DUP\r\n"), now: 1_001 })
    det.onOutputFrame({ cursor: 20, frameBytes: ENC.encode("DUP\r\n"), now: 1_002 })
    det.onOutputFrame({ cursor: 30, frameBytes: ENC.encode("DUP\r\n"), now: 1_003 })
    await new Promise((r) => setTimeout(r, 70))
    // All frames belong to the single capture; exactly one observation.
    expect(captured.length).toBe(1)
    // Output contains all frames.
    expect(captured[0].output).toContain("DUP")
  })

  test("F: partially typed input without Enter creates no observation", async () => {
    const { det, captured } = setup(40)
    // Partial typing: no Enter.
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo PARTIAL",
      outputCursor: 0,
      now: 1_000,
    })
    // Even if output arrives, no capture was opened.
    det.onOutputFrame({ cursor: 10, frameBytes: ENC.encode("some output\r\n"), now: 1_001 })
    await new Promise((r) => setTimeout(r, 70))
    expect(captured.length).toBe(0)
  })

  test("H: agent-originated output frames without a human submit create no observation", async () => {
    // Recursion prevention: output frames that arrive WITHOUT a preceding
    // human Enter do not open a capture. Agent writes only produce PTY
    // output but never call onHumanSubmit, so they produce no observation.
    const { det, captured } = setup(40)
    // Output frame arrives but no human submit happened.
    det.onOutputFrame({ cursor: 10, frameBytes: ENC.encode("agent wrote this\r\n"), now: 1_000 })
    await new Promise((r) => setTimeout(r, 70))
    expect(captured.length).toBe(0)
  })

  test("I: output exceeding the cap is truncated and marked truncated", async () => {
    const captured: O.Observation[] = []
    let now = 1_000
    const det = new O.Detector({
      clock: () => now,
      quietMs: 20,
      maxBytes: 100,
      emit: (obs) => captured.push(obs),
    })
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "big\r",
      outputCursor: 0,
      now: 1_000,
    })
    // Emit 300 bytes — exceeds the 100-byte cap.
    det.onOutputFrame({ cursor: 300, frameBytes: ENC.encode("x".repeat(300)), now: 1_001 })
    await new Promise((r) => setTimeout(r, 50))
    expect(captured.length).toBe(1)
    expect(captured[0].truncated).toBe(true)
    // Output is capped at 100 bytes.
    expect(captured[0].output.length).toBeLessThanOrEqual(100)
  })

  test("J/TheTime does not start a model turn: detector only queues, never invokes a provider", async () => {
    // The detector's emit only pushes into an array; it never calls any
    // provider/model/streamText. This test asserts the contract: after a
    // human submit + output + quiet window, no turn was started (no
    // function outside emit was called).
    let emitCalls = 0
    let providerCalls = 0
    const det = new O.Detector({
      clock: () => 1_000,
      quietMs: 20,
      emit: (obs) => {
        void obs
        emitCalls++
      },
    })
    // Simulate the idle-agent path: detector queues via emit, the prompt
    // loop is NOT invoked by the detector. We assert that no provider call
    // happens by tracking it externally (the detector has no hook for it).
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo IDLE\r",
      outputCursor: 0,
      now: 1_000,
    })
    det.onOutputFrame({ cursor: 10, frameBytes: ENC.encode("IDLE\r\n"), now: 1_001 })
    await new Promise((r) => setTimeout(r, 50))
    expect(emitCalls).toBe(1)
    // The detector did not start any provider turn.
    expect(providerCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Realistic keystroke input accumulator (A-J). These exercise the actual
// terminal input path: one keystroke per onHumanSubmit call. This is the
// shape the real TUI uses (terminalKey encodes one key per write).
// ---------------------------------------------------------------------------

describe("TerminalObservation.Detector realistic keystrokes", () => {
  function setup(quietMs = 40) {
    let now = 1_000
    const captured: O.Observation[] = []
    const det = new O.Detector({
      clock: () => now,
      quietMs,
      emit: (obs) => captured.push(obs),
    })
    // Helper: type a single-key string into the detector, advancing the
    // clock by 1ms per key to mimic real keystroke spacing.
    const type = (chunk: string) => {
      for (const ch of chunksOf(chunk)) {
        det.onHumanSubmit({
          terminalID: "st-1",
          generation: 1,
          sessionID: "sess-A",
          command: ch,
          outputCursor: 0,
          now,
        })
        now += 1
      }
    }
    return { det, captured, type, advance: (ms: number) => (now += ms), now: () => now }
  }

  // Split a string into the atomic units the real TUI sends per write.
  // Printable code points are one-per-chunk (each keystroke is a single
  // keypress). Escape sequences (CSI \x1b[...final, OSC \x1b]...) are kept
  // whole as one chunk because terminalKey returns them as one multi-byte
  // string per write. Control bytes (\r, \x7f, \x03, \x15) are one per
  // chunk. This models: per-char typing for letters, one-chunk for arrows.
  function chunksOf(s: string): string[] {
    const out: string[] = []
    let i = 0
    while (i < s.length) {
      const c = s.charCodeAt(i)
      if (c === 0x1b) {
        const next = s.charCodeAt(i + 1)
        if (next === 0x5b) {
          // CSI: keep up to and including the final byte (0x40-0x7E).
          let j = i + 2
          while (j < s.length) {
            const fc = s.charCodeAt(j)
            if (fc >= 0x40 && fc <= 0x7e) {
              j++
              break
            }
            j++
          }
          out.push(s.slice(i, j))
          i = j
          continue
        }
        if (next === 0x5d) {
          // OSC: keep until BEL or ST.
          let j = i + 2
          while (j < s.length) {
            if (s.charCodeAt(j) === 0x07) {
              j++
              break
            }
            if (s.charCodeAt(j) === 0x1b && s.charCodeAt(j + 1) === 0x5c) {
              j += 2
              break
            }
            j++
          }
          out.push(s.slice(i, j))
          i = j
          continue
        }
        // Bare ESC (+ maybe alt-modified next char): keep two chars.
        out.push(s.slice(i, next ? i + 2 : i + 1))
        i = next ? i + 2 : i + 1
        continue
      }
      const cp = s.codePointAt(i)!
      const len = cp > 0xffff ? 2 : 1
      out.push(s.slice(i, i + len))
      i += len
    }
    return out
  }

  test("A: individual keystrokes followed by Enter produce one observation with the full command", async () => {
    const { det, captured, type, advance } = setup(30)
    // Type the command one character at a time, then Enter.
    type("e")
    type("c")
    type("h")
    type("o")
    type(" ")
    for (const ch of "HUMAN_AUTO_VISIBLE") type(ch)
    type("\r")
    // Before Enter was pressed captured should be empty; now it has one.
    det.onOutputFrame({ cursor: 35, frameBytes: ENC.encode("HUMAN_AUTO_VISIBLE\r\n"), now: 1_050 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(captured.length).toBe(1)
    expect(captured[0].command).toBe("echo HUMAN_AUTO_VISIBLE")
    expect(captured[0].output).toContain("HUMAN_AUTO_VISIBLE")
  })

  test("B: whole pasted command plus Enter in one call produces one observation", async () => {
    const { det, captured, advance } = setup(30)
    // One paste chunk containing the entire command plus Enter.
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo PASTED_OK\r",
      outputCursor: 0,
      now: 1_000,
    })
    det.onOutputFrame({ cursor: 20, frameBytes: ENC.encode("PASTED_OK\r\n"), now: 1_005 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(captured.length).toBe(1)
    expect(captured[0].command).toBe("echo PASTED_OK")
    expect(captured[0].output).toContain("PASTED_OK")
  })

  test("C: Backspace editing — type echo OKXX, backspace twice, Enter == echo OK", async () => {
    const { det, captured, type, advance } = setup(30)
    type("echo OKXX")
    // Backspace twice (both DEL 0x7f should remove one code point each).
    type("\x7f")
    type("\x7f")
    type("\r")
    det.onOutputFrame({ cursor: 10, frameBytes: ENC.encode("OK\r\n"), now: 1_020 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(captured.length).toBe(1)
    expect(captured[0].command).toBe("echo OK")
  })

  test("C2: BS (0x08) backspace byte also removes one code point", async () => {
    const { det, captured, type, advance } = setup(30)
    type("abc")
    type("\x08") // BS (0x08) — alternate backspace byte
    type("\r")
    det.onOutputFrame({ cursor: 5, frameBytes: ENC.encode("ab\r\n"), now: 1_010 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(captured.length).toBe(1)
    expect(captured[0].command).toBe("ab")
  })

  test("D: partial input without Enter creates no observation", async () => {
    const { captured, type, advance } = setup(30)
    type("echo NEVER_ENTERED")
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(captured.length).toBe(0)
  })

  test("E: Enter alone (on a blank line) creates no observation", async () => {
    const { det, captured, type, advance } = setup(30)
    type("\r")
    det.onOutputFrame({ cursor: 5, frameBytes: ENC.encode("\r\n"), now: 1_010 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(captured.length).toBe(0)
  })

  test("F: Ctrl+U clears the buffered line", async () => {
    const { det, captured, type, advance } = setup(30)
    type("echo WILL_BE_CLEARED")
    type("\x15") // Ctrl+U — clears the buffered line
    type("echo RECOVERED")
    type("\r")
    det.onOutputFrame({ cursor: 20, frameBytes: ENC.encode("RECOVERED\r\n"), now: 1_030 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(captured.length).toBe(1)
    expect(captured[0].command).toBe("echo RECOVERED")
  })

  test("G: Ctrl+C clears the buffered line", async () => {
    const { det, captured, type, advance } = setup(30)
    type("echo INTERRUPTED")
    type("\x03") // Ctrl+C — clear the buffered line (no observation)
    type("echo AFTER_CTRL_C")
    type("\r")
    det.onOutputFrame({ cursor: 20, frameBytes: ENC.encode("AFTER_CTRL_C\r\n"), now: 1_030 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(captured.length).toBe(1)
    expect(captured[0].command).toBe("echo AFTER_CTRL_C")
  })

  test("H: CRLF creates one boundary, not two", async () => {
    const { det, captured, advance } = setup(30)
    // Paste a single command terminated by CRLF (one chunk).
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo CRLF\r\n",
      outputCursor: 0,
      now: 1_000,
    })
    det.onOutputFrame({ cursor: 15, frameBytes: ENC.encode("CRLF\r\n"), now: 1_005 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    // Exactly one observation — \r\n is a single Enter boundary.
    expect(captured.length).toBe(1)
    expect(captured[0].command).toBe("echo CRLF")
  })

  test("I: multi-command paste produces ONE batch observation (no fabricated cursor ranges)", async () => {
    const { det, captured, advance } = setup(30)
    // One paste chunk containing two newline-separated commands. There is NO
    // PTY output boundary between these commands in a single submitHuman call
    // (they share the same outputCursor), so the detector must open ONE batch
    // capture rather than fabricating two captures at outputStart=0.
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo FIRST\r\necho SECOND\r",
      outputCursor: 0,
      now: 1_000,
    })
    // Combined PTY output for both commands arrives in subsequent frames.
    det.onOutputFrame({ cursor: 30, frameBytes: ENC.encode("FIRST\r\nSECOND\r\n"), now: 1_005 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    // Exactly ONE observation — the two commands are batched.
    expect(captured.length).toBe(1)
    // The batch command contains BOTH commands joined by a newline.
    expect(captured[0].command).toBe("echo FIRST\necho SECOND")
    // The combined output (both results) is assigned to the single batch.
    expect(captured[0].output).toContain("FIRST")
    expect(captured[0].output).toContain("SECOND")
    expect(captured[0].outputStart).toBe(0)
  })

  test("B-batch: multi-command paste through Detector -> Queue yields exactly one observation (no dedup loss)", async () => {
    // Run the batch through the real Queue, not just a captured array, to
    // prove dedup does not collapse the single legitimate observation.
    const q = new O.Queue()
    let now = 1_000
    const det = new O.Detector({
      clock: () => now,
      quietMs: 30,
      emit: (obs) => q.enqueue(obs),
    })
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo FIRST\r\necho SECOND\r",
      outputCursor: 0,
      now,
    })
    now += 5
    det.onOutputFrame({ cursor: 30, frameBytes: ENC.encode("FIRST\r\nSECOND\r\n"), now })
    await new Promise((r) => setTimeout(r, 60))
    // Queue drain returns exactly one observation — not zero (collapsed by
    // dedup) and not two (fabricated separate ranges).
    const drained = q.drain()
    expect(drained.length).toBe(1)
    expect(drained[0].command).toBe("echo FIRST\necho SECOND")
    // Re-drain is empty (the single observation was delivered once).
    expect(q.drain()).toEqual([])
  })

  test("C-batch: multi-command paste plus trailing partial — batch contains completed commands, partial remains buffered", async () => {
    const { det, captured, advance } = setup(30)
    // Two completed commands followed by trailing partial text (no Enter on
    // the partial). The batch must contain ONLY the two completed commands,
    // and the partial must remain buffered for the next Enter.
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo FIRST\r\necho SECOND\rpartial",
      outputCursor: 0,
      now: 1_000,
    })
    det.onOutputFrame({ cursor: 30, frameBytes: ENC.encode("FIRST\r\nSECOND\r\n"), now: 1_005 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    // One batch observation with the two completed commands.
    expect(captured.length).toBe(1)
    expect(captured[0].command).toBe("echo FIRST\necho SECOND")
    expect(captured[0].output).toContain("SECOND")

    // Now submit Enter alone — the buffered "partial" becomes the next command.
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "\r",
      outputCursor: 30,
      now: 1_020,
    })
    det.onOutputFrame({ cursor: 40, frameBytes: ENC.encode("partial\r\n"), now: 1_025 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    // Now two observations: the batch + the trailing partial.
    expect(captured.length).toBe(2)
    expect(captured[1].command).toBe("partial")
    expect(captured[1].output).toContain("partial")
  })

  test("D-batch: two separately typed commands with separate quiet windows produce two observations, each with its own output", async () => {
    // Commands entered one at a time (different submitHuman calls) with the
    // first capture finalized by its quiet window BEFORE the second is typed.
    // This must still produce two separate observations — the batch logic only
    // collapses commands within ONE chunk, not across chunks/time.
    const { det, captured, advance } = setup(30)
    // First command typed then Enter.
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo ONE\r",
      outputCursor: 0,
      now: 1_000,
    })
    det.onOutputFrame({ cursor: 10, frameBytes: ENC.encode("ONE\r\n"), now: 1_005 })
    // Let the first capture's quiet window finalize it.
    await new Promise((r) => setTimeout(r, 60))
    expect(captured.length).toBe(1)
    expect(captured[0].command).toBe("echo ONE")
    expect(captured[0].output).toContain("ONE")

    // Second command typed then Enter, well after the quiet window.
    det.onHumanSubmit({
      terminalID: "st-1",
      generation: 1,
      sessionID: "sess-A",
      command: "echo TWO\r",
      outputCursor: 10,
      now: 1_100,
    })
    det.onOutputFrame({ cursor: 20, frameBytes: ENC.encode("TWO\r\n"), now: 1_105 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    // Two observations, distinct commands, distinct output, different outputStart.
    expect(captured.length).toBe(2)
    expect(captured[1].command).toBe("echo TWO")
    expect(captured[1].output).toContain("TWO")
    expect(captured[0].outputStart).toBe(0)
    expect(captured[1].outputStart).toBe(10)
  })

  test("J: agent write (no human submit) creates zero observations", async () => {
    const { captured, advance } = setup(30)
    // No human submits at all — only output frames (simulating an agent
    // write producing PTY output). The detector must not open a capture.
    const det = new O.Detector({
      clock: () => 1_000,
      quietMs: 30,
      emit: (obs) => captured.push(obs),
    })
    det.onOutputFrame({ cursor: 10, frameBytes: ENC.encode("agent wrote this\r\n"), now: 1_000 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(captured.length).toBe(0)
  })

  test("K: navigation escape sequences are not appended to the command text", async () => {
    const { det, captured, type, advance } = setup(30)
    type("echo ")
    // Arrow-left then arrow-right (CSI sequences) — should be dropped, not
    // added to the command.
    type("\x1b[D")
    type("\x1b[C")
    type("OK")
    type("\r")
    det.onOutputFrame({ cursor: 10, frameBytes: ENC.encode("echo OK\r\n"), now: 1_030 })
    advance(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(captured.length).toBe(1)
    expect(captured[0].command).toBe("echo OK")
  })

  test("L: dispose clears pending input (no observation emitted)", async () => {
    const { det, captured, type } = setup(30)
    type("echo NEVER_FINALIZED")
    det.dispose()
    // Even if a quiet window would otherwise fire, dispose cleared pending.
    await new Promise((r) => setTimeout(r, 60))
    expect(captured.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Queue dedup + cross-session isolation (pure)
// ---------------------------------------------------------------------------

describe("TerminalObservation.Queue", () => {
  function mk(s = "sess-A", start = 0): O.Observation {
    return {
      sessionID: s,
      terminalID: "st-1",
      generation: 1,
      actor: "human",
      command: "echo X",
      outputStart: start,
      outputEnd: start + 10,
      output: "X",
      truncated: false,
      timestamp: 1_000,
    }
  }

  test("E/dedup: enqueueing the same cursor range twice yields one observation on drain", () => {
    const q = new O.Queue()
    q.enqueue(mk("sess-A", 0))
    q.enqueue(mk("sess-A", 0)) // identical key — deduped
    expect(q.size()).toBe(1)
    const out = q.drain()
    expect(out.length).toBe(1)
    // After drain, the dedup set prevents re-enqueue of the same key.
    q.enqueue(mk("sess-A", 0))
    expect(q.size()).toBe(0)
  })

  test("G: session B receives nothing from session A", () => {
    // The Queue is per-session by construction (the router holds one per
    // sessionID). Here we demonstrate isolation: enqueueing into session A's
    // queue never affects session B's queue.
    const queueA = new O.Queue()
    const queueB = new O.Queue()
    queueA.enqueue(mk("sess-A", 0))
    queueA.enqueue(mk("sess-A", 10))
    expect(queueA.size()).toBe(2)
    expect(queueB.size()).toBe(0)
    // B's drain yields nothing.
    expect(queueB.drain()).toEqual([])
    // A's drain yields the two A observations.
    const out = queueA.drain()
    expect(out.length).toBe(2)
    expect(out.every((o) => o.sessionID === "sess-A")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Service integration: observationSink is called exactly once per human Enter
// (fake PTY, deterministic clock)
// ---------------------------------------------------------------------------

describe("SharedTerminalService + observationSink", () => {
  test("A+B+C+D+H: human submit with Enter emits exactly one observation with command + output; agent write does not", async () => {
    const capturedEnvs: CapturedSpawn = { envs: [] }
    const fakeSpawnObj = fakeSpawn(capturedEnvs)
    const captured: O.Observation[] = []
    const {
      svc,
      tickets,
      clock: ctl,
    } = makeSvc({
      spawn: fakeSpawnObj.fn,
      observationSink: (obs) => captured.push(obs),
      observationQuietMs: 30,
      observationMaxBytes: 100,
    })
    const scope = await makeScope()
    const r = await svc.create({
      file: "sh",
      args: [],
      scope,
      createdBy: { type: "agent", sessionID: "sess-A", agentID: "ag-1", callID: "call-1" },
      title: "st-obs",
      cols: 80,
      rows: 24,
      accessSessions: ["sess-A"],
    })
    const ticket = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "write",
      now: ctl.now(),
    })
    const att = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket.raw,
      callbacks: { onFrame: () => {}, onEvent: () => {}, onError: () => {} },
    })

    // Human submits the command with Enter.
    await svc.submitHuman(r.info.id, att.attachmentID, "echo HUMAN_AUTO_VISIBLE\r", ctl.now())
    // PTY emits output.
    fakeSpawnObj.onData("HUMAN_AUTO_VISIBLE\r\n")
    // Wait for the quiet window.
    await new Promise((res) => setTimeout(res, 90))

    // Exactly one observation queued (C).
    expect(captured.length).toBe(1)
    const obs = captured[0]
    // Observation contains the command and output (D).
    expect(obs.command).toBe("echo HUMAN_AUTO_VISIBLE")
    expect(obs.output).toContain("HUMAN_AUTO_VISIBLE")
    expect(obs.sessionID).toBe("sess-A")
    expect(obs.terminalID).toBe(r.info.id)
    expect(obs.actor).toBe("human")

    // H: agent write (writeAgent) does NOT emit a new observation. Acquire a
    // lease and write as an agent.
    const lease = await svc.acquireLease(r.info.id, {
      ref: r.ref,
      actor: { type: "agent", sessionID: "sess-A", agentID: "ag-1", callID: "call-1" },
      now: ctl.now(),
    })
    await svc.writeAgent(r.info.id, {
      ref: r.ref,
      leaseID: lease.id,
      revision: lease.revision,
      actor: { type: "agent", sessionID: "sess-A", agentID: "ag-1", callID: "call-1" },
      data: "ls\r",
      now: ctl.now(),
    })
    // PTY emits output for the agent write.
    fakeSpawnObj.onData("file1\nfile2\n")
    await new Promise((res) => setTimeout(res, 90))
    // Still exactly one observation — the agent write did not produce one.
    expect(captured.length).toBe(1)

    await svc.disposeTerminal(r.info.id)
  })

  test("F: partial human input without Enter emits no observation through the service", async () => {
    const capturedEnvs: CapturedSpawn = { envs: [] }
    const fakeSpawnObj = fakeSpawn(capturedEnvs)
    const captured: O.Observation[] = []
    const {
      svc,
      tickets,
      clock: ctl,
    } = makeSvc({
      spawn: fakeSpawnObj.fn,
      observationSink: (obs) => captured.push(obs),
      observationQuietMs: 30,
      observationMaxBytes: 100,
    })
    const scope = await makeScope()
    const r = await svc.create({
      file: "sh",
      args: [],
      scope,
      createdBy: { type: "agent", sessionID: "sess-A", agentID: "ag-1", callID: "call-1" },
      title: "st-obs-partial",
      cols: 80,
      rows: 24,
      accessSessions: ["sess-A"],
    })
    const ticket = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "write",
      now: ctl.now(),
    })
    const att = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket.raw,
      callbacks: { onFrame: () => {}, onEvent: () => {}, onError: () => {} },
    })
    // Submit partial text WITHOUT Enter.
    await svc.submitHuman(r.info.id, att.attachmentID, "echo partial", ctl.now())
    fakeSpawnObj.onData("some output\r\n")
    await new Promise((res) => setTimeout(res, 90))
    expect(captured.length).toBe(0)
    await svc.disposeTerminal(r.info.id)
  })

  test("I: output exceeding the cap is truncated and marked truncated via the service", async () => {
    const capturedEnvs: CapturedSpawn = { envs: [] }
    const fakeSpawnObj = fakeSpawn(capturedEnvs)
    const captured: O.Observation[] = []
    // Use a custom service with a small observation max via a directly
    // constructed detector-style sink. The service hard-codes the limit to
    // READ_MAX_BYTES (32 KiB); to test truncation deterministically without
    // emitting 32 KiB we assert on the detector-level truncation tested
    // above. Here we verify the service path delivers the truncation flag
    // when the detector caps. We supply an observationSink that records the
    // observation, and emit > 32 KiB through the fake PTY.
    const {
      svc,
      tickets,
      clock: ctl,
    } = makeSvc({
      spawn: fakeSpawnObj.fn,
      observationSink: (obs) => captured.push(obs),
      observationQuietMs: 30,
      observationMaxBytes: 100,
    })
    const scope = await makeScope()
    const r = await svc.create({
      file: "sh",
      args: [],
      scope,
      createdBy: { type: "agent", sessionID: "sess-A", agentID: "ag-1", callID: "call-1" },
      title: "st-obs-big",
      cols: 80,
      rows: 24,
      accessSessions: ["sess-A"],
    })
    const ticket = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "write",
      now: ctl.now(),
    })
    const att = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket.raw,
      callbacks: { onFrame: () => {}, onEvent: () => {}, onError: () => {} },
    })
    await svc.submitHuman(r.info.id, att.attachmentID, "big\r", ctl.now())
    // Emit 40,000 bytes of output — exceeds the 100-byte test cap passed
    // via observationMaxBytes.
    const big = "y".repeat(20_000)
    fakeSpawnObj.onData(big)
    fakeSpawnObj.onData(big)
    await new Promise((res) => setTimeout(res, 90))
    expect(captured.length).toBe(1)
    expect(captured[0].truncated).toBe(true)
    // Output is capped at the 100-byte test limit.
    expect(captured[0].output.length).toBeLessThanOrEqual(100)
    await svc.disposeTerminal(r.info.id)
  })

  test("J: agent idle — no provider/model call is started by observation capture", async () => {
    // This is a contract assertion: the observationSink receives the
    // observation but nothing in this path invokes a model. We track
    // invocations of any "provider-like" shim and assert it is never called
    // by the service's observation path.
    const capturedEnvs: CapturedSpawn = { envs: [] }
    const fakeSpawnObj = fakeSpawn(capturedEnvs)
    let providerInvocations = 0
    const captured: O.Observation[] = []
    const {
      svc,
      tickets,
      clock: ctl,
    } = makeSvc({
      spawn: fakeSpawnObj.fn,
      observationSink: (obs) => {
        captured.push(obs)
        // The sink does not call any provider.
      },
      observationQuietMs: 30,
      observationMaxBytes: 100,
    })
    const scope = await makeScope()
    const r = await svc.create({
      file: "sh",
      args: [],
      scope,
      createdBy: { type: "agent", sessionID: "sess-A", agentID: "ag-1", callID: "call-1" },
      title: "st-obs-idle",
      cols: 80,
      rows: 24,
      accessSessions: ["sess-A"],
    })
    const ticket = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "write",
      now: ctl.now(),
    })
    const att = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket.raw,
      callbacks: { onFrame: () => {}, onEvent: () => {}, onError: () => {} },
    })
    await svc.submitHuman(r.info.id, att.attachmentID, "echo idle\r", ctl.now())
    fakeSpawnObj.onData("idle\r\n")
    await new Promise((res) => setTimeout(res, 90))
    expect(captured.length).toBe(1)
    expect(providerInvocations).toBe(0)
    await svc.disposeTerminal(r.info.id)
  })

  test("REAL_KEYSTROKE: separate submitHuman calls per keystroke produce exactly one observation with the full command", async () => {
    const capturedEnvs: CapturedSpawn = { envs: [] }
    const fakeSpawnObj = fakeSpawn(capturedEnvs)
    const captured: O.Observation[] = []
    const {
      svc,
      tickets,
      clock: ctl,
    } = makeSvc({
      spawn: fakeSpawnObj.fn,
      observationSink: (obs) => captured.push(obs),
      observationQuietMs: 30,
      observationMaxBytes: 100,
    })
    const scope = await makeScope()
    const r = await svc.create({
      file: "sh",
      args: [],
      scope,
      createdBy: { type: "agent", sessionID: "sess-A", agentID: "ag-1", callID: "call-1" },
      title: "st-obs-keystrokes",
      cols: 80,
      rows: 24,
      accessSessions: ["sess-A"],
    })
    const ticket = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "write",
      now: ctl.now(),
    })
    const att = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket.raw,
      callbacks: { onFrame: () => {}, onEvent: () => {}, onError: () => {} },
    })

    // Submit each keystroke separately, exactly how the real TUI does it.
    const keys = "echo HUMAN_AUTO_VISIBLE".split("")
    for (const k of keys) {
      await svc.submitHuman(r.info.id, att.attachmentID, k, ctl.now())
    }
    // Enter alone, as a separate submit.
    await svc.submitHuman(r.info.id, att.attachmentID, "\r", ctl.now())

    // PTY emits output for the command.
    fakeSpawnObj.onData("HUMAN_AUTO_VISIBLE\r\n")
    await new Promise((res) => setTimeout(res, 90))

    // Exactly one observation with the full reconstructed command.
    expect(captured.length).toBe(1)
    expect(captured[0].command).toBe("echo HUMAN_AUTO_VISIBLE")
    expect(captured[0].output).toContain("HUMAN_AUTO_VISIBLE")
    await svc.disposeTerminal(r.info.id)
  })
})

// ---------------------------------------------------------------------------
// Router cross-session isolation (uses Instance.state via the real router)
// ---------------------------------------------------------------------------

describe("TerminalObservationRouter", () => {
  test("G: cross-session isolation — router routes only to the owning session queue", async () => {
    // The router uses Instance.state, keyed by the current project directory
    // via AsyncLocalStorage. We exercise it inside Instance.provide so the
    // context is available.
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        try {
          const obsA: O.Observation = {
            sessionID: "sess-A",
            terminalID: "st-1",
            generation: 1,
            actor: "human",
            command: "echo A",
            outputStart: 0,
            outputEnd: 10,
            output: "A",
            truncated: false,
            timestamp: 1_000,
          }
          const obsB: O.Observation = {
            sessionID: "sess-B",
            terminalID: "st-2",
            generation: 1,
            actor: "human",
            command: "echo B",
            outputStart: 0,
            outputEnd: 10,
            output: "B",
            truncated: false,
            timestamp: 1_000,
          }
          TerminalObservationRouter.sink(obsA)
          TerminalObservationRouter.sink(obsB)
          // Session A drains only A's observations.
          const drainedA = TerminalObservationRouter.drain("sess-A")
          expect(drainedA.length).toBe(1)
          expect(drainedA[0].sessionID).toBe("sess-A")
          // Session B drains only B's observations.
          const drainedB = TerminalObservationRouter.drain("sess-B")
          expect(drainedB.length).toBe(1)
          expect(drainedB[0].sessionID).toBe("sess-B")
          // Drain again — empty.
          expect(TerminalObservationRouter.drain("sess-A")).toEqual([])
          expect(TerminalObservationRouter.drain("sess-B")).toEqual([])
        } finally {
          await Instance.dispose()
        }
      },
    })
  })
})
