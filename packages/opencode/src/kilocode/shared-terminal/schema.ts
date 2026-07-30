import z from "zod"

// Schema, constants, and structured errors for the Kilo-only shared-terminal
// service. This file defines the wire contract only; it owns no state,
// performs no IO, and depends only on zod. Offsets, dimensions, TTLs, and
// generation tokens are validated as bounded safe integers so that cursor
// arithmetic can never wrap silently.

export namespace SharedTerminalSchema {
  export const PROTOCOL_VERSION = 1 as const

  export const LIMITS = {
    RING_BYTES: 8 * 1024 * 1024,
    SUBSCRIBER_BYTES: 1024 * 1024,
    READ_DEFAULT_BYTES: 8 * 1024,
    READ_MAX_BYTES: 32 * 1024,
    WRITE_MAX_BYTES: 8 * 1024,
    TICKET_TTL_MS: 30_000,
    LEASE_IDLE_MS: 15_000,
    LEASE_MAX_MS: 60_000,
  } as const

  // Safe non-negative integer. Guarded strictly against fractional, infinite,
  // NaN, and overflow past Number.MAX_SAFE_INTEGER so byte cursors cannot drift.
  const safeNonNegInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

  export const Offset = {
    zod: safeNonNegInt,
  }
  export type Offset = number

  export const TerminalID = {
    zod: z.string().min(1).max(128),
  }
  export type TerminalID = string

  export const Actor = {
    zod: z.discriminatedUnion("type", [
      z.object({ type: z.literal("human"), clientID: z.string().min(1).max(128) }),
      z.object({
        type: z.literal("agent"),
        sessionID: z.string().min(1).max(128),
        agentID: z.string().min(1).max(128),
        callID: z.string().min(1).max(128),
      }),
      z.object({
        type: z.literal("system"),
        reason: z.enum(["create", "exit", "dispose", "timeout"]),
      }),
    ]),
  }
  export type Actor = z.infer<typeof Actor.zod>

  export const Scope = {
    zod: z.object({
      projectID: z.string().min(1).max(128),
      directory: z.string().min(1),
      worktree: z.string().min(1),
    }),
  }
  export type Scope = z.infer<typeof Scope.zod>

  export const Access = {
    zod: z.object({
      human: z.literal("read-write"),
      agent: z.enum(["none", "read", "read-write"]),
      sessions: z.array(z.string().min(1).max(128)),
    }),
  }
  export type Access = z.infer<typeof Access.zod>

  export const Lifecycle = {
    zod: z.enum(["starting", "running", "exited", "terminating", "terminated", "failed"]),
  }
  export type Lifecycle = z.infer<typeof Lifecycle.zod>

  export const Cleanup = {
    zod: z.enum(["pending", "cleaning", "cleaned", "cleanup_failed"]),
  }
  export type Cleanup = z.infer<typeof Cleanup.zod>

  export const Info = {
    zod: z.object({
      id: TerminalID.zod,
      generation: safeNonNegInt,
      title: z.string().min(1).max(256),
      shell: z.string().min(1).max(256),
      pid: z.number().int(),
      scope: Scope.zod,
      access: Access.zod,
      lifecycle: Lifecycle.zod,
      cleanup: Cleanup.zod,
      cols: safeNonNegInt,
      rows: safeNonNegInt,
      start: Offset.zod,
      end: Offset.zod,
      private: z.boolean(),
      createdBy: Actor.zod,
      createdAt: safeNonNegInt,
      exitedAt: safeNonNegInt.optional(),
      exitCode: z.number().int().optional(),
    }),
  }
  export type Info = z.infer<typeof Info.zod>

  export const Chunk = {
    zod: z
      .object({
        start: Offset.zod,
        end: Offset.zod,
        visibility: z.enum(["shared", "human"]),
        bytes: z.instanceof(Uint8Array),
      })
      .refine((c) => c.end >= c.start, { message: "end must not precede start" })
      .refine((c) => c.end - c.start === c.bytes.length, {
        message: "end - start must equal bytes.length",
      }),
  }
  export type Chunk = z.infer<typeof Chunk.zod>

  export const ReadResult = {
    zod: z
      .object({
        terminalID: TerminalID.zod,
        requested: Offset.zod,
        start: Offset.zod,
        end: Offset.zod,
        next: Offset.zod,
        truncated: z.boolean(),
        privateBytes: safeNonNegInt,
        eof: z.boolean(),
        text: z.string(),
        // Gap metadata is part of the public read contract so a stale cursor can
        // never silently masquerade as a complete result. A non-gap result must
        // carry no gap fields; a gap result must carry both span ends ordered.
        gap: z.boolean().default(false),
        gapStart: Offset.zod.optional(),
        gapEnd: Offset.zod.optional(),
      })
      .refine((r) => r.next >= r.requested, { message: "next must not precede requested" })
      .refine((r) => r.end >= r.start, { message: "end must not precede start" })
      .refine((r) => r.next === r.end, { message: "next must equal end (absolute consumed cursor)" })
      .refine(
        (r) =>
          r.gap
            ? r.gapStart !== undefined && r.gapEnd !== undefined && r.gapEnd >= r.gapStart
            : r.gapStart === undefined && r.gapEnd === undefined,
        { message: "gap metadata must be absent when gap is false and complete+ordered when true" },
      ),
  }
  export type ReadResult = z.infer<typeof ReadResult.zod>

  export const Lease = {
    // A lease grants exclusive agent input authority; its actor is agent-only.
    // Re-declaring the agent shape (rather than intersecting the union) keeps
    // the schema strict even if the Actor union later grows.
    zod: z.object({
      id: z.string().min(1).max(128),
      terminalID: TerminalID.zod,
      generation: safeNonNegInt,
      actor: z.object({
        type: z.literal("agent"),
        sessionID: z.string().min(1).max(128),
        agentID: z.string().min(1).max(128),
        callID: z.string().min(1).max(128),
      }),
      revision: safeNonNegInt,
      acquiredAt: safeNonNegInt,
      expiresAt: safeNonNegInt,
      maxAt: safeNonNegInt,
    }),
  }
  export type Lease = z.infer<typeof Lease.zod>

  // Ticket digest is exactly 64 lowercase hex chars (SHA-256). The raw ticket
  // value is never stored or logged; only its digest lives in state.
  export const Ticket = {
    zod: z.object({
      terminalID: TerminalID.zod,
      generation: safeNonNegInt,
      projectID: z.string().min(1).max(128),
      mode: z.enum(["read", "write"]),
      digest: z.string().regex(/^[0-9a-f]{64}$/, "digest must be lowercase sha-256 hex"),
      expiresAt: safeNonNegInt,
      usedAt: safeNonNegInt.optional(),
    }),
  }
  export type Ticket = z.infer<typeof Ticket.zod>

  export const AuditReason = {
    zod: z.enum([
      "acl_denied",
      "permission_denied",
      "ticket_invalid",
      "ticket_expired",
      "ticket_reused",
      "lease_missing",
      "lease_stale",
      "lease_expired",
      "human_preempted",
      "private_mode",
      "subscriber_slow",
      "process_exit",
      "instance_dispose",
      "cleanup_failed",
    ]),
  }
  export type AuditReason = z.infer<typeof AuditReason.zod>

  export const AuditEvent = {
    zod: z.object({
      id: z.string().min(1).max(128),
      terminalID: TerminalID.zod,
      generation: safeNonNegInt,
      revision: safeNonNegInt,
      time: safeNonNegInt,
      actor: Actor.zod,
      action: z.enum([
        "create",
        "attach",
        "detach",
        "read",
        "lease.acquire",
        "lease.release",
        "lease.revoke",
        "write",
        "resize",
        "private.begin",
        "private.end",
        "interrupt",
        "terminate",
        "exit",
        "cleanup",
      ]),
      outcome: z.enum(["applied", "rejected", "failed"]),
      bytes: safeNonNegInt.optional(),
      correlationID: z.string().min(1).max(128).optional(),
      reason: AuditReason.zod.optional(),
    }),
  }
  export type AuditEvent = z.infer<typeof AuditEvent.zod>

  // Structured, zod-validated error. The error object itself is the canonical
  // transport; consumers can re-parse via SharedTerminalError.Schema.
  const ErrorCode = z.enum([
    "terminal_missing",
    "terminal_disposed",
    "offset_overflow",
    "ring_corrupted",
    "read_out_of_range",
    "write_too_large",
    "ticket_invalid",
    "ticket_expired",
    "ticket_reused",
    "lease_missing",
    "lease_stale",
    "lease_expired",
    "acl_denied",
    "permission_denied",
    "subscriber_slow",
    "private_mode",
    "cleanup_failed",
  ])
  export type ErrorCode = z.infer<typeof ErrorCode>

  const ErrorBody = z.object({
    name: z.literal("SharedTerminalError"),
    code: ErrorCode,
    message: z.string(),
    terminalID: TerminalID.zod.optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })

  export class SharedTerminalError extends Error {
    code: ErrorCode
    terminalID?: string
    constructor(code: ErrorCode, message: string, terminalID?: string) {
      super(message)
      this.name = "SharedTerminalError"
      this.code = code
      if (terminalID !== undefined) this.terminalID = terminalID
    }

    static readonly Schema = ErrorBody

    static create(code: ErrorCode, opts: { message: string; terminalID?: string }): SharedTerminalError {
      return new SharedTerminalError(code, opts.message, opts.terminalID)
    }

    // Typed code accessor typed against the schema body, avoiding a
    // self-referential class-name in its own parameter signature.
    static code(e: { code: ErrorCode }): ErrorCode {
      return e.code
    }
  }
  // Accessed as SharedTerminalSchema.SharedTerminalErrorSchema when callers
  // need the zod body shape; the class above is the canonical error object.
  export namespace SharedTerminalErrorSchema {
    export const Body = ErrorBody
  }
}

// Top-level re-exports for ergonomic import-by-name (the namespace keeps the
// canonical grouping; these mirrors are the public flat surface used by the
// buffer, service, tool, route, and tests).
export const PROTOCOL_VERSION = SharedTerminalSchema.PROTOCOL_VERSION
export const LIMITS = SharedTerminalSchema.LIMITS
export const Offset = SharedTerminalSchema.Offset
export const TerminalID = SharedTerminalSchema.TerminalID
export const Actor = SharedTerminalSchema.Actor
export type Actor = typeof SharedTerminalSchema.Actor.zod._output
export const Scope = SharedTerminalSchema.Scope
export const Access = SharedTerminalSchema.Access
export const Lifecycle = SharedTerminalSchema.Lifecycle
export const Cleanup = SharedTerminalSchema.Cleanup
export const Info = SharedTerminalSchema.Info
export const Chunk = SharedTerminalSchema.Chunk
export const ReadResult = SharedTerminalSchema.ReadResult
export const Lease = SharedTerminalSchema.Lease
export const Ticket = SharedTerminalSchema.Ticket
export const AuditReason = SharedTerminalSchema.AuditReason
export const AuditEvent = SharedTerminalSchema.AuditEvent
// Re-export the error class so callers can import it by name. The namespace's
// own binding isn't a module-level export, so we surface it through a const
// alias that shares the identity.
export const SharedTerminalError = SharedTerminalSchema.SharedTerminalError
export type SharedTerminalError = InstanceType<typeof SharedTerminalSchema.SharedTerminalError>
