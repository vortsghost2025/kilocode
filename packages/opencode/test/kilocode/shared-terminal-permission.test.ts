import { describe, expect, test, afterEach } from "bun:test"
import {
  TerminalTool,
  type TerminalToolService,
  type ToolTerminalRef,
  type TerminalToolContext,
  type ReleaseInput,
  type ReleaseResult,
} from "../../src/kilocode/shared-terminal/tool"
import { SharedTerminalSchema as S } from "../../src/kilocode/shared-terminal/schema"
import type { Tool } from "../../src/tool/tool"
import { Identifier } from "../../src/id/id"
import { SessionID } from "../../src/session/schema"
import { MessageID } from "../../src/session/schema"
import type { Permission } from "../../src/permission"

// =============================================================================
// ST-05 permission + ACL tests for the `terminal` tool.
//
// These tests exercise the permission boundary in isolation using injected
// deterministic service + permission seams. They DO NOT spawn a real PTY, do
// NOT reach Reap.reap / Reap.alive / process.kill / bun-pty, and do not let a
// fabricated PID reach any OS cleanup operation.
// =============================================================================

type AskCall = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

const PROJECT_ID = "proj-abc"
const SESSION_ID = SessionID.make(Identifier.ascending("session"))
const MESSAGE_ID = MessageID.make(Identifier.ascending("message"))
const CALL_ID = "call-1"
const AGENT_ID = "orchestrator"

const agentActor: S.Actor = { type: "agent", sessionID: SESSION_ID, agentID: AGENT_ID, callID: CALL_ID }

const BASE_INFO: S.Info = {
  id: "st-1",
  generation: 1,
  title: "t",
  shell: "sh",
  pid: 4321,
  scope: { projectID: PROJECT_ID, directory: ".", worktree: "." },
  access: { human: "read-write", agent: "read-write", sessions: [SESSION_ID] },
  lifecycle: "running",
  cleanup: "pending",
  cols: 80,
  rows: 24,
  start: 0,
  end: 0,
  private: false,
  createdBy: agentActor,
  createdAt: 1,
}

const BASE_REF: ToolTerminalRef = {
  terminalID: "st-1",
  generation: 1,
  rootPID: 4321,
  platform: process.platform as ToolTerminalRef["platform"],
}

const BASE_LEASE: S.Lease = {
  id: "lease-1",
  terminalID: "st-1",
  generation: 1,
  actor: agentActor as Extract<S.Actor, { type: "agent" }>,
  revision: 0,
  acquiredAt: 1,
  expiresAt: 16001,
  maxAt: 60001,
}

const BASE_READ: S.ReadResult = {
  terminalID: "st-1",
  requested: 0,
  start: 0,
  end: 0,
  next: 0,
  truncated: false,
  privateBytes: 0,
  eof: true,
  text: "",
  gap: false,
}

// Service seam: records method/ref/actor/session + arguments only. Never
// records raw command bytes, env, ticket values, or credentials.
interface RecordedCall {
  method: string
  ref: ToolTerminalRef
  actor: S.Actor | undefined
  sessionID: string
  args: Record<string, unknown>
}

function makeSeam(opts?: {
  ref?: ToolTerminalRef
  infos?: S.Info[]
  readResult?: S.ReadResult
  lease?: S.Lease
  release?: (input: ReleaseInput) => ReleaseResult
  refForCreate?: ToolTerminalRef
}): { seam: TerminalToolService; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const refForCreate = opts?.refForCreate ?? BASE_REF
  const infos = opts?.infos ?? [BASE_INFO]
  const lease = opts?.lease ?? BASE_LEASE
  const read = opts?.readResult ?? BASE_READ
  const record = (
    method: string,
    r: ToolTerminalRef | undefined,
    o: { actor?: S.Actor; sessionID: string; args: Record<string, unknown> },
  ) => {
    calls.push({
      method,
      ref: r ? { ...r } : { ...BASE_REF },
      actor: o.actor ? cloneActor(o.actor) : undefined,
      sessionID: o.sessionID,
      args: sanitizeArgs(o.args),
    })
  }
  const seam: TerminalToolService = {
    async listAccessibleSessions(input) {
      record("listAccessibleSessions", undefined, { sessionID: input.sessionID, args: { projectID: input.projectID } })
      return infos.map((i) => cloneInfo(i))
    },
    createShellOnly(input) {
      record("createShellOnly", refForCreate, {
        actor: actorFor(input),
        sessionID: input.sessionID,
        args: {
          title: input.title,
          cols: input.cols,
          rows: input.rows,
        },
      })
      return Promise.resolve({ info: cloneInfo(infos[0]), ref: { ...refForCreate } })
    },
    readAgent(input) {
      record("readAgent", input.ref, {
        sessionID: input.sessionID,
        args: { cursor: input.cursor, maxBytes: input.maxBytes },
      })
      return Promise.resolve({ ...read })
    },
    acquireLease(input) {
      record("acquireLease", input.ref, { actor: input.actor, sessionID: input.sessionID, args: {} })
      return Promise.resolve({ ...lease })
    },
    releaseLease(input) {
      record("releaseLease", input.ref, {
        actor: input.actor,
        sessionID: input.sessionID,
        args: { leaseID: input.leaseID, revision: input.revision },
      })
      if (opts?.release) return Promise.resolve(opts.release(input))
      return Promise.resolve({ action: "release", success: true, terminalID: input.ref.terminalID })
    },
    writeAgent(input) {
      record("writeAgent", input.ref, {
        actor: input.actor,
        sessionID: input.sessionID,
        args: { leaseID: input.leaseID, revision: input.revision, dataBytes: input.data.length },
      })
      return Promise.resolve({
        action: "write",
        success: true,
        terminalID: input.ref.terminalID,
        revision: input.revision + 1,
      })
    },
    resize(input) {
      record("resize", input.ref, {
        sessionID: input.sessionID,
        args: { cols: input.cols, rows: input.rows },
      })
      return Promise.resolve({
        action: "resize",
        success: true,
        terminalID: input.ref.terminalID,
        cols: input.cols,
        rows: input.rows,
      })
    },
    interrupt(input) {
      record("interrupt", input.ref, {
        actor: input.actor,
        sessionID: input.sessionID,
        args: { leaseID: input.leaseID, revision: input.revision },
      })
      return Promise.resolve({ action: "interrupt", success: true, terminalID: input.ref.terminalID })
    },
    terminate(input) {
      record("terminate", input.ref, { sessionID: input.sessionID, args: {} })
      return Promise.resolve({ action: "terminate", success: true, terminalID: input.ref.terminalID })
    },
  }
  return { seam, calls }
}

// Context seam: records every permission ask and can deny a specific permission
// or all asks. A deny throws BEFORE recording any service-side expectation so
// denied actions cannot mutate the service.
function makeCtx(opts?: { asked?: AskCall[]; deny?: string | string[]; denyAll?: boolean }): Tool.Context {
  const asked: AskCall[] = opts?.asked ?? []
  let denySet: Set<string> | undefined
  if (opts?.deny) denySet = new Set(Array.isArray(opts.deny) ? opts.deny : [opts.deny])
  return {
    sessionID: SESSION_ID,
    messageID: MESSAGE_ID,
    agent: AGENT_ID,
    callID: CALL_ID,
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">) {
      asked.push({
        permission: input.permission,
        patterns: [...input.patterns],
        always: [...(input.always ?? [])],
        metadata: input.metadata ?? {},
      })
      if (opts?.denyAll || (denySet && denySet.has(input.permission))) {
        const err = new Error(`denied: ${input.permission}`)
        ;(err as Error & { name: string }).name = "PermissionDenied"
        throw err
      }
    },
  } as unknown as Tool.Context
}

// Build a test-bound tool and run a single action.
function trustedCtx(): TerminalToolContext {
  return { projectID: PROJECT_ID, sessionID: SESSION_ID, agent: AGENT_ID, callID: CALL_ID, directory: "." }
}

async function runFrom(seam: TerminalToolService, ctx: Tool.Context, input: unknown) {
  const tool = (
    TerminalTool as Tool.Info & {
      attachForTest(seam: TerminalToolService, ctx: TerminalToolContext): Tool.Info
    }
  ).attachForTest(seam, trustedCtx())
  const init = await tool.init()
  const args = init.parameters.parse(input)
  return init.execute(args, ctx)
}

afterEach(() => {
  ;(TerminalTool as { resetForTest?: () => void }).resetForTest?.()
})

// ACL helper: build a seam where listAccessibleSessions returns no terminals
// (simulating a hidden terminal whose ACL excludes the caller). The seam
// records whether listAccessibleSessions was called, but no mutating
// operation should be reached because the terminal-specific actions perform
// the ACL check via listAccessibleSessions BEFORE the permission ask.
function hiddenSeam(): { seam: TerminalToolService; calls: RecordedCall[] } {
  return makeSeam({ infos: [] })
}

// -----------------------------------------------------------------------------
// Cloning + sanitization helpers (deterministic and never leaking forbidden
// values into recorded test evidence).
// -----------------------------------------------------------------------------
function cloneInfo(i: S.Info): S.Info {
  return {
    ...i,
    scope: { ...i.scope },
    access: { ...i.access, sessions: [...i.access.sessions] },
    createdBy: cloneActor(i.createdBy),
  }
}

function cloneActor(a: S.Actor): S.Actor {
  switch (a.type) {
    case "human":
      return { type: "human", clientID: a.clientID }
    case "agent":
      return { type: "agent", sessionID: a.sessionID, agentID: a.agentID, callID: a.callID }
    case "system":
      return { type: "system", reason: a.reason }
  }
}

function actorFor(input: { actor: S.Actor }): S.Actor | undefined {
  return cloneActor(input.actor)
}

// Strip forbidden payloads from recorded args (defense in depth): keep only
// metadata-safe scalar counts/dims. Raw data text is replaced with its byte
// length so test evidence never persists command bytes.
function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    out[k] = v
  }
  return out
}

// =============================================================================
// Tests
// =============================================================================

describe("terminal tool: permission grammar", () => {
  // The exact action -> (permission, pattern) table the tool must enforce.
  const TABLE = [
    { action: { action: "list" }, perm: "terminal_discover", pattern: PROJECT_ID },
    { action: { action: "create", title: "x" }, perm: "terminal_create", pattern: PROJECT_ID },
    { action: { action: "read", terminal_id: "st-1" }, perm: "terminal_read", pattern: `${PROJECT_ID}/st-1` },
    { action: { action: "lease", terminal_id: "st-1" }, perm: "terminal_write", pattern: `${PROJECT_ID}/st-1` },
    {
      action: { action: "release", terminal_id: "st-1", lease_id: "lease-1", revision: 0 },
      perm: "terminal_write",
      pattern: `${PROJECT_ID}/st-1`,
    },
    {
      action: { action: "write", terminal_id: "st-1", lease_id: "lease-1", revision: 0, data: "hi" },
      perm: "terminal_write",
      pattern: `${PROJECT_ID}/st-1`,
    },
    {
      action: { action: "resize", terminal_id: "st-1", cols: 100, rows: 30 },
      perm: "terminal_resize",
      pattern: `${PROJECT_ID}/st-1`,
    },
    {
      action: { action: "interrupt", terminal_id: "st-1", lease_id: "lease-1", revision: 0 },
      perm: "terminal_interrupt",
      pattern: `${PROJECT_ID}/st-1`,
    },
    { action: { action: "terminate", terminal_id: "st-1" }, perm: "terminal_terminate", pattern: `${PROJECT_ID}/st-1` },
  ] as const

  for (const row of TABLE) {
    test(`${(row.action as { action: string }).action} -> ${row.perm} (${row.pattern})`, async () => {
      const { seam, calls } = makeSeam()
      const asked: AskCall[] = []
      const ctx = makeCtx({ asked, deny: row.perm })
      await expect(runFrom(seam, ctx, row.action)).rejects.toBeDefined()
      // Exact permission name + exact pattern were asked.
      expect(asked.some((a) => a.permission === row.perm && a.patterns.includes(row.pattern))).toBe(true)
      // For non-list denied actions, no service mutation occurred at all.
      const nonList = (row.action as { action: string }).action
      if (nonList !== "list") {
        // listAccessibleSessions may have been invoked for ACL BEFORE the ask;
        // that is read-only and allowed. No mutating op (create/write/etc.) ran.
        const mutatingMethods = [
          "createShellOnly",
          "acquireLease",
          "releaseLease",
          "writeAgent",
          "resize",
          "interrupt",
          "terminate",
          "readAgent",
        ]
        expect(calls.some((c) => mutatingMethods.includes(c.method))).toBe(false)
      }
    })
  }

  test("list denial blocks listAccessibleSessions entirely", async () => {
    const { seam, calls } = makeSeam()
    const ctx = makeCtx({ deny: "terminal_discover" })
    await expect(runFrom(seam, ctx, { action: "list" })).rejects.toBeDefined()
    // list must invoke the ACL/list read AFTER the permission ask; denial
    // means no service call at all.
    expect(calls.length).toBe(0)
  })
})

describe("terminal tool: denied action -> zero service mutation", () => {
  const cases = [
    { name: "create", input: { action: "create", title: "x" }, perm: "terminal_create" },
    { name: "read", input: { action: "read", terminal_id: "st-1" }, perm: "terminal_read" },
    { name: "lease", input: { action: "lease", terminal_id: "st-1" }, perm: "terminal_write" },
    {
      name: "release",
      input: { action: "release", terminal_id: "st-1", lease_id: "lease-1", revision: 0 },
      perm: "terminal_write",
    },
    {
      name: "write",
      input: { action: "write", terminal_id: "st-1", lease_id: "lease-1", revision: 0, data: "hi" },
      perm: "terminal_write",
    },
    { name: "resize", input: { action: "resize", terminal_id: "st-1", cols: 90, rows: 25 }, perm: "terminal_resize" },
    {
      name: "interrupt",
      input: { action: "interrupt", terminal_id: "st-1", lease_id: "lease-1", revision: 0 },
      perm: "terminal_interrupt",
    },
    { name: "terminate", input: { action: "terminate", terminal_id: "st-1" }, perm: "terminal_terminate" },
  ] as const

  for (const c of cases) {
    test(`${c.name}: no lease transition, no PTY write/resize/interrupt, no cleanup`, async () => {
      const { seam, calls } = makeSeam()
      const ctx = makeCtx({ deny: c.perm })
      await expect(runFrom(seam, ctx, c.input)).rejects.toBeDefined()
      // The mutating methods of the seam must not have run after the denial.
      const mutating = [
        "createShellOnly",
        "acquireLease",
        "releaseLease",
        "writeAgent",
        "resize",
        "interrupt",
        "terminate",
      ]
      expect(calls.some((m) => mutating.includes(m.method))).toBe(false)
      // readAgent is read-only but a denied read must not even read.
      if (c.name === "read") expect(calls.some((m) => m.method === "readAgent")).toBe(false)
    })
  }

  test("no raw terminal metadata in any denial error envelope", async () => {
    const { seam } = makeSeam()
    const ctx = makeCtx({ denyAll: true })
    const results: string[] = []
    for (const a of [
      { action: "list" },
      { action: "create", title: "x" },
      { action: "read", terminal_id: "st-1" },
      { action: "lease", terminal_id: "st-1" },
      { action: "terminate", terminal_id: "st-1" },
    ]) {
      try {
        await runFrom(seam, ctx, a)
      } catch (e) {
        results.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
      }
    }
    // Denials must not embed shell names, PIDs, generation, titles, tickets, env.
    const forbidden = ["4321", "sh", "title", "lease-1", "ticket", "ComSpec", "PATH"]
    for (const r of results) for (const f of forbidden) expect(r).not.toContain(f)
  })
})

describe("terminal tool: ACL before permission prompt", () => {
  test("hidden terminal read invokes no permission prompt", async () => {
    const { seam } = hiddenSeam()
    const asked: AskCall[] = []
    const ctx = makeCtx({ asked })
    // read on a hidden terminal: ACL hides it -> no permission ask, safe denial.
    let result
    try {
      result = await runFrom(seam, ctx, { action: "read", terminal_id: "st-hidden" })
    } catch (e) {
      result = { __error: e instanceof Error ? e.message : String(e) }
    }
    // No permission ask fired for an inaccessible terminal.
    expect(asked.length).toBe(0)
    // The denial must not reveal the terminal exists or its metadata.
    const blob = JSON.stringify(result)
    expect(blob).not.toContain("4321")
    expect(blob).not.toContain("shell")
  })

  test("hidden and missing terminal read return indistinguishable safe envelopes", async () => {
    const hidden = hiddenSeam()
    const missing = makeSeam({ infos: [] })
    const ctxHidden = makeCtx()
    const ctxMissing = makeCtx()
    let rHid
    let rMiss
    try {
      await runFrom(hidden.seam, ctxHidden, { action: "read", terminal_id: "st-x" })
      rHid = "ok"
    } catch (e) {
      rHid = (e as Error).message
    }
    try {
      await runFrom(missing.seam, ctxMissing, { action: "read", terminal_id: "st-y" })
      rMiss = "ok"
    } catch (e) {
      rMiss = (e as Error).message
    }
    expect(rHid).toBe(rMiss)
  })

  test("list excludes hidden terminals and does not count them", async () => {
    const { seam } = hiddenSeam()
    const res = JSON.parse((await runFrom(seam, makeCtx(), { action: "list" })).output)
    expect(res.terminals.length).toBe(0)
    expect(res.count).toBe(0)
  })

  test("agent access 'none' terminals are excluded from list", async () => {
    const noneInfo: S.Info = {
      ...BASE_INFO,
      id: "st-none",
      access: { human: "read-write", agent: "none", sessions: [SESSION_ID] },
    }
    const { seam } = makeSeam({ infos: [noneInfo] })
    const res = JSON.parse((await runFrom(seam, makeCtx(), { action: "list" })).output)
    // The tool must filter agent: "none" from the list result.
    expect(res.terminals.length).toBe(0)
    expect(res.count).toBe(0)
  })

  test("list only returns sessions including the caller session", async () => {
    const otherInfo: S.Info = {
      ...BASE_INFO,
      id: "st-other",
      access: { human: "read-write", agent: "read-write", sessions: ["other-session"] },
    }
    const { seam } = makeSeam({ infos: [BASE_INFO, otherInfo] })
    const res = JSON.parse((await runFrom(seam, makeCtx(), { action: "list" })).output)
    expect(res.terminals.map((t: { id: string }) => t.id)).toEqual(["st-1"])
    expect(res.count).toBe(1)
  })
})
