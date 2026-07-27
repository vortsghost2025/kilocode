import { test, expect, describe } from "bun:test"
import { SharedTerminalService as Service } from "../../src/kilocode/shared-terminal/service"
import { SharedTerminalSchema as S } from "../../src/kilocode/shared-terminal/schema"
import { AuditStore } from "../../src/kilocode/shared-terminal/audit"
import { TicketState } from "../../src/kilocode/shared-terminal/ticket"
import { tmpdir } from "../fixture/fixture"

const isWin = process.platform === "win32"
const WIN_CMD = process.env.ComSpec || "cmd.exe"

interface Scope {
  projectID: string
  directory: string
  worktree: string
}

async function makeScope(): Promise<Scope> {
  await using tmp = await tmpdir()
  return { projectID: "proj-bp", directory: tmp.path, worktree: tmp.path }
}

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function fakeSpawn(): { fn: Service.SpawnFn; onData: (chunk: string) => void; emitExit: (code: number) => void } {
  let onDataCbs: Array<(chunk: string) => void> = []
  let onExitCbs: Array<(ev: { exitCode: number }) => void> = []
  const fn: Service.SpawnFn = (_file, _args, _opts) => {
    const p = { pid: 9999, cols: 80, rows: 24, process: "test" } as import("bun-pty").IPty
    return {
      ...p,
      onData: (cb) => {
        onDataCbs.push(cb)
        return { dispose: () => {} }
      },
      onExit: (cb) => {
        onExitCbs.push(cb)
        return { dispose: () => {} }
      },
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
  }
  return {
    fn,
    onData: (chunk) => {
      for (const cb of onDataCbs) cb(chunk)
    },
    emitExit: (code) => {
      for (const cb of onExitCbs) cb({ exitCode: code })
    },
  }
}

const agentActor: Extract<S.Actor, { type: "agent" }> = {
  type: "agent",
  sessionID: "sess-bp",
  agentID: "ag-bp",
  callID: "call-bp",
}

function makeSvc() {
  const ctl = clock()
  const audit = new AuditStore({ clock: ctl.now, id: () => "evt-bp", limit: 128 })
  const tickets = new TicketState()
  const spawn = fakeSpawn()
  return {
    svc: Service.create({
      clock: ctl.now,
      audit,
      tickets,
      platform: process.platform as Service.Platform,
      spawn: spawn.fn,
      envSource: {},
      isolatedPaths: { home: "/tmp/test" },
    }),
    clock: ctl,
    audit,
    spawn,
    tickets,
  }
}

describe("Backpressure: attachment fan-out isolation", () => {
  test("one slow attachment callback does not block other attachments", async () => {
    const { svc, clock: ctl, spawn, tickets } = makeSvc()
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "bp-isolate",
      cols: 80,
      rows: 24,
    })
    const slow: Service.SubscriberFrame[] = []
    const fast: Service.SubscriberFrame[] = []
    const ticket1 = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })
    const att1 = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket1.raw,
      callbacks: {
        onFrame: (f) => {
          slow.push(f)
          throw new Error("slow fail")
        },
        onEvent: () => {},
        onError: () => {},
      },
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
      callbacks: { onFrame: (f) => fast.push(f), onEvent: () => {}, onError: () => {} },
    })
    spawn.onData("isolation_test\n")
    await new Promise((r2) => setTimeout(r2, 50))
    // Fast attachment should still receive the frame despite the first throwing
    expect(fast.length).toBeGreaterThanOrEqual(1)
    expect(new TextDecoder().decode(fast[0].bytes)).toContain("isolation_test")
    await svc.detach(r.info.id, att1.attachmentID)
    await svc.detach(r.info.id, att2.attachmentID)
    await svc.disposeTerminal(r.info.id)
  })

  test("one slow event callback does not block other attachments from events", async () => {
    const { svc, clock: ctl, spawn, tickets } = makeSvc()
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "bp-ev-iso",
      cols: 80,
      rows: 24,
    })
    const fastEvents: Service.ServiceEvent[] = []
    const ticket1 = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })
    const att1 = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket1.raw,
      callbacks: {
        onFrame: () => {},
        onEvent: () => {
          throw new Error("slow event")
        },
        onError: () => {},
      },
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
      callbacks: { onFrame: () => {}, onEvent: (e) => fastEvents.push(e), onError: () => {} },
    })
    await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    await new Promise((r2) => setTimeout(r2, 50))
    expect(fastEvents.filter((e) => e.type === "lease.acquired").length).toBe(1)
    await svc.detach(r.info.id, att1.attachmentID)
    await svc.detach(r.info.id, att2.attachmentID)
    await svc.disposeTerminal(r.info.id)
  })
})

describe("Backpressure: no missed frames under rapid output", () => {
  test("multiple rapid output chunks deliver every byte to attachments", async () => {
    const { svc, clock: ctl, spawn, tickets } = makeSvc()
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "bp-rapid",
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
      cursor: 0,
      callbacks: { onFrame: (f) => frames.push(f), onEvent: () => {}, onError: () => {} },
    })
    // Emit many small chunks rapidly
    const expected = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz")
    for (const ch of "abcdefghijklmnopqrstuvwxyz") {
      spawn.onData(ch)
    }
    await new Promise((r2) => setTimeout(r2, 100))
    const allBytes = new Uint8Array(frames.reduce((n, f) => n + f.bytes.length, 0))
    let off = 0
    for (const f of frames) {
      allBytes.set(f.bytes, off)
      off += f.bytes.length
    }
    expect(allBytes).toEqual(expected)
    await svc.detach(r.info.id, att.attachmentID)
    await svc.disposeTerminal(r.info.id)
  })

  test("concurrent attach and output: no lost frames for new attachment", async () => {
    const { svc, clock: ctl, spawn, tickets } = makeSvc()
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "bp-conc",
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
    const prom = svc.attachWithTicket(r.info.id, {
      rawTicket: ticket.raw,
      cursor: 0,
      callbacks: { onFrame: (f) => frames.push(f), onEvent: () => {}, onError: () => {} },
    })
    spawn.onData("concurrent\n")
    await prom
    await new Promise((r2) => setTimeout(r2, 50))
    expect(frames.length).toBeGreaterThanOrEqual(1)
    const allText = frames.map((f) => new TextDecoder().decode(f.bytes)).join("")
    expect(allText).toContain("concurrent")
    await svc.disposeTerminal(r.info.id)
  })
})

describe("Backpressure: detach stops frame delivery", () => {
  test("detached attachment stops receiving frames", async () => {
    const { svc, clock: ctl, spawn, tickets } = makeSvc()
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "bp-detach",
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
      callbacks: { onFrame: (f) => frames.push(f), onEvent: () => {}, onError: () => {} },
    })
    spawn.onData("before_detach\n")
    await new Promise((r2) => setTimeout(r2, 50))
    expect(frames.length).toBeGreaterThanOrEqual(1)
    await svc.detach(r.info.id, att.attachmentID)
    const before = frames.length
    spawn.onData("after_detach\n")
    await new Promise((r2) => setTimeout(r2, 50))
    expect(frames.length).toBe(before)
    await svc.disposeTerminal(r.info.id)
  })

  test("detach is idempotent", async () => {
    const { svc, clock: ctl, spawn, tickets } = makeSvc()
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "bp-detach-idem",
      cols: 80,
      rows: 24,
    })
    const ticket = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })
    const att = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket.raw,
      callbacks: { onFrame: () => {}, onEvent: () => {}, onError: () => {} },
    })
    await svc.detach(r.info.id, att.attachmentID)
    await svc.detach(r.info.id, att.attachmentID)
    await svc.detach(r.info.id, "nonexistent")
    await svc.disposeTerminal(r.info.id)
  })
})

describe("Backpressure: emitEvent resilience", () => {
  test("emitEvent with zero attachments does not throw", async () => {
    const { svc, clock: ctl, spawn } = makeSvc()
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "bp-emit0",
      cols: 80,
      rows: 24,
    })
    await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    await svc.disposeTerminal(r.info.id)
  })

  test("closed attachment does not receive events", async () => {
    const { svc, clock: ctl, spawn, tickets } = makeSvc()
    const scope = await makeScope()
    const r = await svc.create({
      file: WIN_CMD,
      args: ["/c", "echo T"],
      scope,
      createdBy: agentActor,
      title: "bp-closed",
      cols: 80,
      rows: 24,
    })
    const events: Service.ServiceEvent[] = []
    const ticket = tickets.issue({
      terminalID: r.info.id,
      generation: r.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })
    const att = await svc.attachWithTicket(r.info.id, {
      rawTicket: ticket.raw,
      callbacks: { onFrame: () => {}, onEvent: (e) => events.push(e), onError: () => {} },
    })
    await svc.acquireLease(r.info.id, { ref: r.ref, actor: agentActor, now: ctl.now() })
    await new Promise((r2) => setTimeout(r2, 50))
    expect(events.filter((e) => e.type === "lease.acquired").length).toBe(1)
    // Manually close the attachment in state (simulate what detach does)
    await svc.detach(r.info.id, att.attachmentID)
    const before = events.length
    await svc.resize(r.info.id, r.ref, 100, 30)
    await new Promise((r2) => setTimeout(r2, 50))
    expect(events.length).toBe(before)
    await svc.disposeTerminal(r.info.id)
  })
})
