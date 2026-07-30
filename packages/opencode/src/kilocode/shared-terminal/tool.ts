// kilocode_change - new file
//
// The Kilo-only `terminal` tool: a strict discriminated-union over nine
// actions backed by the accepted SharedTerminalService. All authority context
// is derived from trusted runtime state (canonical current project/session,
// current Tool.Context, service-owned TerminalRef) — never from model input.
//
// Boundary order per terminal-specific action:
//   1. ACL check (project/session scope) BEFORE any permission prompt, so an
//      inaccessible terminal cannot be discovered via prompt side-channels.
//   2. ctx.ask() with the exact permission name + pattern, immediately before
//      the corresponding service operation. A denial produces zero service
//      mutation.
//   3. The service operation itself, using the trusted current TerminalRef.
//
// The tool never calls process.kill, Reap, taskkill, or any OS cleanup
// primitive directly. It routes through the service seam, which owns the
// generation-bound cleanup path. create launches only the preferred shell in
// the canonical instance directory; the model may control only optional
// title/cols/rows.

import z from "zod"
import stripAnsi from "strip-ansi"
import { Tool } from "../../tool/tool"
import { SharedTerminalSchema as S } from "./schema"
import { Instance } from "../../project/instance"
import { SharedTerminalService } from "./service"
import { SessionTerminal } from "./session"
import DESCRIPTION from "./tool.txt"

// Trusted caller context derived from runtime state. None of these fields come
// from model-controlled tool input.
export interface TerminalToolContext {
  projectID: string
  sessionID: string
  agent: string
  callID: string
  directory: string
  // Injected clock forwarded for lease semantics. Defaults to Date.now().
  now?: () => number
}

// Service-owned immutable ownership reference. The tool reconstructs this from
// the live service Info + the service's generation, never from input.
export interface ToolTerminalRef {
  readonly terminalID: string
  readonly generation: number
  readonly rootPID: number
  readonly platform: SharedTerminalService.Platform
}

export interface ReleaseInput {
  ref: ToolTerminalRef
  actor: Extract<S.Actor, { type: "agent" }>
  sessionID: string
  leaseID: string
  revision: number
}

export interface ReleaseResult {
  action: "release"
  success: boolean
  terminalID: string
  revision?: number
}

// The service seam the tool calls. Production wraps SharedTerminalService.
// Tests inject a deterministic implementation. The seam never accepts a
// model-supplied projectID/sessionID/actor/ref/rootPID/platform; trusted
// context is passed separately by the tool.
export interface TerminalToolService {
  listAccessibleSessions(input: { projectID: string; sessionID: string }): Promise<S.Info[]>
  createShellOnly(input: {
    projectID: string
    sessionID: string
    directory: string
    actor: S.Actor
    title: string
    cols: number
    rows: number
    accessSessions: string[]
  }): Promise<{ info: S.Info; ref: ToolTerminalRef }>
  readAgent(input: { ref: ToolTerminalRef; sessionID: string; cursor: number; maxBytes: number }): Promise<S.ReadResult>
  acquireLease(input: {
    ref: ToolTerminalRef
    actor: Extract<S.Actor, { type: "agent" }>
    sessionID: string
  }): Promise<S.Lease>
  releaseLease(input: ReleaseInput): Promise<ReleaseResult>
  writeAgent(input: {
    ref: ToolTerminalRef
    actor: Extract<S.Actor, { type: "agent" }>
    sessionID: string
    leaseID: string
    revision: number
    data: string
  }): Promise<{ action: "write"; success: boolean; terminalID: string; revision: number }>
  resize(input: {
    ref: ToolTerminalRef
    sessionID: string
    cols: number
    rows: number
  }): Promise<{ action: "resize"; success: boolean; terminalID: string; cols: number; rows: number }>
  interrupt(input: {
    ref: ToolTerminalRef
    actor: Extract<S.Actor, { type: "agent" }>
    sessionID: string
    leaseID: string
    revision: number
  }): Promise<{ action: "interrupt"; success: boolean; terminalID: string }>
  terminate(input: {
    ref: ToolTerminalRef
    sessionID: string
  }): Promise<{ action: "terminate"; success: boolean; terminalID: string }>
}

// ---- Strict action union schema -------------------------------------------------

// kilocode_change start - provider/tool-call adapter serializes numeric tool
// arguments as strings at the boundary (e.g. revision 0 -> "0"). Strict
// z.number() rejects the canonical decimal string form before execute() runs,
// so writes never reach the PTY. nonNegativeSafeIntegerArg accepts either the
// native number or its canonical non-negative decimal-string representation,
// normalizes to a JavaScript number, then re-validates as a safe integer. It
// deliberately does NOT use z.coerce.number(): that would accept malformed or
// ambiguous representations (exponents, hex, whitespace, fractions, Infinity,
// NaN). Only "0" or a non-zero digit followed by digits, up to
// Number.MAX_SAFE_INTEGER, is accepted.
const CANON_NON_NEG_DECIMAL = /^(0|[1-9][0-9]*)$/

export function nonNegativeSafeIntegerArg() {
  return z
    .union([z.number(), z.string().regex(CANON_NON_NEG_DECIMAL)])
    .transform((v) => (typeof v === "string" ? Number(v) : v))
    .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
}

// Dimension schema: accepts finite integers or digit-only numeric strings.
// Rejects empty string, whitespace, decimals, NaN, Infinity, negatives, and out-of-bounds.
const dimension = z
  .union([z.number().int().nonnegative().finite(), z.string().trim().regex(/^\d+$/)])
  .transform((v) => (typeof v === "string" ? parseInt(v, 10) : v))
  .pipe(z.number().int().min(1).max(1024))
// kilocode_change end

// kilocode_change start - execute-boundary revision normalization.
// The tool framework (Tool.define) validates args via `parameters.parse(args)`
// but discards the Zod transform output and invokes execute() with the ORIGINAL
// provider-shaped args. So when a provider serializes `revision: 0` as the
// string "0", the schema's nonNegativeSafeIntegerArg transform accepts it, but
// the value reaching execute() is still the string "0". The production adapter
// forwards that string straight into SharedTerminalService.writeAgent, whose
// second validation layer (LeaseState.validateRevision) rejects non-number
// revisions with "revision must be a non-negative safe integer" — so the write
// never reaches the PTY.
//
// requireNonNegativeSafeInteger is the runtime sibling of the schema normalizer.
// It is called inside execute() BEFORE any ACL construction, adapter call, or
// service call so the normalized number is the sole value forwarded downstream.
// It accepts exactly the same forms the schema accepts (native number or its
// canonical non-negative decimal string) and rejects the same malformed forms
// (negatives, decimals, exponents, whitespace, hex, leading-zero "01", empty,
// NaN, Infinity, > MAX_SAFE_INTEGER), guaranteeing schema/runtime parity even
// when the framework drops the Zod transform result.
export function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value === "number") {
    if (Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
      return value
    }
  } else if (typeof value === "string") {
    if (CANON_NON_NEG_DECIMAL.test(value)) {
      const n = Number(value)
      if (Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER) return n
    }
  }
  throw new Error(`${field} must be a non-negative safe integer`)
}
// kilocode_change end

const Input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("create"),
      title: z.string().min(1).max(256).optional(),
      cols: dimension.optional(),
      rows: dimension.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("read"),
      terminal_id: z.string().min(1).max(128),
      cursor: nonNegativeSafeIntegerArg().optional(),
      max_bytes: nonNegativeSafeIntegerArg()
        .pipe(
          z
            .number()
            .int()
            .min(1)
            .max(S.LIMITS.READ_MAX_BYTES * 4),
        )
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("lease"),
      terminal_id: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      action: z.literal("release"),
      terminal_id: z.string().min(1).max(128),
      lease_id: z.string().min(1).max(128),
      revision: nonNegativeSafeIntegerArg(),
    })
    .strict(),
  z
    .object({
      action: z.literal("write"),
      terminal_id: z.string().min(1).max(128),
      lease_id: z.string().min(1).max(128),
      revision: nonNegativeSafeIntegerArg(),
      // Coarse schema-level cap on JS string length; the tool re-validates the
      // UTF-8 encoded byte length inside execute before any service call.
      data: z.string().max(S.LIMITS.WRITE_MAX_BYTES * 4),
    })
    .strict(),
  z
    .object({
      action: z.literal("resize"),
      terminal_id: z.string().min(1).max(128),
      cols: dimension,
      rows: dimension,
    })
    .strict(),
  z
    .object({
      action: z.literal("interrupt"),
      terminal_id: z.string().min(1).max(128),
      lease_id: z.string().min(1).max(128),
      revision: nonNegativeSafeIntegerArg(),
    })
    .strict(),
  z
    .object({
      action: z.literal("terminate"),
      terminal_id: z.string().min(1).max(128),
    })
    .strict(),
])

export type TerminalToolInput = z.infer<typeof Input>

// ---- Helpers -------------------------------------------------------------------

// Sanitize model-visible terminal text:
//   1. strip ANSI CSI sequences
//   2. strip OSC sequences, including title and hyperlink sequences
//   3. remove remaining control characters except newline and tab
//   4. preserve ordinary Unicode text
// strip-ansi handles (1) and (2); the post-pass handles remaining control chars.
export function sanitize(untrusted: string): string {
  const stripped = stripAnsi(untrusted)
  let out = ""
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i)
    // Allow newline (0x0A), tab (0x09), and everything >= 0x20 (printable).
    if (code === 0x0a || code === 0x09 || code >= 0x20) out += stripped[i]
  }
  return out
}

// UTF-8 encoded byte length, NOT JavaScript string length.
function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

// A safe denial envelope that reveals no terminal existence/metadata. Used for
// BOTH missing and inaccessible terminals so the two are indistinguishable.
function safeAclDenial(
  action: string,
  terminalID: string,
): { title: string; metadata: Record<string, unknown>; output: string } {
  const env = {
    action,
    success: false,
    terminalID,
    code: "access_denied",
    message: "terminal not accessible",
  }
  return {
    title: `terminal ${action}`,
    metadata: { truncated: false, action, success: false, terminalID, code: "access_denied" },
    output: JSON.stringify(env),
  }
}

// Convert service Info to the agent-facing bounded list view. Strips shell,
// pid, title, generated/PID/process metadata. Keeps lifecycle + dimensions only.
function listView(i: S.Info): Record<string, unknown> {
  return {
    id: i.id,
    generation: i.generation,
    lifecycle: i.lifecycle,
    cols: i.cols,
    rows: i.rows,
    private: i.private,
    createdAt: i.createdAt,
    access: { agent: i.access.agent },
  }
}

// Build the trusted agent actor from runtime context.
function actor(ctx: TerminalToolContext): Extract<S.Actor, { type: "agent" }> {
  return { type: "agent", sessionID: ctx.sessionID, agentID: ctx.agent, callID: ctx.callID ? ctx.callID : "" }
}

// ---- Seam resolution -----------------------------------------------------------
//
// Production resolves the seam lazily from the shared-terminal InstanceState.
// Tests swap the seam via attachForTest(). The resolver is a side-effect-free
// function call; loading the tool module creates no route, command, PTY,
// ticket endpoint, or process.

let testSeam: TerminalToolService | undefined
let testCtx: TerminalToolContext | undefined

// kilocode_change start - trusted-session resolution must never silently
// default sessionID to "". A missing trusted session is a hard contract
// failure; returning a sentinel would let list/info silently drop every
// TUI-created terminal and let create spawn a second PTY. The live Tool.Context
// populates sessionID/agent/callID at execute() time; the static production
// context here only supplies the projectID + directory that never change
// across one tool invocation.
function resolveContext(): TerminalToolContext {
  if (testCtx) return testCtx
  return {
    projectID: Instance.project.id,
    sessionID: "", // filled from live Tool.Context in execute()
    agent: "",
    callID: "",
    directory: Instance.directory,
    now: () => Date.now(),
  }
}

// Typed denial envelope emitted when the trusted Tool.Context genuinely has
// no session ID. Distinct from ACL denial so the failure is diagnosable as a
// tool-context plumbing bug rather than an access decision.
function trustedContextDenied(action: string): {
  title: string
  metadata: Record<string, unknown>
  output: string
} {
  const env = {
    action,
    success: false,
    code: "trusted_context_missing",
    message: "terminal tool executed without a trusted session context",
  }
  return {
    title: `terminal ${action}`,
    metadata: { truncated: false, ...env },
    output: JSON.stringify(env),
  }
}

// Guarantee one non-empty trusted session ID for every mutating/inspection
// action. The model never supplies this value; it comes from the live
// Tool.Context. An empty/missing ID cannot discover the TUI terminal and
// could trigger a second PTY, so we fail closed instead.
function requireTrustedSessionID(ctx: TerminalToolContext): string | undefined {
  const id = ctx.sessionID
  if (!id || id.length === 0) return undefined
  return id
}
// kilocode_change end

async function resolveSeam(): Promise<TerminalServiceHandle> {
  if (testSeam) return { seam: testSeam, ctx: testCtx as TerminalToolContext }
  const svc = await getProductionService()
  return { seam: makeProductionAdapter(svc), ctx: resolveContext() }
}

interface TerminalServiceHandle {
  seam: TerminalToolService
  ctx: TerminalToolContext
}

// Production service access. Lives behind a lazy getter so the module never
// constructs a SharedTerminalService at import time (no process spawn on
// registry load).
async function getProductionService(): Promise<SharedTerminalService.Instance> {
  // The production SharedTerminalService Instance is created and scoped per
  // project by ST-04's wiring; the tool does not construct it. We import the
  // instance accessor lazily to avoid registering any side effect at module
  // load. If the service is not yet available, the tool fails closed.
  const mod = (await import("./service")) as unknown as {
    getSharedTerminalInstance?: () => Promise<SharedTerminalService.Instance>
  }
  if (!mod.getSharedTerminalInstance) {
    throw S.SharedTerminalError.create("terminal_missing", { message: "shared-terminal service not available" })
  }
  return mod.getSharedTerminalInstance()
}

// Production adapter wrapping the accepted SharedTerminalService.Instance. The
// adapter maps tool actions to service operations using the trusted current
// TerminalRef reconstructed from live Info. create always launches the
// preferred shell in the canonical instance directory.
function makeProductionAdapter(svc: SharedTerminalService.Instance): TerminalToolService {
  const platform = process.platform as SharedTerminalService.Platform
  const now = () => Date.now()
  return {
    async listAccessibleSessions(input) {
      const all = svc.list()
      return all.filter((i) => i.access.sessions.includes(input.sessionID) && i.access.agent !== "none")
    },
    async createShellOnly(input) {
      const r = await SessionTerminal.ensure({
        sessionID: input.sessionID,
        projectID: input.projectID,
        directory: input.directory,
        worktree: Instance.worktree,
        actor: input.actor,
        title: input.title || "shared",
        cols: input.cols || 80,
        rows: input.rows || 24,
      })
      return { info: r.info, ref: refOf(r.info, platform) }
    },
    async readAgent(input) {
      return svc.readAgent(input.ref.terminalID, { from: input.cursor, maxBytes: input.maxBytes })
    },
    async acquireLease(input) {
      return svc.acquireLease(input.ref.terminalID, {
        ref: serviceRef(input.ref),
        actor: input.actor,
        now: now(),
      })
    },
    async releaseLease(input) {
      await svc.releaseLease(input.ref.terminalID, {
        ref: serviceRef(input.ref),
        leaseID: input.leaseID,
        actor: input.actor,
        revision: input.revision,
      })
      return { action: "release", success: true, terminalID: input.ref.terminalID }
    },
    async writeAgent(input) {
      const maxBytes = S.LIMITS.WRITE_MAX_BYTES
      if (utf8Bytes(input.data) > maxBytes) {
        throw S.SharedTerminalError.create("write_too_large", {
          message: `write exceeds ${maxBytes} UTF-8 bytes`,
          terminalID: input.ref.terminalID,
        })
      }
      // Service performs final lease/generation/private-mode validation. The
      // write is committed only on success; otherwise the service throws.
      const lease = await svc.writeAgent(input.ref.terminalID, {
        ref: serviceRef(input.ref),
        leaseID: input.leaseID,
        revision: input.revision,
        actor: input.actor,
        data: input.data,
        now: now(),
      })
      return { action: "write", success: true, terminalID: input.ref.terminalID, revision: lease.revision }
    },
    async resize(input) {
      await svc.resize(input.ref.terminalID, serviceRef(input.ref), input.cols, input.rows)
      return { action: "resize", success: true, terminalID: input.ref.terminalID, cols: input.cols, rows: input.rows }
    },
    async interrupt(input) {
      await svc.interrupt(input.ref.terminalID, {
        ref: serviceRef(input.ref),
        leaseID: input.leaseID,
        revision: input.revision,
        actor: input.actor,
        now: now(),
      })
      return { action: "interrupt", success: true, terminalID: input.ref.terminalID }
    },
    async terminate(input) {
      await svc.terminate(input.ref.terminalID, serviceRef(input.ref))
      SessionTerminal.forget(input.sessionID, input.ref.terminalID, input.ref.generation)
      return { action: "terminate", success: true, terminalID: input.ref.terminalID }
    },
  }
}

// Reconstruct the service-side TerminalRef from the tool-side ref. The tool
// ref is derived from live service state, never from input.
function serviceRef(ref: ToolTerminalRef): SharedTerminalService.TerminalRef {
  return { terminalID: ref.terminalID, generation: ref.generation, rootPID: ref.rootPID, platform: ref.platform }
}

// Build a tool ref from a live Info. PID is read from service Info, not input.
function refOf(info: S.Info, platform: SharedTerminalService.Platform): ToolTerminalRef {
  return { terminalID: info.id, generation: info.generation, rootPID: info.pid, platform }
}

// ---- Tool definition -----------------------------------------------------------

function defineFor(seam: TerminalToolService | undefined): Tool.Info {
  return Tool.define("terminal", async () => {
    // Seam resolution is DEFERRED to execute() time so that init() never
    // constructs or accesses the production service (and never spawns a
    // process on registry load). Tests using the production TerminalTool
    // instance purely to inspect the schema therefore never touch the
    // production seam accessor.
    async function resolve(): Promise<TerminalServiceHandle> {
      if (seam) return { seam, ctx: testCtx as TerminalToolContext }
      if (testSeam) return { seam: testSeam, ctx: testCtx as TerminalToolContext }
      return resolveSeam()
    }
    return {
      description: DESCRIPTION,
      parameters: Input,
      async execute(args, ctx) {
        const handle = await resolve()
        // Trusted context merged with the live Tool.Context session/agent/callID.
        // Tool.Context is trusted runtime state; model input never overrides it.
        const live: TerminalToolContext = {
          projectID: handle.ctx.projectID,
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          callID: ctx.callID ? ctx.callID : "",
          directory: handle.ctx.directory,
          now: handle.ctx.now ? handle.ctx.now : () => Date.now(),
        }
        // kilocode_change start - trusted session binding. The model never
        // supplies sessionID; it must come from the live Tool.Context. A
        // missing trusted session fails closed before any service call so we
        // never silently drop every TUI-created terminal and never spawn a
        // second PTY from a sentinel "" id.
        const trustedSession = requireTrustedSessionID(live)
        if (!trustedSession) return trustedContextDenied(args.action)
        // kilocode_change end
        switch (args.action) {
          case "list": {
            await ctx.ask({
              permission: "terminal_discover",
              patterns: [live.projectID],
              always: [live.projectID],
              metadata: {},
            })
            const infos = await handle.seam.listAccessibleSessions({
              projectID: live.projectID,
              sessionID: trustedSession,
            })
            const visible = infos.filter((i) => i.access.sessions.includes(trustedSession) && i.access.agent !== "none")
            const env = {
              action: "list",
              success: true,
              count: visible.length,
              terminals: visible.map(listView),
            }
            return {
              title: `terminal list (${visible.length})`,
              metadata: { truncated: false, action: "list", success: true, count: visible.length },
              output: JSON.stringify(env),
            }
          }
          case "create": {
            // kilocode_change start - never spawn a second PTY when a TUI
            // terminal already exists for the trusted session. Reuse it and
            // return its existing terminalID/generation. This is the single
            // backing PTY guarantee: human TUI and agent share one terminal.
            // Skip the lookup on the test-injected seam path: those tests
            // model create in isolation and have no live Instance, so
            // SessionTerminal.current would throw on the missing context.
            if (!testSeam) {
              const existing = SessionTerminal.current(trustedSession)
              if (existing) {
                const env = {
                  action: "create",
                  success: true,
                  terminalID: existing.info.id,
                  generation: existing.info.generation,
                  terminal: {
                    id: existing.info.id,
                    generation: existing.info.generation,
                    cols: existing.info.cols,
                    rows: existing.info.rows,
                    lifecycle: existing.info.lifecycle,
                    access: { agent: existing.info.access.agent, sessions: existing.info.access.sessions },
                  },
                }
                return {
                  title: `terminal create ${existing.info.id}`,
                  metadata: {
                    truncated: false,
                    action: "create",
                    success: true,
                    terminalID: existing.info.id,
                    generation: existing.info.generation,
                  },
                  output: JSON.stringify(env),
                }
              }
            }
            // kilocode_change end
            await ctx.ask({
              permission: "terminal_create",
              patterns: [live.projectID],
              always: [live.projectID],
              metadata: {},
            })
            const r = await handle.seam.createShellOnly({
              projectID: live.projectID,
              sessionID: trustedSession,
              directory: live.directory,
              actor: actor(live),
              title: args.title ? args.title : "shared",
              cols: args.cols ? args.cols : 80,
              rows: args.rows ? args.rows : 24,
              accessSessions: [trustedSession],
            })
            const env = {
              action: "create",
              success: true,
              terminalID: r.info.id,
              generation: r.info.generation,
              terminal: {
                id: r.info.id,
                generation: r.info.generation,
                cols: r.info.cols,
                rows: r.info.rows,
                lifecycle: r.info.lifecycle,
                access: { agent: r.info.access.agent, sessions: r.info.access.sessions },
              },
            }
            return {
              title: `terminal create ${r.info.id}`,
              metadata: {
                truncated: false,
                action: "create",
                success: true,
                terminalID: r.info.id,
                generation: r.info.generation,
              },
              output: JSON.stringify(env),
            }
          }
          case "read": {
            const acl = await aclFor(handle.seam, args.terminal_id, live)
            if (!acl) return safeAclDenial("read", args.terminal_id)
            await ctx.ask({
              permission: "terminal_read",
              patterns: [`${live.projectID}/${args.terminal_id}`],
              always: [`${live.projectID}/${args.terminal_id}`],
              metadata: {},
            })
            const maxBytes =
              args.max_bytes !== undefined
                ? Math.min(args.max_bytes, S.LIMITS.READ_MAX_BYTES)
                : S.LIMITS.READ_DEFAULT_BYTES
            const result = await handle.seam.readAgent({
              ref: acl.ref,
              sessionID: trustedSession,
              cursor: args.cursor !== undefined ? args.cursor : acl.info.start,
              maxBytes,
            })
            const text = sanitize(result.text)
            const env = {
              action: "read",
              success: true,
              terminalID: result.terminalID,
              generation: acl.info.generation,
              untrusted: true,
              requested: result.requested,
              start: result.start,
              end: result.end,
              next: result.next,
              truncated: result.truncated || result.gap,
              privateBytes: result.privateBytes,
              eof: result.eof,
              gap: result.gap,
              gapStart: result.gapStart,
              gapEnd: result.gapEnd,
              text,
            }
            return {
              title: `terminal read ${result.terminalID}`,
              metadata: {
                truncated: result.truncated || result.gap,
                action: "read",
                success: true,
                terminalID: result.terminalID,
                generation: acl.info.generation,
                next: result.next,
                privateBytes: result.privateBytes,
                gap: result.gap,
              },
              output: JSON.stringify(env),
            }
          }
          case "lease": {
            const acl = await aclFor(handle.seam, args.terminal_id, live)
            if (!acl) return safeAclDenial("lease", args.terminal_id)
            await ctx.ask({
              permission: "terminal_write",
              patterns: [`${live.projectID}/${args.terminal_id}`],
              always: [`${live.projectID}/${args.terminal_id}`],
              metadata: {},
            })
            const lease = await handle.seam.acquireLease({
              ref: acl.ref,
              actor: actor(live),
              sessionID: trustedSession,
            })
            const env = {
              action: "lease",
              success: true,
              terminalID: lease.terminalID,
              generation: lease.generation,
              leaseID: lease.id,
              revision: lease.revision,
              acquiredAt: lease.acquiredAt,
              expiresAt: lease.expiresAt,
              maxAt: lease.maxAt,
            }
            return {
              title: `terminal lease ${lease.terminalID}`,
              metadata: {
                truncated: false,
                action: "lease",
                success: true,
                terminalID: lease.terminalID,
                leaseID: lease.id,
                revision: lease.revision,
              },
              output: JSON.stringify(env),
            }
          }
          case "release": {
            const acl = await aclFor(handle.seam, args.terminal_id, live)
            if (!acl) return safeAclDenial("release", args.terminal_id)
            await ctx.ask({
              permission: "terminal_write",
              patterns: [`${live.projectID}/${args.terminal_id}`],
              always: [`${live.projectID}/${args.terminal_id}`],
              metadata: {},
            })
            // kilocode_change - normalize revision at the execute boundary
            // BEFORE the adapter/service call. The tool framework does not
            // preserve the Zod transform output, so args.revision may still be
            // the provider-shaped string "0"; the service's second validation
            // layer rejects non-number revisions.
            const revision = requireNonNegativeSafeInteger(args.revision, "revision")
            const r = await handle.seam.releaseLease({
              ref: acl.ref,
              actor: actor(live),
              sessionID: trustedSession,
              leaseID: args.lease_id,
              revision,
            })
            const env = {
              action: "release",
              success: r.success,
              terminalID: r.terminalID,
              revision: r.revision,
            }
            return {
              title: `terminal release ${r.terminalID}`,
              metadata: { truncated: false, action: "release", success: r.success, terminalID: r.terminalID },
              output: JSON.stringify(env),
            }
          }
          case "write": {
            const acl = await aclFor(handle.seam, args.terminal_id, live)
            if (!acl) return safeAclDenial("write", args.terminal_id)
            const byteLen = utf8Bytes(args.data)
            if (byteLen > S.LIMITS.WRITE_MAX_BYTES) {
              return {
                title: "terminal write denied",
                metadata: {
                  truncated: false,
                  action: "write",
                  success: false,
                  code: "write_too_large",
                  bytes: byteLen,
                },
                output: JSON.stringify({ action: "write", success: false, code: "write_too_large", bytes: byteLen }),
              }
            }
            await ctx.ask({
              permission: "terminal_write",
              patterns: [`${live.projectID}/${args.terminal_id}`],
              always: [`${live.projectID}/${args.terminal_id}`],
              metadata: {},
            })
            // kilocode_change - normalize revision at the execute boundary
            // BEFORE the adapter/service call. See the release branch: the tool
            // framework discards the Zod transform output, so args.revision may
            // still be the provider-shaped string "0"; forwarding it unmodified
            // makes the service's second validation layer reject the write
            // before it reaches the PTY.
            const revision = requireNonNegativeSafeInteger(args.revision, "revision")
            const r = await handle.seam.writeAgent({
              ref: acl.ref,
              actor: actor(live),
              sessionID: trustedSession,
              leaseID: args.lease_id,
              revision,
              data: args.data,
            })
            const env = {
              action: "write",
              success: r.success,
              terminalID: r.terminalID,
              revision: r.revision,
              bytes: byteLen,
            }
            return {
              title: `terminal write ${r.terminalID}`,
              metadata: {
                truncated: false,
                action: "write",
                success: r.success,
                terminalID: r.terminalID,
                revision: r.revision,
                bytes: byteLen,
              },
              output: JSON.stringify(env),
            }
          }
          case "resize": {
            const acl = await aclFor(handle.seam, args.terminal_id, live)
            if (!acl) return safeAclDenial("resize", args.terminal_id)
            await ctx.ask({
              permission: "terminal_resize",
              patterns: [`${live.projectID}/${args.terminal_id}`],
              always: [`${live.projectID}/${args.terminal_id}`],
              metadata: {},
            })
            const r = await handle.seam.resize({
              ref: acl.ref,
              sessionID: trustedSession,
              cols: args.cols,
              rows: args.rows,
            })
            const env = { action: "resize", success: r.success, terminalID: r.terminalID, cols: r.cols, rows: r.rows }
            return {
              title: `terminal resize ${r.terminalID}`,
              metadata: {
                truncated: false,
                action: "resize",
                success: r.success,
                terminalID: r.terminalID,
                cols: r.cols,
                rows: r.rows,
              },
              output: JSON.stringify(env),
            }
          }
          case "interrupt": {
            const acl = await aclFor(handle.seam, args.terminal_id, live)
            if (!acl) return safeAclDenial("interrupt", args.terminal_id)
            await ctx.ask({
              permission: "terminal_interrupt",
              patterns: [`${live.projectID}/${args.terminal_id}`],
              always: [`${live.projectID}/${args.terminal_id}`],
              metadata: {},
            })
            // kilocode_change - normalize revision at the execute boundary
            // BEFORE the adapter/service call (same rationale as release/write).
            const revision = requireNonNegativeSafeInteger(args.revision, "revision")
            const r = await handle.seam.interrupt({
              ref: acl.ref,
              actor: actor(live),
              sessionID: trustedSession,
              leaseID: args.lease_id,
              revision,
            })
            const env = { action: "interrupt", success: r.success, terminalID: r.terminalID }
            return {
              title: `terminal interrupt ${r.terminalID}`,
              metadata: { truncated: false, action: "interrupt", success: r.success, terminalID: r.terminalID },
              output: JSON.stringify(env),
            }
          }
          case "terminate": {
            const acl = await aclFor(handle.seam, args.terminal_id, live)
            if (!acl) return safeAclDenial("terminate", args.terminal_id)
            await ctx.ask({
              permission: "terminal_terminate",
              patterns: [`${live.projectID}/${args.terminal_id}`],
              always: [`${live.projectID}/${args.terminal_id}`],
              metadata: {},
            })
            const r = await handle.seam.terminate({ ref: acl.ref, sessionID: trustedSession })
            const env = { action: "terminate", success: r.success, terminalID: r.terminalID }
            return {
              title: `terminal terminate ${r.terminalID}`,
              metadata: { truncated: false, action: "terminate", success: r.success, terminalID: r.terminalID },
              output: JSON.stringify(env),
            }
          }
        }
      },
    }
  })
}

// ACL lookup: returns the live Info + reconstructed trusted ref for the
// terminal if the caller session may access it, otherwise undefined. Performed
// BEFORE any permission prompt so an inaccessible terminal cannot be probed.
async function aclFor(
  svc: TerminalToolService,
  terminalID: string,
  ctx: TerminalToolContext,
): Promise<{ info: S.Info; ref: ToolTerminalRef } | undefined> {
  const infos = await svc.listAccessibleSessions({ projectID: ctx.projectID, sessionID: ctx.sessionID })
  const info = infos.find(
    (i) => i.id === terminalID && i.access.sessions.includes(ctx.sessionID) && i.access.agent !== "none",
  )
  if (!info) return undefined
  // platform is derived from runtime, never from input.
  const ref = refOf(info, process.platform as SharedTerminalService.Platform)
  return { info, ref }
}

// The production-bound tool instance. The registry imports this when the flag
// is enabled. Loading this module creates NO process, route, ticket, command,
// or service — the production seam is resolved lazily on first execute().
//
// attachForTest is an opt-in escape hatch for unit tests to inject a
// deterministic seam. It is NOT part of the production tool surface: it
// returns a fresh Tool.Info bound to the injected seam without touching the
// production-bound TerminalTool instance.
// Reset test-only seam/context. Called by attachForTest and by a teardown
// hook between tests so production resolution remains untouched.
function clearTestSeam(): void {
  testSeam = undefined
  testCtx = undefined
}

export const TerminalTool: Tool.Info & {
  attachForTest(seam: TerminalToolService, ctx: TerminalToolContext): Tool.Info
  resetForTest(): void
} = (() => {
  const production = defineFor(undefined) as Tool.Info & {
    attachForTest(seam: TerminalToolService, ctx: TerminalToolContext): Tool.Info
    resetForTest(): void
  }
  // attachForTest seeds module-level test vars so defineFor(seam) resolves
  // the trusted context without touching the production service accessor.
  // It does NOT mutate the production-bound TerminalTool instance; it returns
  // a fresh Tool.Info bound to the injected seam + context.
  production.attachForTest = (seam: TerminalToolService, ctx: TerminalToolContext): Tool.Info => {
    testSeam = seam
    testCtx = ctx
    return defineFor(seam)
  }
  production.resetForTest = clearTestSeam
  return production
})()
