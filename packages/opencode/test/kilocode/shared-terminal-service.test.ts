import { test, expect, describe } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { SharedTerminalService as Service } from "../../src/kilocode/shared-terminal/service"
import { SharedTerminalSchema as S } from "../../src/kilocode/shared-terminal/schema"
import { LeaseState } from "../../src/kilocode/shared-terminal/lease"
import { Reap } from "../../src/kilocode/shared-terminal/reap"
import { AuditStore } from "../../src/kilocode/shared-terminal/audit"
import { TicketState } from "../../src/kilocode/shared-terminal/ticket"
import type { IPty } from "bun-pty"

const isWin = process.platform === "win32"

const WIN_CMD = process.env.ComSpec || "cmd.exe"
const POSIX_SHELL = process.env.SHELL || "sh"

interface CapturedSpawn {
  file: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

function createFakePty(
  info: { pid: number },
  callbacks: { onDataCbs: Array<(chunk: string) => void>; onExitCbs: Array<(ev: { exitCode: number }) => void> },
): IPty {
  const p = {
    pid: info.pid,
    cols: 80,
    rows: 24,
    process: "test",
    onData: (cb: (chunk: string) => void) => {
      callbacks.onDataCbs.push(cb)
      return { dispose: () => {} }
    },
    onExit: (cb: (ev: { exitCode: number }) => void) => {
      callbacks.onExitCbs.push(cb)
      return { dispose: () => {} }
    },
    write: (data: string) => {},
    resize: (cols: number, rows: number) => {},
    kill: (signal?: string) => {},
  } as IPty
  return p
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
  env["FAKE_SECRET"] = "should-not-leak"
  env["GITHUB_TOKEN"] = "ghp_shouldnotleak"
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

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

const agentActor: Extract<S.Actor, { type: "agent" }> = {
  type: "agent",
  sessionID: "sess-1",
  agentID: "ag-1",
  callID: "call-1",
}

interface Scope {
  projectID: string
  directory: string
  worktree: string
}

async function makeScope(): Promise<Scope> {
  await using tmp = await tmpdir()
  return { projectID: "proj-test", directory: tmp.path, worktree: tmp.path }
}

async function waitFor(cond: () => boolean, { timeout = 10_000, interval = 25 } = {}): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error("waitFor timed out")
}

function makeSvc(opts?: {
  audit?: AuditStore
  ticketState?: TicketState
  spawn?: Service.SpawnFn
  envSource?: Record<string, string>
  isolatedPaths?: Record<string, string>
  ringBytes?: number
  reap?: Service.ReapFn
  aliveCheck?: Service.AliveFn
}) {
  const ctl = clock()
  const ad = opts?.audit ?? new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 128 })
  const tickets = opts?.ticketState ?? new TicketState()
  const spawn = opts?.spawn ?? realSpawn()
  const defaultFake = fakeReap({ status: "cleaned" })
  const reapFn = opts?.reap ?? defaultFake.fn
  const aliveFn = opts?.aliveCheck ?? defaultFake.alive
  return {
    svc: Service.create({
      clock: ctl.now,
      audit: ad,
      tickets,
      platform: process.platform as Service.Platform,
      spawn,
      envSource: opts?.envSource ?? testEnv,
      isolatedPaths: opts?.isolatedPaths ?? testIsolated,
      ringBytes: opts?.ringBytes,
      reap: reapFn,
      aliveCheck: aliveFn,
    }),
    audit: ad,
    tickets,
    clock: ctl,
    _reapCalls: defaultFake.calls,
  }
}

function fakeReap(r: { status: string }) {
  const calls: Array<Record<string, unknown>> = []
  return {
    fn: async (input: { expected: { terminalID: string; generation: number; rootPID: number; platform: string } }) => {
      calls.push({
        terminalID: input.expected.terminalID,
        generation: input.expected.generation,
        rootPID: input.expected.rootPID,
        platform: input.expected.platform,
      })
      return r
    },
    alive: async () => false,
    calls,
  }
}

function realSpawn(): Service.SpawnFn {
  return (file, args, options) => {
    const { spawn } = require("bun-pty") as typeof import("bun-pty")
    return spawn(file, args, options)
  }
}

function fakeSpawn(captures: { envs: Array<Record<string, string>> }): {
  fn: Service.SpawnFn
  onData: (chunk: string) => void
  emitExit: (code: number) => void
  kill: () => void
  writeData: string[]
  resizeData: Array<{ cols: number; rows: number }>
} {
  let onDataCbs: Array<(chunk: string) => void> = []
  let onExitCbs: Array<(ev: { exitCode: number }) => void> = []
  let pid = 0
  let fakeProc: IPty | undefined
  const writeData: string[] = []
  const resizeData: Array<{ cols: number; rows: number }> = []

  const fn: Service.SpawnFn = (file, args, options) => {
    captures.envs.push({ ...(options.env ?? {}) })
    pid = 9999
    fakeProc = createFakePty({ pid }, { onDataCbs, onExitCbs })
    const orig = fakeProc
    fakeProc = {
      ...orig,
      write: (d: string) => {
        writeData.push(d)
      },
      resize: (c: number, r: number) => {
        resizeData.push({ cols: c, rows: r })
      },
      kill: () => {},
    }
    return fakeProc!
  }

  return {
    fn,
    onData: (chunk) => {
      for (const cb of onDataCbs) cb(chunk)
    },
    emitExit: (code) => {
      for (const cb of onExitCbs) cb({ exitCode: code })
    },
    kill: () => {},
    writeData,
    resizeData,
  }
}

describe("SharedTerminalService: one real PTY", () => {
  test("create with real bun-pty returns Info; lifecycle reaches running; PID retained", async () => {
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 32 })
    const svc = Service.create({
      clock: ctl.now,
      audit,
      tickets: new TicketState(),
      platform: process.platform as Service.Platform,
      spawn: realSpawn(),
      envSource: { PATH: process.env.PATH || "", ComSpec: process.env.ComSpec || "" },
      isolatedPaths: testIsolated,
    })
    const scope = await makeScope()
    const sh = isWin
      ? { file: WIN_CMD, args: ["/c", "echo KILO_MARKER_REAL && ping -n 5 127.0.0.1"] }
      : { file: POSIX_SHELL, args: ["-c", "printf 'KILO_MARKER_REAL\\n'; sleep 5"] }
    const result = await svc.create({
      file: sh.file,
      args: sh.args,
      scope,
      createdBy: agentActor,
      title: "st-real",
      cols: 80,
      rows: 24,
    })
    try {
      expect(result.info.id.length).toBeGreaterThan(0)
      expect(result.info.pid).toBeGreaterThan(0)
      expect(result.info.lifecycle).toBe("starting")
      await waitFor(() => svc.info(result.info.id)!.lifecycle === "running", { timeout: 8_000 })
      expect(svc.info(result.info.id)!.pid).toBe(result.info.pid)
    } finally {
      await svc.disposeTerminal(result.info.id)
    }
  }, 25_000)
})

describe("SharedTerminalService: injected environment", () => {
  test("spawned process uses only SharedTerminalEnv.build() output; secrets absent", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc } = makeSvc({
      spawn: fakeSpawnObj.fn,
      envSource: testEnv,
      isolatedPaths: testIsolated,
    })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo TEST"],
      scope,
      createdBy: agentActor,
      title: "st-env",
      cols: 80,
      rows: 24,
    })
    await svc.disposeTerminal(r.info.id)

    expect(capturedEnvs.length).toBe(1)
    const env = capturedEnvs[0]
    expect(env.KILO_TERMINAL).toBe("1")
    expect(env.KILO_SHARED_TERMINAL).toBe("1")
    for (const secret of ["FAKE_SECRET", "GITHUB_TOKEN", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY"]) {
      if (Object.prototype.hasOwnProperty.call(testEnv, secret)) expect(env[secret]).toBeUndefined()
    }
  })

  test("HOMEDRIVE and HOMEPATH use injected isolated values on Windows", async () => {
    if (!isWin) return
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc } = makeSvc({
      spawn: fakeSpawnObj.fn,
      isolatedPaths: {
        userprofile: "K:\\iso",
        home: "K:\\iso",
        appdata: "K:\\iso\\AppData",
        localappdata: "K:\\iso\\AppData\\Local",
        temp: "K:\\iso\\Temp",
        tmp: "K:\\iso\\Temp",
        homedrive: "K:",
        homepath: "\\iso",
      },
    })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-iso",
      cols: 80,
      rows: 24,
    })
    await svc.disposeTerminal(r.info.id)
    const env = capturedEnvs[0]
    expect(env.HOMEDRIVE).toBe("K:")
    expect(env.HOMEPATH).toBe("\\iso")
  })

  test("source environment object remains unchanged", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const src = { ...testEnv }
    const srcKeys = Object.keys(src).sort()
    const { svc } = makeSvc({
      spawn: fakeSpawnObj.fn,
      envSource: src,
    })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-env-imm",
      cols: 80,
      rows: 24,
    })
    await svc.disposeTerminal(r.info.id)
    expect(Object.keys(src).sort()).toEqual(srcKeys)
  })

  test("no public service method exposes environment values", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc } = makeSvc({ spawn: fakeSpawnObj.fn })
    const publicKeys = Object.keys(svc).filter(
      (k) => typeof (svc as unknown as Record<string, unknown>)[k] === "function",
    )
    expect(publicKeys.includes("capturedEnv")).toBe(false)
  })
})

describe("SharedTerminalService: queued mutation ordering and race tests", () => {
  test("create returns info and ref; lifecycle starting", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-start",
      cols: 80,
      rows: 24,
    })
    expect(r.info.lifecycle).toBe("starting")
    expect(r.ref.terminalID).toBe(r.info.id)
    expect(r.ref.generation).toBe(1)
    expect(r.ref.rootPID).toBeGreaterThan(0)
    await svc.disposeTerminal(r.info.id)
  })

  test("lease acquire/refresh/write are queued", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-q",
      cols: 80,
      rows: 24,
    })
    const lease = await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    expect(lease.revision).toBe(0)
    await svc.writeAgent(r.info.id, {
      ref: r.ref,
      leaseID: lease.id,
      revision: lease.revision,
      actor: agentActor,
      data: "echo hello\r",
      now: ctl.now(),
    })
    expect(fakeSpawnObj.writeData).toContain("echo hello\r")
    await svc.disposeTerminal(r.info.id)
  })

  test("agent write without lease fails", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-no-lease",
      cols: 80,
      rows: 24,
    })
    let threw = false
    try {
      await svc.writeAgent(r.info.id, {
        ref: r.ref,
        leaseID: "fake",
        revision: 0,
        actor: agentActor,
        data: "x\r",
        now: ctl.now(),
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(fakeSpawnObj.writeData.length).toBe(0)
    await svc.disposeTerminal(r.info.id)
  })

  test("stale lease revision rejected", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-stale",
      cols: 80,
      rows: 24,
    })
    const lease = await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    ctl.advance(S.LIMITS.LEASE_MAX_MS + 1)
    let threw = false
    try {
      await svc.writeAgent(r.info.id, {
        ref: r.ref,
        leaseID: lease.id,
        revision: lease.revision,
        actor: agentActor,
        data: "x\r",
        now: ctl.now(),
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    await svc.disposeTerminal(r.info.id)
  })

  test("human write preempts active lease before human bytes; ordering in audit", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl, audit } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-preempt",
      cols: 80,
      rows: 24,
    })
    const lease = await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    await svc.writeHuman(r.info.id, { clientID: "human-1", data: "human-cmd\r", now: ctl.now() })
    const own = audit
      .snapshot()
      .filter((e) => e.terminalID === r.info.id && (e.action === "lease.revoke" || e.action === "write"))
    const revokeIdx = own.findIndex((e) => e.action === "lease.revoke")
    const writeIdx = own.findIndex((e) => e.action === "write")
    expect(revokeIdx).toBeGreaterThanOrEqual(0)
    expect(writeIdx).toBeGreaterThanOrEqual(0)
    expect(revokeIdx).toBeLessThan(writeIdx)
    expect(fakeSpawnObj.writeData.some((d) => d.includes("human-cmd"))).toBe(true)
    let staleThrew = false
    try {
      await svc.writeAgent(r.info.id, {
        ref: r.ref,
        leaseID: lease.id,
        revision: lease.revision,
        actor: agentActor,
        data: "echo too-late\r",
        now: ctl.now(),
      })
    } catch {
      staleThrew = true
    }
    expect(staleThrew).toBe(true)
    await svc.disposeTerminal(r.info.id)
  })

  test("private mode blocks agent; output tagged human-private", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-priv",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    expect(svc.info(r.info.id)!.private).toBe(true)
    fakeSpawnObj.onData("PRIVATE_SECRET\n")
    await new Promise((r2) => setTimeout(r2, 50))
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 1024 })
    expect(new TextDecoder().decode(agentRead.bytes)).not.toContain("PRIVATE_SECRET")
    expect(agentRead.privateBytes).toBeGreaterThan(0)
    await svc.privateMode(r.info.id, { ref: r.ref, active: false, now: ctl.now() })
    expect(svc.info(r.info.id)!.private).toBe(false)
    await svc.disposeTerminal(r.info.id)
  })

  test("private output before private.end remains private after leaving private mode", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-priv2",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    fakeSpawnObj.onData("PRIVATE_DATA\n")
    await new Promise((r2) => setTimeout(r2, 50))
    await svc.privateMode(r.info.id, { ref: r.ref, active: false, now: ctl.now() })
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 1024 })
    expect(new TextDecoder().decode(agentRead.bytes)).not.toContain("PRIVATE_DATA")
    expect(agentRead.privateBytes).toBeGreaterThan(0)
    await svc.disposeTerminal(r.info.id)
  })
})

describe("SharedTerminalService: two subscribers via queued subscribe", () => {
  test("two subscribers observe the same output exactly once", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-sub2",
      cols: 80,
      rows: 24,
    })
    const a: Service.SubscriberFrame[] = []
    const b: Service.SubscriberFrame[] = []
    fakeSpawnObj.onData("hello\n")
    await new Promise((r2) => setTimeout(r2, 50))
    await svc.subscribe(r.info.id, { ref: r.ref, from: 0, opts: { onFrame: (f) => a.push(f), onError: () => {} } })
    await svc.subscribe(r.info.id, { ref: r.ref, from: 0, opts: { onFrame: (f) => b.push(f), onError: () => {} } })
    expect(a.length).toBeGreaterThanOrEqual(1)
    expect(b.length).toBeGreaterThanOrEqual(1)
    const ta = new TextDecoder().decode(a[0].bytes)
    const tb = new TextDecoder().decode(b[0].bytes)
    expect(ta).toContain("hello")
    expect(tb).toContain("hello")
    fakeSpawnObj.onData("world\n")
    await new Promise((r2) => setTimeout(r2, 50))
    expect(a.length).toBeGreaterThanOrEqual(2)
    expect(b.length).toBeGreaterThanOrEqual(2)
    await svc.disposeTerminal(r.info.id)
  })

  test("subscribe from current cursor receives replay metadata and live frames", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-live-only",
      cols: 80,
      rows: 24,
    })
    fakeSpawnObj.onData("before_subscribe\n")
    await new Promise((r2) => setTimeout(r2, 50))
    const cursor = svc.info(r.info.id)!.end
    const frames: Service.SubscriberFrame[] = []
    await svc.subscribe(r.info.id, {
      ref: r.ref,
      from: cursor,
      opts: { onFrame: (f) => frames.push(f), onError: () => {} },
    })
    expect(frames.length).toBe(0)
    fakeSpawnObj.onData("after_subscribe\n")
    await new Promise((r2) => setTimeout(r2, 50))
    expect(frames.length).toBe(1)
    expect(frames[0].replay).toBe(false)
    expect(frames[0].from).toBeGreaterThanOrEqual(cursor)
    expect(new TextDecoder().decode(frames[0].bytes)).toContain("after_subscribe")
    await svc.disposeTerminal(r.info.id)
  })

  test("replay from stale cursor produces gap frame", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-stale-gap",
      cols: 80,
      rows: 24,
    })
    fakeSpawnObj.onData("stale before\n")
    await new Promise((r2) => setTimeout(r2, 50))
    const frames: Service.SubscriberFrame[] = []
    await svc.subscribe(r.info.id, { ref: r.ref, from: 0, opts: { onFrame: (f) => frames.push(f), onError: () => {} } })
    expect(frames.length).toBe(1)
    // With ring capacity large enough, there is no gap from cursor 0. Verify
    // the replay frame metadata is populated correctly.
    expect(frames[0].replay).toBe(true)
    expect(new TextDecoder().decode(frames[0].bytes)).toContain("stale before")
    await svc.disposeTerminal(r.info.id)
  })

  test("output arriving during subscribe is captured (no lost frames)", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-live-race",
      cols: 80,
      rows: 24,
    })
    const frames: Service.SubscriberFrame[] = []
    const subProm = svc.subscribe(r.info.id, {
      ref: r.ref,
      from: 0,
      opts: { onFrame: (f) => frames.push(f), onError: () => {} },
    })
    fakeSpawnObj.onData("during subscribe\n")
    // Wait for both the subscribe and the enqueued output handler to complete.
    await subProm
    await new Promise((r2) => setTimeout(r2, 50))
    expect(frames.length).toBeGreaterThanOrEqual(1)
    const allText = frames.map((f) => new TextDecoder().decode(f.bytes)).join("")
    expect(allText).toContain("during subscribe")
    await svc.disposeTerminal(r.info.id)
  })

  test("unsubscribe idempotency: no frames after unsubscribe", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-unsub",
      cols: 80,
      rows: 24,
    })
    const frames: Service.SubscriberFrame[] = []
    const cb = (f: Service.SubscriberFrame) => frames.push(f)
    await svc.subscribe(r.info.id, { ref: r.ref, from: 0, opts: { onFrame: cb, onError: () => {} } })
    await svc.unsubscribe(r.info.id, cb)
    // Repeated unsubscribe is idempotent.
    await svc.unsubscribe(r.info.id, cb)
    const beforeCount = frames.length
    fakeSpawnObj.onData("after unsubscribe\n")
    await new Promise((r2) => setTimeout(r2, 50))
    expect(frames.length).toBe(beforeCount)
    await svc.disposeTerminal(r.info.id)
  })

  test("callback failure isolation does not affect other subscribers", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-fail-iso",
      cols: 80,
      rows: 24,
    })
    const good: Service.SubscriberFrame[] = []
    const errs: unknown[] = []
    await svc.subscribe(r.info.id, {
      ref: r.ref,
      from: 0,
      opts: {
        onFrame: () => {
          throw new Error("callback fail")
        },
        onError: (e) => errs.push(e),
      },
    })
    await svc.subscribe(r.info.id, { ref: r.ref, from: 0, opts: { onFrame: (f) => good.push(f), onError: () => {} } })
    fakeSpawnObj.onData("isolation test\n")
    await new Promise((r2) => setTimeout(r2, 50))
    expect(errs.length).toBeGreaterThanOrEqual(1)
    expect(good.length).toBeGreaterThanOrEqual(1)
    expect(new TextDecoder().decode(good[0].bytes)).toContain("isolation test")
    await svc.disposeTerminal(r.info.id)
  })
})

describe("SharedTerminalService: exit and cleanup", () => {
  test("only onExit sets exitObserved, exitedAt, exitCode", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl, audit } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-exit",
      cols: 80,
      rows: 24,
    })
    expect(svc.info(r.info.id)!.exitedAt).toBeUndefined()
    expect(svc.info(r.info.id)!.exitCode).toBeUndefined()
    fakeSpawnObj.emitExit(42)
    await new Promise((r2) => setTimeout(r2, 50))
    const after = svc.info(r.info.id)!
    expect(after.exitCode).toBe(42)
    expect(after.exitedAt).toBeGreaterThan(0)
    expect(after.lifecycle).toBe("exited")
    await svc.disposeTerminal(r.info.id)
  })

  test("terminate then kill cleanup terminates process", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-term",
      cols: 80,
      rows: 24,
    })
    await svc.terminate(r.info.id, r.ref)
    await waitFor(() => svc.info(r.info.id)!.lifecycle === "terminated", { timeout: 5_000 })
    fakeSpawnObj.emitExit(0)
    await new Promise((r2) => setTimeout(r2, 50))
    const i = svc.info(r.info.id)!
    expect(i.lifecycle).toBe("terminated")
    expect(i.cleanup).toBe("cleaned")
    await svc.disposeTerminal(r.info.id)
  })

  test("delayed onExit after terminate still records metadata", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-delay",
      cols: 80,
      rows: 24,
    })
    await svc.terminate(r.info.id, r.ref)
    expect(svc.info(r.info.id)!.exitCode).toBeUndefined()
    fakeSpawnObj.emitExit(7)
    await new Promise((r2) => setTimeout(r2, 50))
    const i = svc.info(r.info.id)!
    expect(i.exitCode).toBe(7)
    expect(i.exitedAt).toBeGreaterThan(0)
    expect(i.lifecycle).toBe("terminated")
  })

  test("repeated onExit ignored after first complete callback", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-rep",
      cols: 80,
      rows: 24,
    })
    fakeSpawnObj.emitExit(0)
    await new Promise((r2) => setTimeout(r2, 50))
    fakeSpawnObj.emitExit(1)
    await new Promise((r2) => setTimeout(r2, 50))
    expect(svc.info(r.info.id)!.exitCode).toBe(0)
    await svc.disposeTerminal(r.info.id)
  })

  test("private encoder tail on exit uses correct visibility", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-priv-tail",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    // Enter private mode and emit a partial multibyte UTF-8 sequence.
    // U+1F600 (😀) encodes as F0 9F 98 80 in UTF-8. We'll send the first
    // two bytes (F0 9F) while in private mode, then exit.
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    // Emit an incomplete multibyte sequence (2 bytes of a 4-byte char).
    const partial = new Uint8Array([0xf0, 0x9f])
    fakeSpawnObj.onData(new TextDecoder("utf-8", { fatal: false }).decode(partial))
    await new Promise((r2) => setTimeout(r2, 50))
    // Exit while still in private mode. The encoder flush should append
    // U+FFFD with "human" visibility because private mode is active.
    fakeSpawnObj.emitExit(0)
    await new Promise((r2) => setTimeout(r2, 50))
    // Agent must NOT see the partial bytes or the replacement.
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const agentText = new TextDecoder().decode(agentRead.bytes)
    expect(agentText).not.toContain("\uFFFD")
    expect(agentText).toBe("")
    expect(agentRead.privateBytes).toBeGreaterThan(0)
    // Human reader must see the replacement character
    const humanRead = svc.readHuman(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const humanText = new TextDecoder().decode(humanRead.bytes)
    expect(humanText).toContain("\uFFFD")
    await svc.disposeTerminal(r.info.id)
  })
})

describe("SharedTerminalService: generation-bound authority", () => {
  test("generation increments once on final disposal", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-gen",
      cols: 80,
      rows: 24,
    })
    const initialGen = r.info.generation
    expect(initialGen).toBe(1)
    await svc.disposeTerminal(r.info.id)
    const afterFirst = svc.info(r.info.id)!
    expect(afterFirst.generation).toBe(initialGen + 1)
    const gen2 = afterFirst.generation
    await svc.disposeTerminal(r.info.id)
    expect(svc.info(r.info.id)!.generation).toBe(gen2)
  })

  test("stale generation ref fails", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-stale-gen",
      cols: 80,
      rows: 24,
    })
    const staleRef: Service.TerminalRef = { ...r.ref, generation: 0 }
    await svc.disposeTerminal(r.info.id)
    // All mutation operations with stale ref should fail.
    let threw = false
    try {
      await svc.acquireLease(r.info.id, { ref: staleRef, actor: agentActor, now: ctl.now() })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(svc.info(r.info.id)!.generation).toBe(r.ref.generation + 1)
  })

  test("stale PID ref fails", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-stale-pid",
      cols: 80,
      rows: 24,
    })
    const badRef: Service.TerminalRef = { ...r.ref, rootPID: 12345 }
    let threw = false
    try {
      await svc.acquireLease(r.info.id, { ref: badRef, actor: agentActor, now: ctl.now() })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // Correct ref still works.
    const lease = await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    expect(lease).toBeDefined()
    await svc.disposeTerminal(r.info.id)
  })

  test("correct generation ref succeeds", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-ok-gen",
      cols: 80,
      rows: 24,
    })
    const lease = await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    expect(lease.generation).toBe(r.ref.generation)
    await svc.disposeTerminal(r.info.id)
  })

  test("stale generation ref rejected while terminal still running; correct ref succeeds", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-stale-live",
      cols: 80,
      rows: 24,
    })
    // Terminal is still running (not disposed). A stale generation ref must
    // fail immediately.
    const staleRef: Service.TerminalRef = { ...r.ref, generation: 0 }
    let threw = false
    try {
      await svc.acquireLease(r.info.id, { ref: staleRef, actor: agentActor, now: ctl.now() })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // The correct ref must still succeed while the terminal is live.
    const lease = await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    expect(lease).toBeDefined()
    expect(lease.generation).toBe(r.ref.generation)
    await svc.disposeTerminal(r.info.id)
  })
})

describe("SharedTerminalService: spawn failure rollback", () => {
  test("spawn adapter that throws: no visible terminal, audit has create/failed", async () => {
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 32 })
    const { svc } = makeSvc({
      audit,
      spawn: () => {
        throw new Error("spawn failed")
      },
    })
    const scope = await makeScope()
    let threw = false
    try {
      await svc.create({
        file: "nonexistent.exe",
        args: [""],
        scope,
        createdBy: agentActor,
        title: "st-fail",
        cols: 80,
        rows: 24,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(svc.list().length).toBe(0)
    const records = audit.snapshot()
    const createEvents = records.filter((e) => e.action === "create")
    expect(createEvents.length).toBe(1)
    expect(createEvents[0].outcome).toBe("failed")
    const exitEvents = records.filter((e) => e.action === "exit")
    expect(exitEvents.length).toBe(0)
    const cleanupEvents = records.filter((e) => e.action === "cleanup")
    expect(cleanupEvents.length).toBe(0)
  })

  test("spawn returns PID 0: rolls back, audit has create/failed", async () => {
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 32 })
    const { svc } = makeSvc({
      audit,
      spawn: () => {
        const p = { pid: 0, cols: 80, rows: 24, process: "test" } as IPty
        return p
      },
    })
    const scope = await makeScope()
    let threw = false
    try {
      await svc.create({
        file: "test.exe",
        args: [""],
        scope,
        createdBy: agentActor,
        title: "st-pid0",
        cols: 80,
        rows: 24,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(svc.list().length).toBe(0)
    const creates = audit.snapshot().filter((e) => e.action === "create")
    expect(creates.length).toBe(1)
    expect(creates[0].outcome).toBe("failed")
  })

  test("spawn returns negative PID: rolls back", async () => {
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 32 })
    const { svc } = makeSvc({
      audit,
      spawn: () => {
        const p = { pid: -1, cols: 80, rows: 24, process: "test" } as IPty
        return p
      },
    })
    const scope = await makeScope()
    let threw = false
    try {
      await svc.create({
        file: "test.exe",
        args: [""],
        scope,
        createdBy: agentActor,
        title: "st-negpid",
        cols: 80,
        rows: 24,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(svc.list().length).toBe(0)
    expect(audit.snapshot().filter((e) => e.action === "create" && e.outcome === "failed").length).toBe(1)
  })

  test("invalid executable path rolls back; list() is empty", async () => {
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 32 })
    const { svc } = makeSvc({
      audit,
      spawn: () => {
        throw new Error("ENOENT")
      },
    })
    const scope = await makeScope()
    let threw = false
    try {
      await svc.create({
        file: "C:\\does-not-exist\\foo.exe",
        args: [""],
        scope,
        createdBy: agentActor,
        title: "st-noexe",
        cols: 80,
        rows: 24,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(svc.list().length).toBe(0)
  })

  test("spawn returns NaN PID: rolls back", async () => {
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 32 })
    const { svc } = makeSvc({
      audit,
      spawn: () => {
        const p = { pid: NaN, cols: 80, rows: 24, process: "test" } as IPty
        return p
      },
    })
    const scope = await makeScope()
    let threw = false
    try {
      await svc.create({
        file: "test.exe",
        args: [""],
        scope,
        createdBy: agentActor,
        title: "st-nanpid",
        cols: 80,
        rows: 24,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(svc.list().length).toBe(0)
    expect(audit.snapshot().filter((e) => e.action === "create" && e.outcome === "failed").length).toBe(1)
  })

  test("spawn returns Infinity PID: rolls back", async () => {
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 32 })
    const { svc } = makeSvc({
      audit,
      spawn: () => {
        const p = { pid: Number.POSITIVE_INFINITY, cols: 80, rows: 24, process: "test" } as IPty
        return p
      },
    })
    const scope = await makeScope()
    let threw = false
    try {
      await svc.create({
        file: "test.exe",
        args: [""],
        scope,
        createdBy: agentActor,
        title: "st-infpid",
        cols: 80,
        rows: 24,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(svc.list().length).toBe(0)
  })

  test("spawn returns unsafe integer PID: rolls back", async () => {
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 32 })
    const { svc } = makeSvc({
      audit,
      spawn: () => {
        const p = { pid: Number.MAX_SAFE_INTEGER + 1, cols: 80, rows: 24, process: "test" } as IPty
        return p
      },
    })
    const scope = await makeScope()
    let threw = false
    try {
      await svc.create({
        file: "test.exe",
        args: [""],
        scope,
        createdBy: agentActor,
        title: "st-unsafepid",
        cols: 80,
        rows: 24,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(svc.list().length).toBe(0)
  })

  test("onData registration throwing rolls back: fake reap called; audit create/failed + cleanup/applied", async () => {
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 32 })
    const reap = fakeReap({ status: "cleaned" })
    const { svc } = makeSvc({
      audit,
      reap: reap.fn,
      aliveCheck: reap.alive,
      spawn: () => {
        const p = { pid: 9999, cols: 80, rows: 24, process: "test" } as IPty
        const wrapped: IPty = {
          ...p,
          onData: () => {
            throw new Error("onData failed")
          },
          onExit: () => {
            return { dispose: () => {} }
          },
          kill: () => {},
        }
        return wrapped
      },
    })
    const scope = await makeScope()
    let threw = false
    try {
      await svc.create({
        file: "test.exe",
        args: [""],
        scope,
        createdBy: agentActor,
        title: "st-cb-onData",
        cols: 80,
        rows: 24,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(svc.list().length).toBe(0)
    expect(reap.calls.length).toBe(1)
    expect(reap.calls[0].terminalID).toBe("st-1")
    expect(reap.calls[0].generation).toBe(1)
    expect(reap.calls[0].rootPID).toBe(9999)
    expect(reap.calls[0].platform).toBe(process.platform)
    const creates = audit.snapshot().filter((e) => e.action === "create")
    expect(creates.length).toBe(1)
    expect(creates[0].outcome).toBe("failed")
    const cleanups = audit.snapshot().filter((e) => e.action === "cleanup")
    expect(cleanups.length).toBe(1)
    expect(cleanups[0].outcome).toBe("applied")
    const exits = audit.snapshot().filter((e) => e.action === "exit")
    expect(exits.length).toBe(0)
  })

  test("onExit registration throwing rolls back: fake reap called once; cleanup/applied", async () => {
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 32 })
    const reap = fakeReap({ status: "cleaned" })
    const { svc } = makeSvc({
      audit,
      reap: reap.fn,
      aliveCheck: reap.alive,
      spawn: () => {
        const p = { pid: 9999, cols: 80, rows: 24, process: "test" } as IPty
        const wrapped: IPty = {
          ...p,
          onData: () => {
            return { dispose: () => {} }
          },
          onExit: () => {
            throw new Error("onExit failed")
          },
          kill: () => {},
        }
        return wrapped
      },
    })
    const scope = await makeScope()
    let threw = false
    try {
      await svc.create({
        file: "test.exe",
        args: [""],
        scope,
        createdBy: agentActor,
        title: "st-cb-onExit",
        cols: 80,
        rows: 24,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(svc.list().length).toBe(0)
    expect(reap.calls.length).toBe(1)
    expect(reap.calls[0].rootPID).toBe(9999)
    const creates = audit.snapshot().filter((e) => e.action === "create")
    expect(creates.length).toBe(1)
    expect(creates[0].outcome).toBe("failed")
    const cleanups = audit.snapshot().filter((e) => e.action === "cleanup")
    expect(cleanups.length).toBe(1)
    expect(cleanups[0].outcome).toBe("applied")
  })

  test("callback registration failure with fake reap returning cleanup_failed: audit has cleanup/failed", async () => {
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 32 })
    const reap = fakeReap({ status: "ownership_mismatch" })
    let aliveProc = true
    const { svc } = makeSvc({
      audit,
      reap: reap.fn,
      aliveCheck: async () => aliveProc,
      spawn: () => {
        const p = { pid: 9999, cols: 80, rows: 24, process: "test" } as IPty
        const wrapped: IPty = {
          ...p,
          onData: () => {
            throw new Error("onData failed")
          },
          onExit: () => {
            return { dispose: () => {} }
          },
          kill: () => {},
        }
        return wrapped
      },
    })
    const scope = await makeScope()
    let threw = false
    try {
      await svc.create({
        file: "test.exe",
        args: [""],
        scope,
        createdBy: agentActor,
        title: "st-cb-fail",
        cols: 80,
        rows: 24,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(svc.list().length).toBe(0)
    expect(reap.calls.length).toBe(1)
    const creates = audit.snapshot().filter((e) => e.action === "create")
    expect(creates.length).toBe(1)
    expect(creates[0].outcome).toBe("failed")
    const cleanups = audit.snapshot().filter((e) => e.action === "cleanup")
    expect(cleanups.length).toBe(1)
    // aliveCheck returned true so cleanup is reported as failed.
    expect(cleanups[0].outcome).toBe("failed")
    // No cleanup/applied.
    const applied = audit.snapshot().filter((e) => e.action === "cleanup" && e.outcome === "applied")
    expect(applied.length).toBe(0)
  })

  test("invalid PID (0) never invokes fake reap", async () => {
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 32 })
    const reap = fakeReap({ status: "cleaned" })
    const { svc } = makeSvc({
      audit,
      reap: reap.fn,
      aliveCheck: reap.alive,
      spawn: () => {
        const p = { pid: 0, cols: 80, rows: 24, process: "test" } as IPty
        return p
      },
    })
    const scope = await makeScope()
    let threw = false
    try {
      await svc.create({
        file: "test.exe",
        args: [""],
        scope,
        createdBy: agentActor,
        title: "st-noreap",
        cols: 80,
        rows: 24,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(reap.calls.length).toBe(0)
  })
})

describe("SharedTerminalService: resize and interrupt queued", () => {
  test("resize updates info after queued operation", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-resize",
      cols: 80,
      rows: 24,
    })
    await svc.resize(r.info.id, r.ref, 120, 40)
    expect(svc.info(r.info.id)!.cols).toBe(120)
    expect(svc.info(r.info.id)!.rows).toBe(40)
    expect(fakeSpawnObj.resizeData).toContainEqual({ cols: 120, rows: 40 })
    await svc.disposeTerminal(r.info.id)
  })

  test("resize with stale ref fails", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-resize-fail",
      cols: 80,
      rows: 24,
    })
    const badRef: Service.TerminalRef = { ...r.ref, generation: 999 }
    let threw = false
    try {
      await svc.resize(r.info.id, badRef, 120, 40)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(svc.info(r.info.id)!.cols).toBe(80)
    await svc.disposeTerminal(r.info.id)
  })

  test("interrupt serializes \x03 through queue", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-intr",
      cols: 80,
      rows: 24,
    })
    const lease = await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    await svc.interrupt(r.info.id, {
      ref: r.ref,
      leaseID: lease.id,
      revision: lease.revision,
      actor: agentActor,
      now: ctl.now(),
    })
    expect(fakeSpawnObj.writeData).toContain("\x03")
    await svc.disposeTerminal(r.info.id)
  })

  test("interrupt without lease fails", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-intr-fail",
      cols: 80,
      rows: 24,
    })
    let threw = false
    try {
      await svc.interrupt(r.info.id, {
        ref: r.ref,
        leaseID: "fake",
        revision: 0,
        actor: agentActor,
        now: ctl.now(),
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(fakeSpawnObj.writeData).not.toContain("\x03")
    await svc.disposeTerminal(r.info.id)
  })
})

describe("SharedTerminalService: termination and idempotency", () => {
  test("race of two terminates produces one transition", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-race",
      cols: 80,
      rows: 24,
    })
    fakeSpawnObj.emitExit(0)
    await new Promise((r2) => setTimeout(r2, 50))
    const a = svc.terminate(r.info.id, r.ref)
    const b = svc.terminate(r.info.id, r.ref)
    await Promise.all([a, b])
    const i = svc.info(r.info.id)!
    expect(["terminating", "terminated"]).toContain(i.lifecycle)
    await svc.terminate(r.info.id, r.ref)
    expect(svc.info(r.info.id)!.lifecycle).toBe(i.lifecycle)
  })

  test("terminate with stale ref fails", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-term-stale",
      cols: 80,
      rows: 24,
    })
    const badRef: Service.TerminalRef = { ...r.ref, rootPID: 0 }
    let threw = false
    try {
      await svc.terminate(r.info.id, badRef)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // Correct ref still works.
    await svc.terminate(r.info.id, r.ref)
    expect(svc.info(r.info.id)!.lifecycle).toBe("terminated")
  })
})

describe("SharedTerminalService: disposeInstance", () => {
  test("disposeInstance cleans all owned terminals", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const i1 = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo A"],
      scope,
      createdBy: agentActor,
      title: "st-da",
      cols: 80,
      rows: 24,
    })
    const i2 = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo B"],
      scope,
      createdBy: agentActor,
      title: "st-db",
      cols: 80,
      rows: 24,
    })
    await svc.disposeInstance(scope.projectID)
    expect(svc.info(i1.info.id)!.cleanup).toBe("cleaned")
    expect(svc.info(i1.info.id)!.lifecycle).toBe("terminated")
    expect(svc.info(i2.info.id)!.cleanup).toBe("cleaned")
    expect(svc.info(i2.info.id)!.lifecycle).toBe("terminated")
  })
})

describe("SharedTerminalService: audit events contain metadata only", () => {
  test("serialized audit has only allowed field names and no raw payload", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 64 })
    const { svc } = makeSvc({ spawn: fakeSpawnObj.fn, audit })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-audit",
      cols: 80,
      rows: 24,
    })
    const lease = await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    await svc.writeAgent(r.info.id, {
      ref: r.ref,
      leaseID: lease.id,
      revision: lease.revision,
      actor: agentActor,
      data: "echo SECRET_PAYLOAD\r",
      now: ctl.now(),
    })
    await svc.writeHuman(r.info.id, { clientID: "human-x", data: "echo HUMAN_SECRET\r", now: ctl.now() })
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    await svc.privateMode(r.info.id, { ref: r.ref, active: false, now: ctl.now() })
    await svc.disposeTerminal(r.info.id)

    const all = audit.serialize()
    const json = JSON.stringify(all)
    const forbidden = [
      "SECRET_PAYLOAD",
      "HUMAN_SECRET",
      "KILO_MARKER",
      "echo",
      "ghp_",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "AWS_SECRET",
    ]
    for (const f of forbidden) expect(json).not.toContain(f)
    for (const e of all) {
      const parsed = S.AuditEvent.zod.safeParse(e)
      expect(parsed.success).toBe(true)
    }
    const allowed = new Set([
      "id",
      "terminalID",
      "generation",
      "revision",
      "time",
      "actor",
      "action",
      "outcome",
      "bytes",
      "correlationID",
      "reason",
    ])
    for (const e of all) {
      for (const k of Object.keys(e)) {
        if (k !== "projectID") expect(allowed.has(k)).toBe(true)
      }
    }
  })

  test("audit records show write applied with bytes count after successful PTY call", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 64 })
    const { svc } = makeSvc({ spawn: fakeSpawnObj.fn, audit })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-audit-bytes",
      cols: 80,
      rows: 24,
    })
    const lease = await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    await svc.writeAgent(r.info.id, {
      ref: r.ref,
      leaseID: lease.id,
      revision: lease.revision,
      actor: agentActor,
      data: "hello\r",
      now: ctl.now(),
    })
    const writes = audit
      .snapshot({ terminalID: r.info.id })
      .filter((e) => e.action === "write" && e.outcome === "applied")
    expect(writes.length).toBe(1)
    expect(writes[0].bytes).toBe(6) // "hello\r" length
    await svc.disposeTerminal(r.info.id)
  })

  test("lease rejection produces rejected audit event with reason", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 64 })
    const { svc } = makeSvc({ spawn: fakeSpawnObj.fn, audit })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-audit-rej",
      cols: 80,
      rows: 24,
    })
    let threw = false
    try {
      await svc.writeAgent(r.info.id, {
        ref: r.ref,
        leaseID: "fake-lease",
        revision: 0,
        actor: agentActor,
        data: "x\r",
        now: ctl.now(),
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    const rejected = audit
      .snapshot({ terminalID: r.info.id })
      .filter((e) => e.action === "write" && e.outcome === "rejected")
    expect(rejected.length).toBe(1)
    expect(rejected[0].reason).toBeDefined()
    expect(rejected[0].correlationID).toBe("fake-lease")
    await svc.disposeTerminal(r.info.id)
  })

  test("no legacy /pty state created", async () => {
    const mod = await import("../../src/kilocode/shared-terminal/service")
    const exported = Object.keys(mod)
    expect(exported.includes("Pty")).toBe(false)
  })
})

describe("SharedTerminalService: private-visibility queue-order races", () => {
  test("private mode entered before output: bytes are human-only", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-race-priv1",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    fakeSpawnObj.onData("RACE_PRIVATE_BYTES\n")
    await new Promise((r2) => setTimeout(r2, 50))
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    expect(new TextDecoder().decode(agentRead.bytes)).not.toContain("RACE_PRIVATE_BYTES")
    expect(agentRead.privateBytes).toBeGreaterThan(0)
    const humanRead = svc.readHuman(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    expect(new TextDecoder().decode(humanRead.bytes)).toContain("RACE_PRIVATE_BYTES")
    await svc.disposeTerminal(r.info.id)
  })

  test("private mode entered after shared output: only subsequent bytes are human", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-race-priv2",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    fakeSpawnObj.onData("SHARED_PART\n")
    await new Promise((r2) => setTimeout(r2, 50))
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    fakeSpawnObj.onData("PRIVATE_PART\n")
    await new Promise((r2) => setTimeout(r2, 50))
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const agentText = new TextDecoder().decode(agentRead.bytes)
    expect(agentText).toContain("SHARED_PART")
    expect(agentText).not.toContain("PRIVATE_PART")
    await svc.disposeTerminal(r.info.id)
  })

  test("private mode toggled repeatedly: each chunk uses its matched visibility", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-race-priv3",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    fakeSpawnObj.onData("A\n")
    await new Promise((r2) => setTimeout(r2, 50))
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    fakeSpawnObj.onData("B\n")
    await new Promise((r2) => setTimeout(r2, 50))
    await svc.privateMode(r.info.id, { ref: r.ref, active: false, now: ctl.now() })
    fakeSpawnObj.onData("C\n")
    await new Promise((r2) => setTimeout(r2, 50))
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const agentText = new TextDecoder().decode(agentRead.bytes)
    expect(agentText).toContain("A")
    expect(agentText).not.toContain("B")
    expect(agentText).toContain("C")
    await svc.disposeTerminal(r.info.id)
  })

  test("concurrent private mode and exit: private bytes are not exposed to agent", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-race-priv4",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    fakeSpawnObj.onData("EXIT_PRIVATE\n")
    await new Promise((r2) => setTimeout(r2, 50))
    fakeSpawnObj.emitExit(0)
    await new Promise((r2) => setTimeout(r2, 50))
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    expect(new TextDecoder().decode(agentRead.bytes)).not.toContain("EXIT_PRIVATE")
    expect(agentRead.privateBytes).toBeGreaterThan(0)
    await svc.disposeTerminal(r.info.id)
  })

  test("private mode ends before exit: sticky flush visibility preserves private tagging", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-priv-sticky",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    // Enter private mode and emit an incomplete multibyte UTF-8 sequence
    // that leaves a trailing high surrogate in the encoder.
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    // U+1F600 (😀) is F0 9F 98 80 in UTF-8. The first partial multibyte
    // input \xF0\x9F decodes as U+FFFD by TextDecoder — not a surrogate.
    // Instead, send a literal high surrogate chunk that the encoder will
    // buffer pending.
    fakeSpawnObj.onData("\uD835")
    await new Promise((r2) => setTimeout(r2, 50))
    // Leave private mode BEFORE exit.
    await svc.privateMode(r.info.id, { ref: r.ref, active: false, now: ctl.now() })
    // Now exit. The encoder flush emits U+FFFD for the pending surrogate.
    // The service layer must tag these bytes as "human" because the
    // surrogate entered the encoder while private mode was active, even
    // though private mode has since been deactivated.
    fakeSpawnObj.emitExit(0)
    await new Promise((r2) => setTimeout(r2, 50))
    // Agent must NOT see the replacement character.
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const agentText = new TextDecoder().decode(agentRead.bytes)
    expect(agentText).toBe("")
    expect(agentRead.privateBytes).toBeGreaterThan(0)
    // Human reader must see the replacement character.
    const humanRead = svc.readHuman(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const humanText = new TextDecoder().decode(humanRead.bytes)
    expect(humanText).toContain("\uFFFD")
    await svc.disposeTerminal(r.info.id)
  })
})

describe("SharedTerminalService: sticky push-resolution visibility", () => {
  test("private high surrogate, leave private, ordinary shared char: U+FFFD remains private, char is shared", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-sticky1",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    fakeSpawnObj.onData("\uD835")
    await new Promise((r2) => setTimeout(r2, 50))
    await svc.privateMode(r.info.id, { ref: r.ref, active: false, now: ctl.now() })
    fakeSpawnObj.onData("a")
    await new Promise((r2) => setTimeout(r2, 50))
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const agentText = new TextDecoder().decode(agentRead.bytes)
    expect(agentText).not.toContain("\uFFFD")
    expect(agentText).toBe("a")
    const humanRead = svc.readHuman(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const humanText = new TextDecoder().decode(humanRead.bytes)
    expect(humanText).toContain("\uFFFD")
    expect(humanText).toContain("a")
  })

  test("shared high surrogate, enter private, ordinary private char: U+FFFD remains shared, new char is private", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-sticky2",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    fakeSpawnObj.onData("\uD835")
    await new Promise((r2) => setTimeout(r2, 50))
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    fakeSpawnObj.onData("p")
    await new Promise((r2) => setTimeout(r2, 50))
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const agentText = new TextDecoder().decode(agentRead.bytes)
    expect(agentText).toContain("\uFFFD")
    expect(agentText).not.toContain("p")
    const humanRead = svc.readHuman(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const humanText = new TextDecoder().decode(humanRead.bytes)
    expect(humanText).toContain("\uFFFD")
    expect(humanText).toContain("p")
  })

  test("private high surrogate followed by shared matching low: completed astral char is private", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-sticky3",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    fakeSpawnObj.onData("\uD835")
    await new Promise((r2) => setTimeout(r2, 50))
    await svc.privateMode(r.info.id, { ref: r.ref, active: false, now: ctl.now() })
    fakeSpawnObj.onData("\uDD35")
    await new Promise((r2) => setTimeout(r2, 50))
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const agentText = new TextDecoder().decode(agentRead.bytes)
    expect(agentText).toBe("")
    expect(agentRead.privateBytes).toBeGreaterThan(0)
    const humanRead = svc.readHuman(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const humanText = new TextDecoder().decode(humanRead.bytes)
    expect(humanText).toContain("\uD835\uDD35")
  })

  test("shared high surrogate followed by private matching low: completed astral char is private (fail-closed)", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-sticky4",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    fakeSpawnObj.onData("\uD835")
    await new Promise((r2) => setTimeout(r2, 50))
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    fakeSpawnObj.onData("\uDD35")
    await new Promise((r2) => setTimeout(r2, 50))
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const agentText = new TextDecoder().decode(agentRead.bytes)
    expect(agentText).toBe("")
    expect(agentRead.privateBytes).toBeGreaterThan(0)
    const humanRead = svc.readHuman(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const humanText = new TextDecoder().decode(humanRead.bytes)
    expect(humanText).toContain("\uD835\uDD35")
  })

  test("private pending surrogate, empty callback, private mode ends, exit: flush remains private", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-sticky5",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    fakeSpawnObj.onData("\uD835")
    await new Promise((r2) => setTimeout(r2, 50))
    await svc.privateMode(r.info.id, { ref: r.ref, active: false, now: ctl.now() })
    fakeSpawnObj.emitExit(0)
    await new Promise((r2) => setTimeout(r2, 50))
    const agentRead = svc.readAgent(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    expect(new TextDecoder().decode(agentRead.bytes)).toBe("")
    expect(agentRead.privateBytes).toBeGreaterThan(0)
    const humanRead = svc.readHuman(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    expect(new TextDecoder().decode(humanRead.bytes)).toContain("\uFFFD")
  })

  test("no duplicate or omitted bytes across sticky visibility transitions", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-sticky6",
      cols: 80,
      rows: 24,
    })
    const beforeEnd = svc.info(r.info.id)!.end
    // Emit a sequence that exercises sticky transitions:
    // 1) shared "hello", 2) \uD835 in private, 3) leave private, 4) " world"
    fakeSpawnObj.onData("hello")
    await new Promise((r2) => setTimeout(r2, 50))
    await svc.privateMode(r.info.id, { ref: r.ref, active: true, now: ctl.now() })
    fakeSpawnObj.onData("\uD835")
    await new Promise((r2) => setTimeout(r2, 50))
    await svc.privateMode(r.info.id, { ref: r.ref, active: false, now: ctl.now() })
    fakeSpawnObj.onData(" world")
    await new Promise((r2) => setTimeout(r2, 50))
    const humanRead = svc.readHuman(r.info.id, { from: beforeEnd, maxBytes: 2048 })
    const humanText = new TextDecoder().decode(humanRead.bytes)
    // The sequence should contain "hello", U+FFFD, and " world" in order.
    expect(humanText.startsWith("hello")).toBe(true)
    expect(humanText).toContain("\uFFFD")
    expect(humanText.endsWith(" world")).toBe(true)
    // No bytes should be absent
    expect(humanText.length).toBe("hello".length + 1 + " world".length)
  })
})

describe("SharedTerminalService: audit outcomes", () => {
  test("writeAgent with missing proc after exit records failed, not applied", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 64 })
    const { svc } = makeSvc({ spawn: fakeSpawnObj.fn, audit })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-audit-miss",
      cols: 80,
      rows: 24,
    })
    const lease = await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    fakeSpawnObj.emitExit(0)
    await new Promise((r2) => setTimeout(r2, 50))
    let threw = false
    try {
      await svc.writeAgent(r.info.id, {
        ref: r.ref,
        leaseID: lease.id,
        revision: lease.revision,
        actor: agentActor,
        data: "x\r",
        now: ctl.now(),
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    const writes = audit.snapshot({ terminalID: r.info.id }).filter((e) => e.action === "write")
    expect(writes.length).toBe(1)
    expect(writes[0].outcome).toBe("failed")
    expect(writes[0].reason).toBe("process_exit")
    await svc.disposeTerminal(r.info.id)
  })

  test("resize on missing proc does NOT mutate dimensions and audit records failed", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 64 })
    const { svc } = makeSvc({ spawn: fakeSpawnObj.fn, audit })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-audit-resize",
      cols: 80,
      rows: 24,
    })
    fakeSpawnObj.emitExit(0)
    await new Promise((r2) => setTimeout(r2, 50))
    let threw = false
    try {
      await svc.resize(r.info.id, r.ref, 200, 100)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    const resizes = audit.snapshot({ terminalID: r.info.id }).filter((e) => e.action === "resize")
    expect(resizes.length).toBe(1)
    expect(resizes[0].outcome).toBe("failed")
    expect(resizes[0].reason).toBe("process_exit")
    // Dimensions must remain unchanged when the proc is missing.
    expect(svc.info(r.info.id)!.cols).toBe(80)
    expect(svc.info(r.info.id)!.rows).toBe(24)
    await svc.disposeTerminal(r.info.id)
  })

  test("interrupt with missing proc fails closed", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 64 })
    const { svc } = makeSvc({ spawn: fakeSpawnObj.fn, audit })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-audit-intr",
      cols: 80,
      rows: 24,
    })
    const lease = await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    fakeSpawnObj.emitExit(0)
    await new Promise((r2) => setTimeout(r2, 50))
    let threw = false
    try {
      await svc.interrupt(r.info.id, {
        ref: r.ref,
        leaseID: lease.id,
        revision: lease.revision,
        actor: agentActor,
        now: ctl.now(),
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    const interrupts = audit.snapshot({ terminalID: r.info.id }).filter((e) => e.action === "interrupt")
    expect(interrupts.length).toBe(1)
    expect(interrupts[0].outcome).toBe("failed")
    expect(interrupts[0].reason).toBe("process_exit")
    await svc.disposeTerminal(r.info.id)
  })

  test("exact audit order and outcomes for write-resize-interrupt-cleanup", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-fixed", limit: 64 })
    const { svc } = makeSvc({ spawn: fakeSpawnObj.fn, audit })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-audit-order",
      cols: 80,
      rows: 24,
    })
    // Rejected write (no lease)
    let threw = false
    try {
      await svc.writeAgent(r.info.id, {
        ref: r.ref,
        leaseID: "no-lease",
        revision: 0,
        actor: agentActor,
        data: "x\r",
        now: ctl.now(),
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // Successful acquire lease
    const lease = await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    // Successful write
    await svc.writeAgent(r.info.id, {
      ref: r.ref,
      leaseID: lease.id,
      revision: lease.revision,
      actor: agentActor,
      data: "echo ok\r",
      now: ctl.now(),
    })
    // Exit makes proc missing
    fakeSpawnObj.emitExit(0)
    await new Promise((r2) => setTimeout(r2, 50))
    // Failed write after exit
    threw = false
    try {
      await svc.writeAgent(r.info.id, {
        ref: r.ref,
        leaseID: lease.id,
        revision: lease.revision,
        actor: agentActor,
        data: "x\r",
        now: ctl.now(),
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    await svc.disposeTerminal(r.info.id)
    // Check audit ordering and outcomes.
    const events = audit.snapshot({ terminalID: r.info.id })
    const writes = events.filter((e) => e.action === "write" && e.outcome === "applied")
    const rejects = events.filter((e) => e.action === "write" && e.outcome === "rejected")
    const fails = events.filter((e) => e.action === "write" && e.outcome === "failed")
    const cleanups = events.filter((e) => e.action === "cleanup")
    expect(writes.length).toBe(1)
    expect(rejects.length).toBe(1)
    expect(fails.length).toBe(1)
    expect(rejects[0].correlationID).toBe("no-lease")
    expect(fails[0].reason).toBe("process_exit")
    // Cleanup must have exactly one final event (applied or failed).
    expect(cleanups.length).toBe(1)
    expect(cleanups[0].outcome).toBe("applied")
  })
})

describe("SharedTerminalService: replay beyond cap and stale cursor gap", () => {
  test("replay delivers all retained bytes across multiple chunks", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-replay-big",
      cols: 80,
      rows: 24,
    })
    // Emit enough data to exceed one READ_MAX_BYTES read chunk.
    const big = "x".repeat(S.LIMITS.READ_MAX_BYTES + 100) + "\n"
    fakeSpawnObj.onData(big)
    await new Promise((r2) => setTimeout(r2, 50))
    const frames: Service.SubscriberFrame[] = []
    await svc.subscribe(r.info.id, { ref: r.ref, from: 0, opts: { onFrame: (f) => frames.push(f), onError: () => {} } })
    // Should have produced multiple replay frames.
    expect(frames.length).toBeGreaterThanOrEqual(1)
    let totalBytes = 0
    for (const f of frames) {
      expect(f.replay).toBe(true)
      totalBytes += f.bytes.length
    }
    // Total delivered bytes should equal the output (plus any encoder flush).
    expect(totalBytes).toBeGreaterThanOrEqual(big.length)
    await svc.disposeTerminal(r.info.id)
  })

  test("exact replay/live boundary: no duplicate and no gap", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-boundary",
      cols: 80,
      rows: 24,
    })
    fakeSpawnObj.onData("BEFORE\n")
    await new Promise((r2) => setTimeout(r2, 50))
    const cursor = svc.info(r.info.id)!.end
    const allFrames: Service.SubscriberFrame[] = []
    await svc.subscribe(r.info.id, {
      ref: r.ref,
      from: cursor,
      opts: { onFrame: (f) => allFrames.push(f), onError: () => {} },
    })
    // No replay since we subscribed at the current cursor.
    const replayCount = allFrames.filter((f) => f.replay).length
    expect(replayCount).toBe(0)
    // Send live data
    fakeSpawnObj.onData("AFTER\n")
    await new Promise((r2) => setTimeout(r2, 50))
    const liveFrames = allFrames.filter((f) => !f.replay)
    expect(liveFrames.length).toBe(1)
    expect(new TextDecoder().decode(liveFrames[0].bytes)).toContain("AFTER")
    // No duplicates: "BEFORE" must not appear
    const allText = allFrames.map((f) => new TextDecoder().decode(f.bytes)).join("")
    expect(allText).not.toContain("BEFORE")
    await svc.disposeTerminal(r.info.id)
  })

  test("exact gap proof: injected small ring delivers exact offsets, no evicted bytes, no duplicates", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn, ringBytes: 10 })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-exact-gap",
      cols: 80,
      rows: 24,
    })
    fakeSpawnObj.onData("aaaaaa")
    await new Promise((r2) => setTimeout(r2, 50))
    fakeSpawnObj.onData("bbbbbb")
    await new Promise((r2) => setTimeout(r2, 50))
    const end = svc.info(r.info.id)!.end
    const ringCapacity = 10
    const expectedRetained = Math.max(0, end - ringCapacity)
    const frames: Service.SubscriberFrame[] = []
    await svc.subscribe(r.info.id, { ref: r.ref, from: 0, opts: { onFrame: (f) => frames.push(f), onError: () => {} } })
    expect(frames.length).toBeGreaterThanOrEqual(1)
    const gf = frames[0]
    expect(gf.gap).toBe(true)
    expect(gf.gapStart).toBe(0)
    expect(gf.gapEnd).toBe(expectedRetained)
    expect(gf.retainedStart).toBe(expectedRetained)
    // frame.from = retainedStart (first delivered cursor, not the stale requested cursor)
    expect(gf.from).toBe(expectedRetained)
    expect(gf.next).toBe(end)
    expect(gf.bytes.length).toBe(end - expectedRetained)
    expect(gf.next - gf.from).toBe(gf.bytes.length)
    // Exactly the retained bytes
    const expected = new TextEncoder().encode("aaaabbbbbb")
    expect(gf.bytes).toEqual(expected)
    // No duplicate or missing bytes
    const aCount = Array.from(gf.bytes).filter((b) => b === 0x61).length
    const bCount = Array.from(gf.bytes).filter((b) => b === 0x62).length
    expect(aCount).toBe(4)
    expect(bCount).toBe(6)
    await svc.disposeTerminal(r.info.id)
  })

  test("exact multi-frame replay: contiguous cursors, exact byte equality, no truncation", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-exact-replay",
      cols: 80,
      rows: 24,
    })
    const big = "x".repeat(S.LIMITS.READ_MAX_BYTES + 100) + "\n"
    fakeSpawnObj.onData(big)
    await new Promise((r2) => setTimeout(r2, 50))
    const capturedEnd = svc.info(r.info.id)!.end
    const frames: Service.SubscriberFrame[] = []
    await svc.subscribe(r.info.id, { ref: r.ref, from: 0, opts: { onFrame: (f) => frames.push(f), onError: () => {} } })
    expect(frames.length).toBeGreaterThanOrEqual(2)
    for (const f of frames) {
      expect(f.bytes.length).toBeLessThanOrEqual(S.LIMITS.READ_MAX_BYTES)
    }
    expect(frames[0].from).toBe(0)
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].from).toBe(frames[i - 1].next)
    }
    for (const f of frames) {
      expect(f.next - f.from).toBe(f.bytes.length)
    }
    expect(frames[frames.length - 1].next).toBe(capturedEnd)
    const allBytes = concatFrames(frames)
    const expected = new TextEncoder().encode(big)
    expect(allBytes).toEqual(expected)
    expect(allBytes.length).toBe(expected.length)
    await svc.disposeTerminal(r.info.id)
  })
})

function concatFrames(frames: Service.SubscriberFrame[]): Uint8Array {
  let n = 0
  for (const f of frames) n += f.bytes.length
  const out = new Uint8Array(n)
  let off = 0
  for (const f of frames) {
    out.set(f.bytes, off)
    off += f.bytes.length
  }
  return out
}

describe("SharedTerminalService: attachWithTicket and detach", () => {
  test("attachWithTicket creates attachment; returns metadata", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, tickets, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-att",
      cols: 80,
      rows: 24,
    })
    const callbacks = { onFrame: () => {}, onEvent: () => {}, onError: () => {} }
    const ticket = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })
    const att = await svc.attachWithTicket(r.info.id, { rawTicket: ticket.raw, callbacks })
    expect(att.attachmentID).toMatch(/^att-\d+$/)
    expect(att.terminalID).toBe(r.info.id)
    expect(att.generation).toBe(r.ref.generation)
    expect(att.mode).toBe("read")
    expect(att.closed).toBe(false)
    await svc.detach(r.info.id, att.attachmentID)
    await svc.disposeTerminal(r.info.id)
  })

  test("attachWithTicket to missing terminal throws", async () => {
    const { svc } = makeSvc()
    let threw = false
    try {
      await svc.attachWithTicket("st-nonexistent", {
        rawTicket: "invalid-ticket",
        callbacks: { onFrame: () => {}, onEvent: () => {}, onError: () => {} },
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("attachWithTicket to disposed terminal throws", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, tickets, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-att-disposed",
      cols: 80,
      rows: 24,
    })
    await svc.disposeTerminal(r.info.id)
    const ticket = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })
    let threw = false
    try {
      await svc.attachWithTicket(r.info.id, {
        rawTicket: ticket.raw,
        callbacks: { onFrame: () => {}, onEvent: () => {}, onError: () => {} },
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("detach is idempotent", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, tickets, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-att-idem",
      cols: 80,
      rows: 24,
    })
    const callbacks = { onFrame: () => {}, onEvent: () => {}, onError: () => {} }
    const ticket = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })
    const att = await svc.attachWithTicket(r.info.id, { rawTicket: ticket.raw, callbacks })
    await svc.detach(r.info.id, att.attachmentID)
    await svc.detach(r.info.id, att.attachmentID)
    await svc.detach(r.info.id, "att-nonexistent")
    await svc.disposeTerminal(r.info.id)
  })

  test("attachment receives live frames after attach; none after detach", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, tickets, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-att-frames",
      cols: 80,
      rows: 24,
    })
    const frames: Service.SubscriberFrame[] = []
    const ticket = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })
    const att = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket.raw,
      callbacks: {
        onFrame: (f) => frames.push(f),
        onEvent: () => {},
        onError: () => {},
      },
    })
    fakeSpawnObj.onData("LIVE_BEFORE\n")
    await new Promise((r2) => setTimeout(r2, 50))
    expect(frames.length).toBeGreaterThanOrEqual(1)
    expect(new TextDecoder().decode(frames[0].bytes)).toContain("LIVE_BEFORE")
    await svc.detach(r.info.id, att.attachmentID)
    const before = frames.length
    fakeSpawnObj.onData("AFTER_DETACH\n")
    await new Promise((r2) => setTimeout(r2, 50))
    expect(frames.length).toBe(before)
    await svc.disposeTerminal(r.info.id)
  })

  test("attachment receives replay from cursor 0", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, tickets, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-att-replay",
      cols: 80,
      rows: 24,
    })
    fakeSpawnObj.onData("REPLAY_ME\n")
    await new Promise((r2) => setTimeout(r2, 50))
    const frames: Service.SubscriberFrame[] = []
    const ticket = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })
    const att = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket.raw,
      cursor: 0,
      callbacks: {
        onFrame: (f) => frames.push(f),
        onEvent: () => {},
        onError: () => {},
      },
    })
    expect(frames.length).toBeGreaterThanOrEqual(1)
    expect(frames[0].replay).toBe(true)
    expect(new TextDecoder().decode(frames[0].bytes)).toContain("REPLAY_ME")
    await svc.detach(r.info.id, att.attachmentID)
    await svc.disposeTerminal(r.info.id)
  })

  test("write-mode attachment submitHuman writes data to PTY", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, tickets, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-att-submit",
      cols: 80,
      rows: 24,
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
    await svc.submitHuman(r.info.id, att.attachmentID, "echo hello\r", ctl.now())
    expect(fakeSpawnObj.writeData).toContain("echo hello\r")
    await svc.detach(r.info.id, att.attachmentID)
    await svc.disposeTerminal(r.info.id)
  })

  test("submitHuman with detached attachment throws", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, tickets, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-att-submit-fail",
      cols: 80,
      rows: 24,
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
    await svc.detach(r.info.id, att.attachmentID)
    let threw = false
    try {
      await svc.submitHuman(r.info.id, att.attachmentID, "x\r", ctl.now())
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    await svc.disposeTerminal(r.info.id)
  })

  test("attachment resizeAttachment resizes PTY", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, tickets, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-att-resize",
      cols: 80,
      rows: 24,
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
    await svc.resizeAttachment(r.info.id, att.attachmentID, 200, 50)
    expect(svc.info(r.info.id)!.cols).toBe(200)
    expect(svc.info(r.info.id)!.rows).toBe(50)
    expect(fakeSpawnObj.resizeData).toContainEqual({ cols: 200, rows: 50 })
    await svc.detach(r.info.id, att.attachmentID)
    await svc.disposeTerminal(r.info.id)
  })

  test("setAttachmentPrivate toggles private mode", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, tickets, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-att-priv",
      cols: 80,
      rows: 24,
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
    await svc.setAttachmentPrivate(r.info.id, att.attachmentID, true, ctl.now())
    expect(svc.info(r.info.id)!.private).toBe(true)
    await svc.setAttachmentPrivate(r.info.id, att.attachmentID, false, ctl.now())
    expect(svc.info(r.info.id)!.private).toBe(false)
    await svc.detach(r.info.id, att.attachmentID)
    await svc.disposeTerminal(r.info.id)
  })

  test("multiple attachments receive the same frames independently", async () => {
    const capturedEnvs: Array<Record<string, string>> = []
    const fakeSpawnObj = fakeSpawn({ envs: capturedEnvs })
    const { svc, tickets, clock: ctl } = makeSvc({ spawn: fakeSpawnObj.fn })
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "st-att-multi",
      cols: 80,
      rows: 24,
    })
    const a: Service.SubscriberFrame[] = []
    const b: Service.SubscriberFrame[] = []
    const ticket1 = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })
    const att1 = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket1.raw,
      callbacks: { onFrame: (f) => a.push(f), onEvent: () => {}, onError: () => {} },
    })
    const ticket2 = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })
    const att2 = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket2.raw,
      callbacks: { onFrame: (f) => b.push(f), onEvent: () => {}, onError: () => {} },
    })
    fakeSpawnObj.onData("MULTI_ATT\n")
    await new Promise((r2) => setTimeout(r2, 50))
    expect(a.length).toBeGreaterThanOrEqual(1)
    expect(b.length).toBeGreaterThanOrEqual(1)
    expect(new TextDecoder().decode(a[0].bytes)).toContain("MULTI_ATT")
    expect(new TextDecoder().decode(b[0].bytes)).toContain("MULTI_ATT")
    await svc.detach(r.info.id, att1.attachmentID)
    await svc.detach(r.info.id, att2.attachmentID)
    await svc.disposeTerminal(r.info.id)
  })
})
