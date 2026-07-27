import { test, expect, describe } from "bun:test"
import { z } from "zod"

import {
  SharedTerminalSchema as Schema,
  PROTOCOL_VERSION,
  LIMITS,
  Offset,
  TerminalID,
  Actor,
  Scope,
  Access,
  Lifecycle,
  Cleanup,
  Info,
  Chunk,
  ReadResult,
  Lease,
  Ticket,
  AuditReason,
  AuditEvent,
  SharedTerminalError,
} from "../../src/kilocode/shared-terminal/schema"

describe("SharedTerminalSchema constants", () => {
  test("protocol version is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })

  test("limits match the implementation contract exactly", () => {
    expect(LIMITS.RING_BYTES).toBe(8 * 1024 * 1024)
    expect(LIMITS.SUBSCRIBER_BYTES).toBe(1024 * 1024)
    expect(LIMITS.READ_DEFAULT_BYTES).toBe(8 * 1024)
    expect(LIMITS.READ_MAX_BYTES).toBe(32 * 1024)
    expect(LIMITS.WRITE_MAX_BYTES).toBe(8 * 1024)
    expect(LIMITS.TICKET_TTL_MS).toBe(30_000)
    expect(LIMITS.LEASE_IDLE_MS).toBe(15_000)
    expect(LIMITS.LEASE_MAX_MS).toBe(60_000)
  })

  test("offset schema only accepts safe non-negative integers", () => {
    expect(Offset.zod.safeParse(0).success).toBe(true)
    expect(Offset.zod.safeParse(1).success).toBe(true)
    expect(Offset.zod.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true)
    expect(Offset.zod.safeParse(-1).success).toBe(false)
    expect(Offset.zod.safeParse(1.5).success).toBe(false)
    expect(Offset.zod.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false)
    expect(Offset.zod.safeParse(Infinity).success).toBe(false)
    expect(Offset.zod.safeParse(NaN).success).toBe(false)
  })

  test("terminal id schema accepts non-empty bounded strings", () => {
    expect(TerminalID.zod.safeParse("t-001").success).toBe(true)
    expect(TerminalID.zod.safeParse("").success).toBe(false)
    expect(TerminalID.zod.safeParse("x".repeat(128)).success).toBe(true)
    expect(TerminalID.zod.safeParse("x".repeat(129)).success).toBe(false)
  })
})

describe("SharedTerminalSchema actor union", () => {
  test("human actor validates", () => {
    const r = Actor.zod.safeParse({ type: "human", clientID: "c1" })
    expect(r.success).toBe(true)
  })

  test("agent actor validates", () => {
    const r = Actor.zod.safeParse({
      type: "agent",
      sessionID: "s1",
      agentID: "a1",
      callID: "k1",
    })
    expect(r.success).toBe(true)
  })

  test("system actor validates for each reason", () => {
    for (const reason of ["create", "exit", "dispose", "timeout"] as const) {
      const r = Actor.zod.safeParse({ type: "system", reason })
      expect(r.success).toBe(true)
    }
  })

  test("unknown actor type is rejected", () => {
    expect(Actor.zod.safeParse({ type: "other" }).success).toBe(false)
  })

  test("system actor rejects unknown reason", () => {
    expect(Actor.zod.safeParse({ type: "system", reason: "bogus" }).success).toBe(false)
  })

  test("agent actor rejects missing fields", () => {
    expect(Actor.zod.safeParse({ type: "agent", sessionID: "s1" }).success).toBe(false)
  })
})

describe("SharedTerminalSchema scope and access", () => {
  test("scope validates", () => {
    const r = Scope.zod.safeParse({
      projectID: "p1",
      directory: "/repo",
      worktree: "/repo/.wt/1",
    })
    expect(r.success).toBe(true)
  })

  test("access validates read-write human and bounded agent", () => {
    const r = Access.zod.safeParse({ human: "read-write", agent: "read-write", sessions: ["s1"] })
    expect(r.success).toBe(true)
  })

  test("access agent none validates", () => {
    expect(Access.zod.safeParse({ human: "read-write", agent: "none", sessions: [] }).success).toBe(true)
  })

  test("access rejects invalid human mode", () => {
    expect(Access.zod.safeParse({ human: "read", agent: "none", sessions: [] }).success).toBe(false)
  })

  test("access rejects invalid agent mode", () => {
    expect(Access.zod.safeParse({ human: "read-write", agent: "admin", sessions: [] }).success).toBe(false)
  })
})

describe("SharedTerminalSchema lifecycle and cleanup", () => {
  test("lifecycle enumerates phases", () => {
    for (const v of ["starting", "running", "exited", "terminating", "terminated", "failed"]) {
      expect(Lifecycle.zod.safeParse(v).success).toBe(true)
    }
    expect(Lifecycle.zod.safeParse("idle").success).toBe(false)
  })

  test("cleanup enumerates states", () => {
    for (const v of ["pending", "cleaning", "cleaned", "cleanup_failed"]) {
      expect(Cleanup.zod.safeParse(v).success).toBe(true)
    }
    expect(Cleanup.zod.safeParse("pending").success).toBe(true)
  })
})

describe("SharedTerminalSchema info", () => {
  const base = {
    id: "t-001",
    generation: 1,
    title: "term",
    shell: "pwsh",
    pid: 1234,
    scope: { projectID: "p1", directory: "/repo", worktree: "/repo/.wt/1" },
    access: { human: "read-write", agent: "read-write", sessions: ["s1"] },
    lifecycle: "running",
    cleanup: "pending",
    cols: 80,
    rows: 24,
    start: 0,
    end: 100,
    private: false,
    createdBy: { type: "human", clientID: "c1" },
    createdAt: 1_000,
  }

  test("info validates with required fields and no exit fields", () => {
    const r = Info.zod.safeParse(base)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.exitedAt).toBeUndefined()
      expect(r.data.exitCode).toBeUndefined()
    }
  })

  test("info validates with optional exit fields", () => {
    const r = Info.zod.safeParse({ ...base, exitedAt: 2_000, exitCode: 0 })
    expect(r.success).toBe(true)
  })

  test("info rejects non-safe-integer generation", () => {
    expect(Info.zod.safeParse({ ...base, generation: 1.5 }).success).toBe(false)
  })

  test("info rejects negative offsets", () => {
    expect(Info.zod.safeParse({ ...base, start: -1 }).success).toBe(false)
  })
})

describe("SharedTerminalSchema chunk", () => {
  test("chunk validates with shared visibility and bytes", () => {
    const r = Chunk.zod.safeParse({
      start: 0,
      end: 5,
      visibility: "shared",
      bytes: new Uint8Array([104, 101, 108, 108, 111]),
    })
    expect(r.success).toBe(true)
  })

  test("chunk validates with human visibility", () => {
    const r = Chunk.zod.safeParse({
      start: 5,
      end: 8,
      visibility: "human",
      bytes: new Uint8Array([1, 2, 3]),
    })
    expect(r.success).toBe(true)
  })

  test("chunk rejects end before start", () => {
    expect(
      Chunk.zod.safeParse({
        start: 5,
        end: 4,
        visibility: "shared",
        bytes: new Uint8Array(),
      }).success,
    ).toBe(false)
  })

  test("chunk rejects unknown visibility", () => {
    expect(Chunk.zod.safeParse({ start: 0, end: 1, visibility: "secret", bytes: new Uint8Array() }).success).toBe(false)
  })

  test("chunk requires end - start === bytes.length", () => {
    // 3 bytes but end-start = 2 -> reject.
    expect(
      Chunk.zod.safeParse({
        start: 0,
        end: 2,
        visibility: "shared",
        bytes: new Uint8Array([1, 2, 3]),
      }).success,
    ).toBe(false)
    // Matching length -> accept.
    expect(
      Chunk.zod.safeParse({
        start: 5,
        end: 8,
        visibility: "shared",
        bytes: new Uint8Array([1, 2, 3]),
      }).success,
    ).toBe(true)
    // Zero-length chunk -> accept (end === start).
    expect(Chunk.zod.safeParse({ start: 4, end: 4, visibility: "human", bytes: new Uint8Array() }).success).toBe(true)
    // Zero-length but end < start -> reject.
    expect(Chunk.zod.safeParse({ start: 4, end: 3, visibility: "human", bytes: new Uint8Array() }).success).toBe(false)
  })
})

describe("SharedTerminalSchema read result", () => {
  const base = {
    terminalID: "t-001",
    requested: 0,
    start: 0,
    end: 5,
    next: 5,
    truncated: false,
    privateBytes: 0,
    eof: false,
    text: "hello",
  }

  test("read result validates", () => {
    expect(ReadResult.zod.safeParse(base).success).toBe(true)
  })

  test("read result validates with eof true", () => {
    expect(ReadResult.zod.safeParse({ ...base, eof: true }).success).toBe(true)
  })

  test("read result validates with truncated true", () => {
    expect(ReadResult.zod.safeParse({ ...base, truncated: true }).success).toBe(true)
  })

  test("read result rejects next before requested when not truncated", () => {
    // next must not precede requested; we assert the invariant via refine below
    const r = ReadResult.zod.safeParse({ ...base, next: base.requested - 1 })
    // next<requested is structurally invalid only when asserted by schema;
    // we require the schema to reject it.
    expect(r.success).toBe(false)
  })

  test("read result requires next === end for a successful (non-gap, non-truncated) read", () => {
    // start <= end already enforced; next must equal end when the read is the
    // canonical consumed-window result.
    expect(ReadResult.zod.safeParse({ ...base, next: base.end - 1 }).success).toBe(false)
    expect(ReadResult.zod.safeParse({ ...base, end: base.next, next: base.next }).success).toBe(true)
  })

  test("read result requires start <= end", () => {
    expect(ReadResult.zod.safeParse({ ...base, start: base.end + 1 }).success).toBe(false)
  })

  test("gap metadata is absent when gap is false", () => {
    // A non-gap result must not carry gap fields.
    expect(ReadResult.zod.safeParse({ ...base, gap: false, gapStart: 0, gapEnd: 0 }).success).toBe(false)
    // Without gap metadata, gap:false validates.
    expect(ReadResult.zod.safeParse({ ...base, gap: false }).success).toBe(true)
  })

  test("gap metadata is complete and ordered when gap is true", () => {
    // gap without gapStart -> reject
    expect(ReadResult.zod.safeParse({ ...base, gap: true, gapEnd: 0 }).success).toBe(false)
    // gap without gapEnd -> reject
    expect(ReadResult.zod.safeParse({ ...base, gap: true, gapStart: 0 }).success).toBe(false)
    // gap with gapStart > gapEnd -> reject
    expect(ReadResult.zod.safeParse({ ...base, gap: true, gapStart: 5, gapEnd: 3 }).success).toBe(false)
    // gap complete and ordered -> accept
    expect(ReadResult.zod.safeParse({ ...base, gap: true, gapStart: 0, gapEnd: 2 }).success).toBe(true)
  })
})

describe("SharedTerminalSchema lease", () => {
  const base = {
    id: "l1",
    terminalID: "t-001",
    generation: 1,
    actor: { type: "agent", sessionID: "s1", agentID: "a1", callID: "k1" },
    revision: 0,
    acquiredAt: 1_000,
    expiresAt: 2_000,
    maxAt: 3_000,
  }

  test("lease validates", () => {
    expect(Lease.zod.safeParse(base).success).toBe(true)
  })

  test("lease rejects negative revision", () => {
    expect(Lease.zod.safeParse({ ...base, revision: -1 }).success).toBe(false)
  })

  test("lease actor accepts only an agent actor", () => {
    // Human actor -> reject (leases are agent-only).
    expect(Lease.zod.safeParse({ ...base, actor: { type: "human", clientID: "c1" } }).success).toBe(false)
    // System actor -> reject.
    expect(Lease.zod.safeParse({ ...base, actor: { type: "system", reason: "create" } }).success).toBe(false)
    // Agent actor -> accept (the base).
    expect(Lease.zod.safeParse(base).success).toBe(true)
  })
})

describe("SharedTerminalSchema ticket", () => {
  test("ticket validates with lowercase 64-char hex digest", () => {
    const r = Ticket.zod.safeParse({
      terminalID: "t-001",
      generation: 1,
      projectID: "p1",
      mode: "write",
      digest: "0".repeat(64),
      expiresAt: 1_000,
    })
    expect(r.success).toBe(true)
  })

  test("ticket validates read mode", () => {
    expect(
      Ticket.zod.safeParse({
        terminalID: "t-001",
        generation: 1,
        projectID: "p1",
        mode: "read",
        digest: "a".repeat(64),
        expiresAt: 1_000,
      }).success,
    ).toBe(true)
  })

  test("ticket rejects uppercase hex digest", () => {
    expect(
      Ticket.zod.safeParse({
        terminalID: "t-001",
        generation: 1,
        projectID: "p1",
        mode: "write",
        digest: "A".repeat(64),
        expiresAt: 1_000,
      }).success,
    ).toBe(false)
  })

  test("ticket rejects non-hex digest", () => {
    expect(
      Ticket.zod.safeParse({
        terminalID: "t-001",
        generation: 1,
        projectID: "p1",
        mode: "write",
        digest: "g".repeat(64),
        expiresAt: 1_000,
      }).success,
    ).toBe(false)
  })

  test("ticket rejects wrong-length digest", () => {
    expect(
      Ticket.zod.safeParse({
        terminalID: "t-001",
        generation: 1,
        projectID: "p1",
        mode: "write",
        digest: "0".repeat(63),
        expiresAt: 1_000,
      }).success,
    ).toBe(false)
  })

  test("ticket rejects unknown mode", () => {
    expect(
      Ticket.zod.safeParse({
        terminalID: "t-001",
        generation: 1,
        projectID: "p1",
        mode: "admin",
        digest: "0".repeat(64),
        expiresAt: 1_000,
      }).success,
    ).toBe(false)
  })

  test("ticket accepts optional usedAt", () => {
    expect(
      Ticket.zod.safeParse({
        terminalID: "t-001",
        generation: 1,
        projectID: "p1",
        mode: "write",
        digest: "0".repeat(64),
        expiresAt: 1_000,
        usedAt: 999,
      }).success,
    ).toBe(true)
  })
})

describe("SharedTerminalSchema audit", () => {
  test("audit reason enumerates all reasons", () => {
    const reasons = [
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
    ]
    for (const r of reasons) {
      expect(AuditReason.zod.safeParse(r).success).toBe(true)
    }
    expect(AuditReason.zod.safeParse("unknown").success).toBe(false)
  })

  test("audit event validates with required fields", () => {
    const r = AuditEvent.zod.safeParse({
      id: "e1",
      terminalID: "t-001",
      generation: 1,
      revision: 0,
      time: 1_000,
      actor: { type: "human", clientID: "c1" },
      action: "write",
      outcome: "applied",
      bytes: 10,
    })
    expect(r.success).toBe(true)
  })

  test("audit event validates with reason and correlationID", () => {
    expect(
      AuditEvent.zod.safeParse({
        id: "e2",
        terminalID: "t-001",
        generation: 1,
        revision: 0,
        time: 1_000,
        actor: { type: "system", reason: "exit" },
        action: "cleanup",
        outcome: "failed",
        reason: "cleanup_failed",
        correlationID: "corr-1",
      }).success,
    ).toBe(true)
  })

  test("audit event rejects unknown action", () => {
    expect(
      AuditEvent.zod.safeParse({
        id: "e3",
        terminalID: "t-001",
        generation: 1,
        revision: 0,
        time: 1_000,
        actor: { type: "human", clientID: "c1" },
        action: "bogus",
        outcome: "applied",
      }).success,
    ).toBe(false)
  })

  test("audit event rejects unknown outcome", () => {
    expect(
      AuditEvent.zod.safeParse({
        id: "e4",
        terminalID: "t-001",
        generation: 1,
        revision: 0,
        time: 1_000,
        actor: { type: "human", clientID: "c1" },
        action: "read",
        outcome: "maybe",
      }).success,
    ).toBe(false)
  })
})

describe("SharedTerminalSchema structured errors", () => {
  test("error factory carries code, message, and terminal id", () => {
    const e = SharedTerminalError.create("terminal_missing", {
      terminalID: "t-001",
      message: "no such terminal",
    })
    expect(e.name).toBe("SharedTerminalError")
    expect(e.terminalID).toBe("t-001")
    expect(e.message).toBe("no such terminal")
    expect(typeof SharedTerminalError.code(e)).toBe("string")
  })

  test("error round-trips through zod", () => {
    const e = SharedTerminalError.create("offset_overflow", {
      terminalID: "t-001",
      message: "offset overflow",
    })
    const parsed = SharedTerminalError.Schema.safeParse(e)
    expect(parsed.success).toBe(true)
  })
})
