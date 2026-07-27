import { test, expect, describe } from "bun:test"
import { Reap } from "../../src/kilocode/shared-terminal/reap"

// Generation-bound exact owned-process cleanup. The module must NEVER kill by
// image/executable name, never use taskkill /IM, never use Stop-Process by
// name, never use killall/pkill, never scan broadly for matching commands,
// never kill the current Kilo process, never kill an unrelated sibling, and
// never broaden the target after a cleanup failure.
//
// All numeric identities must be safe integers. Ownership is compared before
// any adapter is invoked; a mismatch returns ownership_mismatch and invokes no
// kill. Repeated cleanup after success is idempotent.

const isWin = process.platform === "win32"

function pid(): number {
  return process.pid
}

describe("Reap: ownership handle", () => {
  test("build creates an immutable ownership handle", () => {
    const h = Reap.build({
      terminalID: "t-001",
      generation: 1,
      rootPID: 12345,
      platform: "win32",
    })
    expect(h.terminalID).toBe("t-001")
    expect(h.generation).toBe(1)
    expect(h.rootPID).toBe(12345)
    expect(h.platform).toBe("win32")
  })

  test("rejects negative PID", () => {
    expect(() => Reap.build({ terminalID: "t-001", generation: 1, rootPID: -1, platform: "win32" })).toThrow()
  })

  test("rejects fractional PID", () => {
    expect(() => Reap.build({ terminalID: "t-001", generation: 1, rootPID: 1.5, platform: "win32" })).toThrow()
  })

  test("rejects NaN PID", () => {
    expect(() => Reap.build({ terminalID: "t-001", generation: 1, rootPID: Number.NaN, platform: "win32" })).toThrow()
  })

  test("rejects non-safe-integer PID", () => {
    expect(() =>
      Reap.build({
        terminalID: "t-001",
        generation: 1,
        rootPID: Number.MAX_SAFE_INTEGER + 1,
        platform: "win32",
      }),
    ).toThrow()
  })

  test("rejects negative generation", () => {
    expect(() => Reap.build({ terminalID: "t-001", generation: -1, rootPID: 1, platform: "win32" })).toThrow()
  })

  test("rejects empty terminalID", () => {
    expect(() => Reap.build({ terminalID: "", generation: 1, rootPID: 1, platform: "win32" })).toThrow()
  })
})

describe("Reap: ownership mismatch invokes no adapter", () => {
  test("wrong terminalID returns ownership_mismatch and invokes no adapter", async () => {
    let called = false
    const live = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 999, platform: "win32" })
    const expected = Reap.build({ terminalID: "t-other", generation: 1, rootPID: 999, platform: "win32" })
    const res = await Reap.reap({
      expected,
      live,
      adapter: async () => {
        called = true
        return { ok: true }
      },
    })
    expect(res.status).toBe("ownership_mismatch")
    expect(called).toBe(false)
  })

  test("wrong generation returns ownership_mismatch and invokes no adapter", async () => {
    let called = false
    const live = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 999, platform: "win32" })
    const expected = Reap.build({ terminalID: "t-001", generation: 2, rootPID: 999, platform: "win32" })
    const res = await Reap.reap({
      expected,
      live,
      adapter: async () => {
        called = true
        return { ok: true }
      },
    })
    expect(res.status).toBe("ownership_mismatch")
    expect(called).toBe(false)
  })

  test("wrong PID returns ownership_mismatch and invokes no adapter", async () => {
    let called = false
    const live = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 999, platform: "win32" })
    const expected = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 1000, platform: "win32" })
    const res = await Reap.reap({
      expected,
      live,
      adapter: async () => {
        called = true
        return { ok: true }
      },
    })
    expect(res.status).toBe("ownership_mismatch")
    expect(called).toBe(false)
  })

  test("wrong platform returns ownership_mismatch and invokes no adapter", async () => {
    let called = false
    const live = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 999, platform: "win32" })
    const expected = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 999, platform: "linux" })
    const res = await Reap.reap({
      expected,
      live,
      adapter: async () => {
        called = true
        return { ok: true }
      },
    })
    expect(res.status).toBe("ownership_mismatch")
    expect(called).toBe(false)
  })
})

describe("Reap: invalid/unsafe PID rejected", () => {
  test("PID 0 rejected", async () => {
    const live = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 999, platform: "win32" })
    const expected = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 0, platform: "win32" })
    const res = await Reap.reap({
      expected,
      live,
      adapter: async () => ({ ok: true }),
    })
    expect(res.status).toBe("unsupported")
  })

  test("PID 4 rejected (Windows System process)", async () => {
    const live = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 999, platform: "win32" })
    const expected = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 4, platform: "win32" })
    const res = await Reap.reap({
      expected,
      live,
      adapter: async () => ({ ok: true }),
    })
    expect(res.status).toBe("unsupported")
  })

  test("current process PID rejected", async () => {
    const live = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 999, platform: "win32" })
    const expected = Reap.build({
      terminalID: "t-001",
      generation: 1,
      rootPID: pid(),
      platform: "win32",
    })
    const res = await Reap.reap({
      expected,
      live,
      adapter: async () => ({ ok: true }),
    })
    expect(res.status).toBe("unsupported")
  })
})

describe("Reap: adapter results", () => {
  test("valid exact ownership cleanup returns cleaned", async () => {
    const h = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 12345, platform: "win32" })
    const res = await Reap.reap({
      expected: h,
      live: h,
      adapter: async () => ({ ok: true }),
    })
    expect(res.status).toBe("cleaned")
  })

  test("already-exited root returns already_exited without invoking adapter", async () => {
    let called = false
    const h = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 12345, platform: "win32" })
    const res = await Reap.reap({
      expected: h,
      live: h,
      exited: true,
      adapter: async () => {
        called = true
        return { ok: true }
      },
    })
    expect(res.status).toBe("already_exited")
    expect(called).toBe(false)
  })

  test("adapter failure returns cleanup_failed", async () => {
    const h = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 12345, platform: "win32" })
    const res = await Reap.reap({
      expected: h,
      live: h,
      adapter: async () => ({ ok: false, error: "boom" }),
    })
    expect(res.status).toBe("cleanup_failed")
  })

  test("failure does not broaden the target", async () => {
    const h = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 12345, platform: "win32" })
    let received: number | undefined
    const res = await Reap.reap({
      expected: h,
      live: h,
      adapter: async (target) => {
        received = target
        return { ok: false, error: "boom" }
      },
    })
    expect(res.status).toBe("cleanup_failed")
    expect(received).toBe(12345)
  })
})

describe("Reap: idempotency", () => {
  test("repeated cleanup after success is idempotent", async () => {
    let calls = 0
    const h = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 12345, platform: "win32" })
    const adapter = async () => {
      calls += 1
      return { ok: true }
    }
    const r1 = await Reap.reap({ expected: h, live: h, adapter })
    expect(r1.status).toBe("cleaned")
    // Second reap against the same handle: already cleaned, no second kill.
    const r2 = await Reap.reap({ expected: h, live: h, adapter, alreadyCleaned: true })
    expect(r2.status).toBe("cleaned")
    expect(calls).toBe(1)
  })
})

describe("Reap: Windows adapter argv", () => {
  test("argv contains exact PID and /T /F, no /IM or executable name", () => {
    const argv = Reap.windowsArgv(4242)
    expect(argv[0]).toBe("taskkill")
    expect(argv).toContain("/PID")
    expect(argv).toContain("4242")
    expect(argv).toContain("/T")
    expect(argv).toContain("/F")
    expect(argv.some((a) => a === "/IM")).toBe(false)
    expect(argv.some((a) => a.includes(".exe"))).toBe(false)
    // No executable/image name present.
    expect(argv.some((a) => a.toLowerCase() === "cmd" || a.toLowerCase() === "powershell")).toBe(false)
  })

  test("platform result reported explicitly", async () => {
    const h = Reap.build({ terminalID: "t-001", generation: 1, rootPID: 12345, platform: "win32" })
    const res = await Reap.reap({
      expected: h,
      live: h,
      adapter: async () => ({ ok: true }),
    })
    expect(res.platform).toBe("win32")
  })
})

// Actual Windows process probe: safely create an owned root test process, one
// descendant of that root, and one unrelated sibling. Record all three PIDs.
// Invoke cleanup for the exact owned root and prove the owned tree exits while
// the unrelated sibling survives. Cleanup every remaining test process in
// finally using only its exact PID.
describe.skipIf(!isWin)("Reap: Windows owned-tree probe", () => {
  test("owned root and descendant terminate; unrelated sibling survives", async () => {
    const { spawn } = await import("child_process")
    const procs: { pid: number | null; kill: () => void }[] = []

    function reapExact(p: number | null) {
      if (!p || p <= 0) return
      try {
        spawn("taskkill", ["/PID", String(p), "/T", "/F"], { windowsHide: true })
      } catch {
        // best-effort cleanup in finally
      }
    }

    try {
      // Owned root: a cmd.exe that runs a long ping as a foreground CHILD
      // (not `start /b`, which detaches). ping's parent is root.pid, so
      // taskkill /T /F on the root reaches it. cmd.exe stays alive as the
      // root for the full ping duration.
      const root = spawn("cmd.exe", ["/c", "ping -n 60 127.0.0.1 > nul"], {
        windowsHide: true,
        detached: false,
      })
      if (!root.pid) throw new Error("root spawn failed")
      procs.push({ pid: root.pid, kill: () => root.kill() })

      // Unrelated sibling: a long ping spawned directly (NOT under the owned
      // root). timeout.exe detaches from its cmd parent, so ping is used to
      // keep the sibling a stable, independently-rooted process.
      const sibling = spawn("ping", ["-n", "60", "127.0.0.1"], { windowsHide: true, detached: false })
      if (!sibling.pid) throw new Error("sibling spawn failed")
      procs.push({ pid: sibling.pid, kill: () => sibling.kill() })

      // Give processes a moment to initialize and the descendant to spawn.
      await new Promise((r) => setTimeout(r, 700))

      const ownedRootPID = root.pid
      const unrelatedSiblingPID = sibling.pid

      // Discover the descendant PID spawned by the root via tasklist filtering
      // on the root PID as parent. We only ever target the exact root PID for
      // cleanup; the descendant is proven to exit as a consequence.
      const descRes = await new Promise<string>((resolve) => {
        const child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq " +
              ownedRootPID +
              " } | Select-Object -ExpandProperty ProcessId",
          ],
          { windowsHide: true },
        )
        let out = ""
        child.stdout?.on("data", (d: Buffer) => (out += d.toString()))
        child.on("exit", () => resolve(out.trim()))
        child.on("error", () => resolve(""))
      })
      const ownedDescendantPID = parseInt(descRes.split(/\r?\n/).filter(Boolean)[0] ?? "0", 10)

      // Build ownership for the owned root generation.
      const handle = Reap.build({
        terminalID: "t-probe",
        generation: 1,
        rootPID: ownedRootPID,
        platform: "win32",
      })

      const res = await Reap.reap({
        expected: handle,
        live: handle,
        adapter: async (target) => {
          // Use discrete argv only — never a composed shell command.
          const argv = Reap.windowsArgv(target)
          const child = spawn(argv[0], argv.slice(1), { windowsHide: true })
          await new Promise<void>((resolve) => {
            child.on("exit", () => resolve())
            child.on("error", () => resolve())
          })
          return { ok: true }
        },
      })

      expect(res.status).toBe("cleaned")
      expect(res.platform).toBe("win32")

      // Allow taskkill to propagate.
      await new Promise((r) => setTimeout(r, 900))

      const ownedRootAlive = await Reap.alive(ownedRootPID)
      const ownedDescendantAlive = await Reap.alive(ownedDescendantPID)
      const siblingAlive = await Reap.alive(unrelatedSiblingPID)

      expect(ownedRootAlive).toBe(false)
      expect(ownedDescendantAlive).toBe(false)
      expect(siblingAlive).toBe(true)

      // Record evidence PIDs (redacted in evidence report, not here).
      expect(ownedRootPID).toBeGreaterThan(0)
      expect(ownedDescendantPID).toBeGreaterThan(0)
      expect(unrelatedSiblingPID).toBeGreaterThan(0)
    } finally {
      for (const p of procs) reapExact(p.pid)
      await new Promise((r) => setTimeout(r, 300))
    }
  }, 30_000)
})
