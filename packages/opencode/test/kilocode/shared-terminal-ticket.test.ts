import { test, expect, describe } from "bun:test"
import { TicketState } from "../../src/kilocode/shared-terminal/ticket"
import { LIMITS, Ticket } from "../../src/kilocode/shared-terminal/schema"

const terminalID = "t-001"
const generation = 1
const projectID = "p1"

// Deterministic injected randomness: a fixed 32-byte source repeated.
function fixedRandomSource(seed: number): () => Uint8Array {
  let calls = 0
  return () => {
    calls++
    const out = new Uint8Array(32)
    for (let i = 0; i < 32; i++) out[i] = (seed + calls + i) % 256
    return out
  }
}

function sha256Hex(input: string): string {
  // Synchronous SHA-256 via Bun for test verification.
  const bytes = new TextEncoder().encode(input)
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(bytes)
  return Buffer.from(hash.digest()).toString("hex")
}

// Produce `count` bytes starting at `start`, each modulo 256 (deterministic,
// matches the crypto.getRandomValues spy used below).
function rangeBytes(start: number, count: number): Uint8Array {
  const out = new Uint8Array(count)
  for (let i = 0; i < count; i++) out[i] = (start + i) % 256
  return out
}

// base64url of a byte array (no padding), mirroring ticket.ts.
function base64urlOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

// Error-evidence helper: catches a thrown error and asserts its exact .code.
function expectErrorCode(code: string, fn: () => unknown): void {
  let threw = false
  let err: unknown
  try {
    fn()
  } catch (e) {
    threw = true
    err = e
  }
  expect(threw).toBe(true)
  expect(typeof err === "object" && err !== null && (err as { code?: unknown }).code === code).toBe(true)
}

describe("TicketState: issue", () => {
  test("exact 32-byte random source", () => {
    let captured: Uint8Array | undefined
    const state = new TicketState({
      random: () => {
        const b = new Uint8Array(32)
        for (let i = 0; i < 32; i++) b[i] = i + 1
        captured = b
        return b
      },
    })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    expect(captured).toBeDefined()
    expect(captured!.length).toBe(32)
  })

  test("base64url format without padding", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    // base64url charset, no padding
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(raw).not.toContain("=")
  })

  test("lowercase 64-character SHA-256 digest retained", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const meta = state.inspect({ digest: sha256Hex(raw) })
    expect(meta).toBeDefined()
    expect(meta!.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(meta!.digest).toBe(sha256Hex(raw))
  })

  test("raw value returned by issue but absent from retained state", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const snapshot = state.serialize()
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(raw)
  })
})

describe("TicketState: consume valid", () => {
  test("valid write ticket", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    expect(result.success).toBe(true)
  })

  test("valid read ticket", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "read", now: 1000 })
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "read", now: 2000 })
    expect(result.success).toBe(true)
  })

  test("successful one-time consume", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    const second = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    expect(second.success).toBe(false)
    expect(second.error).toBe("ticket_reused")
  })

  test("second consume rejected as reused", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    const second = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    expect(second.success).toBe(false)
    expect(second.error).toBe("ticket_reused")
  })

  test("simultaneous consume race: one success only", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const results = [
      state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 }),
      state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 }),
    ]
    const successes = results.filter((r) => r.success).length
    const reuses = results.filter((r) => r.error === "ticket_reused").length
    expect(successes).toBe(1)
    expect(reuses).toBe(1)
  })

  test("expiration does not mark ticket as used", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    // Expire at exactly TTL boundary
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 31000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_expired")
    // Ticket was not marked used — a later re-issue attempt (different raw) should still work.
    // The expired ticket remains unconsumed.
    const meta = state.inspect({ digest: sha256Hex(raw) })
    expect(meta?.usedAt).toBeUndefined()
  })
})

describe("TicketState: consume failures", () => {
  test("malformed ticket rejected before use", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const result = state.consume({
      raw: "!!!not-base64url!!!",
      terminalID,
      generation,
      projectID,
      mode: "write",
      now: 2000,
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
  })

  test("unknown ticket rejected", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const bogusRaw = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url")
    const result = state.consume({ raw: bogusRaw, terminalID, generation, projectID, mode: "write", now: 2000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
  })

  test("wrong project rejected", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consume({ raw, terminalID, generation, projectID: "wrong", mode: "write", now: 2000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
  })

  test("wrong terminal rejected", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consume({ raw, terminalID: "t-999", generation, projectID, mode: "write", now: 2000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
  })

  test("wrong generation rejected", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consume({ raw, terminalID, generation: 999, projectID, mode: "write", now: 2000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
  })

  test("wrong mode rejected", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "read", now: 2000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
  })
})

describe("TicketState: TTL boundaries", () => {
  test("valid at 29_999 ms", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 30999 })
    expect(result.success).toBe(true)
  })

  test("expired at exactly 30_000 ms", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 31000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_expired")
  })
})

describe("TicketState: isolation", () => {
  test("one ticket failure does not mutate another ticket", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const a = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const b = state.issue({ terminalID, generation, projectID, mode: "read", now: 1000 })
    // Fail consume on A with wrong mode
    const failA = state.consume({ raw: a.raw, terminalID, generation, projectID, mode: "read", now: 2000 })
    expect(failA.success).toBe(false)
    // B should still consume successfully
    const okB = state.consume({ raw: b.raw, terminalID, generation, projectID, mode: "read", now: 2000 })
    expect(okB.success).toBe(true)
  })

  test("deterministic injected randomness in tests", () => {
    const state1 = new TicketState({ random: fixedRandomSource(42) })
    const state2 = new TicketState({ random: fixedRandomSource(42) })
    const r1 = state1.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const r2 = state2.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    expect(r1.raw).toBe(r2.raw)
  })
})

describe("TicketState: retained state shape", () => {
  test("retained state serialization contains no raw ticket", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const issued = [
      state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 }),
      state.issue({ terminalID, generation, projectID, mode: "read", now: 1000 }),
    ]
    const snapshot = state.serialize()
    const serialized = JSON.stringify(snapshot)
    for (const t of issued) {
      expect(serialized).not.toContain(t.raw)
    }
    // Shape: array of metadata records, each with digest + scope, no raw.
    expect(Array.isArray(snapshot)).toBe(true)
    for (const rec of snapshot) {
      expect(typeof rec.digest).toBe("string")
      expect(rec.digest).toMatch(/^[0-9a-f]{64}$/)
      expect("raw" in rec).toBe(false)
      expect("rawTicket" in rec).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// BLOCKER 3: digest collisions. One digest may correspond to exactly one
// retained ticket. The map is keyed globally by digest. Repeating the same
// random bytes fails closed with ticket_invalid and does not overwrite.
// ---------------------------------------------------------------------------
describe("TicketState: digest collisions", () => {
  // A random source that always returns the same 32 bytes.
  const sameBytes = (): Uint8Array => {
    const b = new Uint8Array(32)
    for (let i = 0; i < 32; i++) b[i] = i + 1
    return b
  }

  test("duplicate random bytes in the same scope fail closed", () => {
    const state = new TicketState({ random: sameBytes })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation, projectID, mode: "write", now: 2000 }),
    )
    expect(state.serialize().length).toBe(1)
  })

  test("duplicate random bytes across read/write modes fail closed", () => {
    const state = new TicketState({ random: sameBytes })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    expectErrorCode("ticket_invalid", () => state.issue({ terminalID, generation, projectID, mode: "read", now: 2000 }))
    expect(state.serialize().length).toBe(1)
  })

  test("duplicate random bytes across terminal IDs fail closed", () => {
    const state = new TicketState({ random: sameBytes })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID: "t-999", generation, projectID, mode: "write", now: 2000 }),
    )
    expect(state.serialize().length).toBe(1)
  })

  test("duplicate random bytes across projects fail closed", () => {
    const state = new TicketState({ random: sameBytes })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation, projectID: "p2", mode: "write", now: 2000 }),
    )
    expect(state.serialize().length).toBe(1)
  })

  test("collision after first ticket consumption does not make it reusable", () => {
    const state = new TicketState({ random: sameBytes })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation, projectID, mode: "write", now: 3000 }),
    )
    const meta = state.inspect({ digest: sha256Hex(raw) })
    expect(meta?.usedAt).toBe(2000)
    const reconsume = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 3000 })
    expect(reconsume.success).toBe(false)
    expect(reconsume.error).toBe("ticket_reused")
  })

  test("original ticket state unchanged after collision rejection", () => {
    const state = new TicketState({ random: sameBytes })
    const { raw, digest } = state.issue({
      terminalID,
      generation,
      projectID,
      mode: "write",
      now: 1000,
    })
    const before = state.inspect({ digest })
    try {
      state.issue({ terminalID, generation, projectID, mode: "read", now: 2000 })
    } catch {}
    const after = state.inspect({ digest })
    expect(before).toEqual(after)
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// BLOCKER 4: production random source. Default uses crypto.getRandomValues
// on 32 bytes when omitted. Rejects a custom source returning non-32 bytes.
// ---------------------------------------------------------------------------
describe("TicketState: production random source", () => {
  test("default random source produces a valid 32-byte base64url ticket", () => {
    const state = new TicketState()
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(raw).not.toContain("=")
    // Decodes to 32 bytes.
    const decoded = Buffer.from(raw, "base64url")
    expect(decoded.length).toBe(32)
  })

  test("default random source calls crypto.getRandomValues with a 32-byte array", () => {
    // Deterministic spy: fill the supplied 32-byte array with fixed bytes so the
    // produced raw is reproducible. This measures the call shape, not
    // cryptographic quality. Restore the original in finally so a failure cannot
    // leak the shim into other tests.
    const original = crypto.getRandomValues
    let called = false
    let captured: Uint8Array | undefined
    try {
      crypto.getRandomValues = ((arr: Uint8Array) => {
        called = true
        captured = arr
        for (let i = 0; i < arr.length; i++) arr[i] = (i + 7) % 256
        return arr
      }) as typeof crypto.getRandomValues

      const state = new TicketState()
      const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })

      expect(called).toBe(true)
      expect(captured).toBeDefined()
      expect(captured!.length).toBe(32)
      // The expected deterministic base64url for bytes 7..38 mod 256.
      const expected = base64urlOf(rangeBytes(7, 32))
      expect(raw).toBe(expected)
    } finally {
      crypto.getRandomValues = original
    }
  })

  test("rejects custom source returning 31 bytes", () => {
    const state = new TicketState({
      random: () => new Uint8Array(31),
    })
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 }),
    )
    expect(state.serialize().length).toBe(0)
  })

  test("rejects custom source returning 33 bytes", () => {
    const state = new TicketState({
      random: () => new Uint8Array(33),
    })
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 }),
    )
    expect(state.serialize().length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// BLOCKER 5: expiry ordering and pruning. Expired tickets return
// ticket_expired before ticket_reused. prune() removes all expired tickets
// (unused AND consumed). Pruning is idempotent.
// ---------------------------------------------------------------------------
describe("TicketState: expiry ordering and pruning", () => {
  test("consumed replay before expiry returns ticket_reused", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    const replay = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 30999 })
    expect(replay.success).toBe(false)
    expect(replay.error).toBe("ticket_reused")
  })

  test("consumed replay at exactly expiry returns ticket_expired", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    const replay = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 31000 })
    expect(replay.success).toBe(false)
    expect(replay.error).toBe("ticket_expired")
  })

  test("prune removes expired unused ticket", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    expect(state.serialize().length).toBe(1)
    const removed = state.prune(31000)
    expect(removed).toBe(1)
    expect(state.serialize().length).toBe(0)
  })

  test("prune removes expired consumed ticket", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    expect(state.serialize().length).toBe(1)
    const removed = state.prune(31000)
    expect(removed).toBe(1)
    expect(state.serialize().length).toBe(0)
  })

  test("prune retains unexpired tickets", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const removed = state.prune(20000)
    expect(removed).toBe(0)
    expect(state.serialize().length).toBe(1)
  })

  test("prune retains one expired and one unexpired ticket independently", () => {
    const src = fixedRandomSource(1)
    const state = new TicketState({ random: src })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.issue({ terminalID, generation, projectID, mode: "read", now: 50000 })
    const removed = state.prune(31000)
    expect(removed).toBe(1)
    expect(state.serialize().length).toBe(1)
  })

  test("repeated prune is idempotent", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.prune(31000)
    const removed2 = state.prune(31000)
    expect(removed2).toBe(0)
    expect(state.serialize().length).toBe(0)
  })

  test("after prune, expired ticket returns ticket_invalid", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.prune(31000)
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 31000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
  })
})

// ---------------------------------------------------------------------------
// Runtime contract: validate retained tickets through Ticket.zod, reject
// invalid inputs without mutating retained state.
// ---------------------------------------------------------------------------
describe("TicketState: runtime contract validation", () => {
  test("every retained ticket passes Ticket.zod", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    for (const t of state.serialize()) {
      expect(Ticket.zod.safeParse(t).success).toBe(true)
    }
  })

  test("rejects empty terminalID without mutating state", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID: "", generation, projectID, mode: "write", now: 1000 }),
    )
    expect(state.serialize().length).toBe(0)
  })

  test("rejects negative generation without mutating state", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation: -1, projectID, mode: "write", now: 1000 }),
    )
    expect(state.serialize().length).toBe(0)
  })

  test("rejects fractional now without mutating state", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation, projectID, mode: "write", now: 1000.5 }),
    )
    expect(state.serialize().length).toBe(0)
  })

  test("rejects overflow in expiresAt calculation", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const nearMax = Number.MAX_SAFE_INTEGER - LIMITS.TICKET_TTL_MS + 1
    expectErrorCode("offset_overflow", () =>
      state.issue({ terminalID, generation, projectID, mode: "write", now: nearMax }),
    )
    expect(state.serialize().length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// BLOCKER (final): consume() validates every input field before mutating
// retained state. Invalid now / mode / projectID / generation all return
// { success: false, error: "ticket_invalid" } WITHOUT touching usedAt.
// ---------------------------------------------------------------------------
describe("TicketState: consume input validation (no mutation)", () => {
  // A random source that always returns the same 32 bytes — used to issue the
  // canonical ticket, then to test that rejected consume calls leave the
  // retained record byte-for-byte unchanged.
  const sameBytes = (): Uint8Array => {
    const b = new Uint8Array(32)
    for (let i = 0; i < 32; i++) b[i] = i + 1
    return b
  }

  function stateWithTicket(): { state: TicketState; raw: string } {
    const state = new TicketState({ random: sameBytes })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    return { state, raw }
  }

  function snapshotBefore(state: TicketState): unknown {
    // Capture a deep snapshot of every retained record so identity-equality
    // checks detect ANY mutation (not just usedAt).
    return JSON.stringify(state.serialize().map((t) => ({ ...t })))
  }

  test("consume with negative now -> ticket_invalid, retained unchanged", () => {
    const { state, raw } = stateWithTicket()
    const before = snapshotBefore(state)
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: -1 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
    expect(snapshotBefore(state)).toBe(before)
    expect(state.serialize()[0]?.usedAt).toBeUndefined()
  })

  test("consume with fractional now -> ticket_invalid, retained unchanged", () => {
    const { state, raw } = stateWithTicket()
    const before = snapshotBefore(state)
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000.5 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
    expect(snapshotBefore(state)).toBe(before)
    expect(state.serialize()[0]?.usedAt).toBeUndefined()
  })

  test("consume with NaN now -> ticket_invalid, retained unchanged", () => {
    const { state, raw } = stateWithTicket()
    const before = snapshotBefore(state)
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: NaN })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
    expect(snapshotBefore(state)).toBe(before)
    expect(state.serialize()[0]?.usedAt).toBeUndefined()
  })

  test("consume with unsafe now (> MAX_SAFE_INTEGER) -> ticket_invalid, retained unchanged", () => {
    const { state, raw } = stateWithTicket()
    const before = snapshotBefore(state)
    const result = state.consume({
      raw,
      terminalID,
      generation,
      projectID,
      mode: "write",
      now: Number.MAX_SAFE_INTEGER + 1,
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
    expect(snapshotBefore(state)).toBe(before)
    expect(state.serialize()[0]?.usedAt).toBeUndefined()
  })

  test("consume with invalid mode (runtime cast) -> ticket_invalid, retained unchanged", () => {
    const { state, raw } = stateWithTicket()
    const before = snapshotBefore(state)
    const result = state.consume({
      raw,
      terminalID,
      generation,
      projectID,
      mode: "execute" as unknown as "write",
      now: 2000,
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
    expect(snapshotBefore(state)).toBe(before)
    expect(state.serialize()[0]?.usedAt).toBeUndefined()
  })

  test("consume with empty projectID -> ticket_invalid, retained unchanged", () => {
    const { state, raw } = stateWithTicket()
    const before = snapshotBefore(state)
    const result = state.consume({ raw, terminalID, generation, projectID: "", mode: "write", now: 2000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
    expect(snapshotBefore(state)).toBe(before)
    expect(state.serialize()[0]?.usedAt).toBeUndefined()
  })

  test("consume with negative generation -> ticket_invalid, retained unchanged", () => {
    const { state, raw } = stateWithTicket()
    const before = snapshotBefore(state)
    const result = state.consume({ raw, terminalID, generation: -5, projectID, mode: "write", now: 2000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
    expect(snapshotBefore(state)).toBe(before)
    expect(state.serialize()[0]?.usedAt).toBeUndefined()
  })

  test("consume with Infinity now -> ticket_invalid, retained unchanged", () => {
    const { state, raw } = stateWithTicket()
    const before = snapshotBefore(state)
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: Infinity })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
    expect(snapshotBefore(state)).toBe(before)
    expect(state.serialize()[0]?.usedAt).toBeUndefined()
  })

  test("consume with empty terminalID -> ticket_invalid, retained unchanged", () => {
    const { state, raw } = stateWithTicket()
    const before = snapshotBefore(state)
    const result = state.consume({ raw, terminalID: "", generation, projectID, mode: "write", now: 2000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
    expect(snapshotBefore(state)).toBe(before)
    expect(state.serialize()[0]?.usedAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// BLOCKER 2 (final): consume() commits usedAt through a fail-closed candidate
// sequence. The object already in the map is never mutated before validation.
// A successful consumption must yield a Ticket.zod-valid record, and every
// serialize() result must be accepted by Ticket.zod.
// ---------------------------------------------------------------------------
describe("TicketState: fail-closed commit of usedAt", () => {
  test("successful consumption produces a Ticket.zod-valid record", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    expect(result.success).toBe(true)
    const rec = state.serialize()[0]
    expect(rec).toBeDefined()
    expect(Ticket.zod.safeParse(rec).success).toBe(true)
    expect(rec!.usedAt).toBe(2000)
  })

  test("invalid usedAt cannot enter retained state (NaN now)", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: NaN })
    expect(result.success).toBe(false)
    const rec = state.serialize()[0]
    expect(rec!.usedAt).toBeUndefined()
    expect(Ticket.zod.safeParse(rec).success).toBe(true)
  })

  test("failed consumption leaves the original object unchanged", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const before = state.serialize()[0]
    // Multiple rejected consumes with various invalid inputs
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: -1 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: NaN })
    state.consume({ raw, terminalID, generation, projectID, mode: "read", now: 1500 })
    state.consume({ raw, terminalID, generation, projectID: "wrong", mode: "write", now: 1500 })
    const after = state.serialize()[0]
    expect(after).toEqual(before)
    // The original ticket is still consumable with a valid, matching call.
    const ok = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    expect(ok.success).toBe(true)
  })

  test("serialize() always returns records accepted by Ticket.zod", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.issue({ terminalID, generation, projectID, mode: "read", now: 50000 })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "read", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "read", now: 2000 })
    for (const t of state.serialize()) {
      expect(Ticket.zod.safeParse(t).success).toBe(true)
    }
  })

  test("the retained object is NOT mutated before the candidate validates (path coverage)", () => {
    // Issue, then attempt a consume with an invalid mode that forces the
    // candidate to diverge from the retained shape. The retained record must
    // remain untouched (usedAt undefined, original mode).
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const retainedBefore = state.inspect({ digest: sha256Hex(raw) })
    state.consume({ raw, terminalID, generation, projectID, mode: "execute" as unknown as "write", now: 2000 })
    const retainedAfter = state.inspect({ digest: sha256Hex(raw) })
    expect(retainedAfter).toEqual(retainedBefore)
    expect(retainedAfter?.usedAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// BLOCKER 3 (final): lifetime digest uniqueness. Every issued digest is
// tombstoned for the lifetime of the TicketState. prune() removes metadata but
// never tombstones. A consumed + expired + pruned ticket can never be reissued
// (across mode, terminal, project). The same raw ticket must never be issued
// for two scopes inside one TicketState.
// ---------------------------------------------------------------------------
describe("TicketState: lifetime digest tombstone (no reissue after prune)", () => {
  const sameBytes = (): Uint8Array => {
    const b = new Uint8Array(32)
    for (let i = 0; i < 32; i++) b[i] = i + 1
    return b
  }

  test("issue -> consume -> expire -> prune -> reissue same bytes fails ticket_invalid", () => {
    const state = new TicketState({ random: sameBytes })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    // Expire it past TTL and prune.
    const removed = state.prune(31000)
    expect(removed).toBe(1)
    expect(state.serialize().length).toBe(0)
    // The same raw bytes can never be issued again — lifetime tombstone holds.
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation, projectID, mode: "write", now: 40000 }),
    )
    expect(state.serialize().length).toBe(0)
  })

  test("tombstone blocks reissue across a different mode", () => {
    const state = new TicketState({ random: sameBytes })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    state.prune(31000)
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation, projectID, mode: "read", now: 40000 }),
    )
    expect(state.serialize().length).toBe(0)
  })

  test("tombstone blocks reissue across a different terminal", () => {
    const state = new TicketState({ random: sameBytes })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    state.prune(31000)
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID: "t-other", generation, projectID, mode: "write", now: 40000 }),
    )
    expect(state.serialize().length).toBe(0)
  })

  test("tombstone blocks reissue across a different project", () => {
    const state = new TicketState({ random: sameBytes })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    state.prune(31000)
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation, projectID: "p-other", mode: "write", now: 40000 }),
    )
    expect(state.serialize().length).toBe(0)
  })

  test("tombstone blocks reissue across a different generation", () => {
    const state = new TicketState({ random: sameBytes })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    state.prune(31000)
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation: 999, projectID, mode: "write", now: 40000 }),
    )
    expect(state.serialize().length).toBe(0)
  })

  test("old raw remains invalid after prune (cannot consume a tombstoned raw)", () => {
    const state = new TicketState({ random: sameBytes })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    state.prune(31000)
    // The retained metadata is gone, so a consume of the old raw is invalid.
    const reconsume = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 40000 })
    expect(reconsume.success).toBe(false)
    expect(reconsume.error).toBe("ticket_invalid")
  })

  test("tombstone active even without consume (issue -> expire -> prune -> reissue)", () => {
    const state = new TicketState({ random: sameBytes })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.prune(31000)
    expect(state.serialize().length).toBe(0)
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation, projectID, mode: "write", now: 40000 }),
    )
    expect(state.serialize().length).toBe(0)
  })

  test("serialize() does not expose tombstones as ticket records", () => {
    const state = new TicketState({ random: sameBytes })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.prune(31000)
    const snapshot = state.serialize()
    expect(snapshot.length).toBe(0)
  })

  test("collision rejection does not mutate retained tickets or tombstones beyond original", () => {
    const state = new TicketState({ random: sameBytes })
    const issued = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const before = state.inspect({ digest: issued.digest })
    try {
      state.issue({ terminalID, generation, projectID, mode: "read", now: 2000 })
    } catch {}
    const after = state.inspect({ digest: issued.digest })
    expect(after).toEqual(before)
    expect(state.serialize().length).toBe(1)
    // The original raw still consumes successfully.
    const ok = state.consume({ raw: issued.raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    expect(ok.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// BLOCKER: prune() validates now before removing anything. Negative,
// fractional, NaN, and unsafe timestamps remove nothing.
// ---------------------------------------------------------------------------
describe("TicketState: prune input validation", () => {
  function stateWithUnexpired(): { state: TicketState; before: number } {
    const state = new TicketState({ random: fixedRandomSource(1) })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    return { state, before: state.serialize().length }
  }

  test("prune with negative now removes nothing", () => {
    const { state, before } = stateWithUnexpired()
    expectErrorCode("ticket_invalid", () => state.prune(-1))
    expect(state.serialize().length).toBe(before)
  })

  test("prune with fractional now removes nothing", () => {
    const { state, before } = stateWithUnexpired()
    expectErrorCode("ticket_invalid", () => state.prune(31000.5))
    expect(state.serialize().length).toBe(before)
  })

  test("prune with NaN now removes nothing", () => {
    const { state, before } = stateWithUnexpired()
    expectErrorCode("ticket_invalid", () => state.prune(NaN))
    expect(state.serialize().length).toBe(before)
  })

  test("prune with Infinity now removes nothing", () => {
    const { state, before } = stateWithUnexpired()
    expectErrorCode("ticket_invalid", () => state.prune(Infinity))
    expect(state.serialize().length).toBe(before)
  })

  test("prune with now exceeding MAX_SAFE_INTEGER removes nothing", () => {
    const { state, before } = stateWithUnexpired()
    // 1e21 is an integer by Number.isInteger but exceeds MAX_SAFE_INTEGER,
    // so validateNow must reject it rather than prune the unexpired ticket.
    expectErrorCode("ticket_invalid", () => state.prune(1e21))
    expect(state.serialize().length).toBe(before)
  })

  test("prune does not remove a tombstone when an expired ticket is pruned then reissue attempted", () => {
    // Confirm the boundary: prune removes metadata, but a subsequent reissue
    // with identical bytes still fails closed. Use a constant byte source so the
    // second issue attempt reuses the exact same digest.
    const sameBytes = (): Uint8Array => {
      const b = new Uint8Array(32)
      for (let i = 0; i < 32; i++) b[i] = i + 1
      return b
    }
    const state = new TicketState({ random: sameBytes })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const removed = state.prune(31000)
    expect(removed).toBe(1)
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation, projectID, mode: "write", now: 40000 }),
    )
  })
})

// ---------------------------------------------------------------------------
// BLOCKER: inspect() validates digest shape. A malformed digest returns
// undefined rather than silently treating a typo as "not found" through the
// map lookup boundary.
// ---------------------------------------------------------------------------
describe("TicketState: inspect digest validation", () => {
  test("malformed digest returns undefined", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    expect(state.inspect({ digest: "not-a-digest" })).toBeUndefined()
    expect(state.inspect({ digest: "" })).toBeUndefined()
    expect(state.inspect({ digest: "ABCD" })).toBeUndefined()
  })

  test("valid-format unknown digest returns undefined", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const unknownDigest = "0".repeat(64)
    expect(state.inspect({ digest: unknownDigest })).toBeUndefined()
  })

  test("valid digest returns a shallow clone", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const digest = sha256Hex(raw)
    const a = state.inspect({ digest })
    const b = state.inspect({ digest })
    expect(a).toBeDefined()
    expect(a).not.toBe(b)
    if (a && b) {
      a.usedAt = 999
      expect(b.usedAt).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Error contract: confirm the exact codes asserted throughout via .code or
// result.error. This block exists as a single integration sweep over the
// required error contract rather than duplicating assertions scattered above.
// ---------------------------------------------------------------------------
describe("TicketState: error contract assertions", () => {
  test("invalid ticket transition input -> ticket_invalid (via .error)", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const r = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: NaN })
    expect(r.success).toBe(false)
    expect(r.error).toBe("ticket_invalid")
  })

  test("timestamp overflow -> offset_overflow (via .code)", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const nearMax = Number.MAX_SAFE_INTEGER - LIMITS.TICKET_TTL_MS + 1
    expectErrorCode("offset_overflow", () =>
      state.issue({ terminalID, generation, projectID, mode: "write", now: nearMax }),
    )
  })

  test("lifetime digest collision -> ticket_invalid (via .code)", () => {
    const sameBytes = (): Uint8Array => {
      const b = new Uint8Array(32)
      for (let i = 0; i < 32; i++) b[i] = i + 1
      return b
    }
    const state = new TicketState({ random: sameBytes })
    state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.prune(31000)
    expectErrorCode("ticket_invalid", () =>
      state.issue({ terminalID, generation, projectID, mode: "read", now: 40000 }),
    )
  })

  test("expired ticket -> ticket_expired (via .error)", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const r = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 31000 })
    expect(r.success).toBe(false)
    expect(r.error).toBe("ticket_expired")
  })

  test("reused unexpired ticket -> ticket_reused (via .error)", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    const r = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    expect(r.success).toBe(false)
    expect(r.error).toBe("ticket_reused")
  })
})

// ---------------------------------------------------------------------------
// ST-06A: consumeMode() — additive mode-agnostic consume used by the
// shared-terminal WebSocket route. Unlike consume(), the caller does not
// supply a mode: this method validates terminal/generation/project scope
// only and returns the stored mode alongside success. The same fail-closed
// candidate-validate-commit discipline as consume() is preserved, and
// consume() is left unchanged for ST-02 compatibility. Synchronous and
// await-free, so two concurrent callers cannot interleave between the
// usedAt guard and the write.
// ---------------------------------------------------------------------------
describe("TicketState: consumeMode", () => {
  test("read-mode success returns mode", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "read", now: 1000 })
    const result = state.consumeMode({ raw, terminalID, generation, projectID, now: 2000 })
    expect(result.success).toBe(true)
    expect(result.mode).toBe("read")
    expect(result.error).toBeUndefined()
  })

  test("write-mode success returns mode", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consumeMode({ raw, terminalID, generation, projectID, now: 2000 })
    expect(result.success).toBe(true)
    expect(result.mode).toBe("write")
    expect(result.error).toBeUndefined()
  })

  test("wrong terminal rejected as ticket_invalid", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consumeMode({ raw, terminalID: "t-999", generation, projectID, now: 2000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
    expect(result.mode).toBeUndefined()
  })

  test("wrong generation rejected as ticket_invalid", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consumeMode({ raw, terminalID, generation: 999, projectID, now: 2000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
  })

  test("wrong project rejected as ticket_invalid", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consumeMode({ raw, terminalID, generation, projectID: "wrong", now: 2000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
  })

  test("malformed ticket rejected as ticket_invalid", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const result = state.consumeMode({
      raw: "!!!not-base64url!!!",
      terminalID,
      generation,
      projectID,
      now: 2000,
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_invalid")
  })

  test("expired ticket returns ticket_expired", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consumeMode({ raw, terminalID, generation, projectID, now: 31000 })
    expect(result.success).toBe(false)
    expect(result.error).toBe("ticket_expired")
  })

  test("reused ticket returns ticket_reused", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consumeMode({ raw, terminalID, generation, projectID, now: 2000 })
    const second = state.consumeMode({ raw, terminalID, generation, projectID, now: 2000 })
    expect(second.success).toBe(false)
    expect(second.error).toBe("ticket_reused")
  })

  test("simultaneous consumeMode race: exactly one success", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const results = [
      state.consumeMode({ raw, terminalID, generation, projectID, now: 2000 }),
      state.consumeMode({ raw, terminalID, generation, projectID, now: 2000 }),
    ]
    const successes = results.filter((r) => r.success).length
    const reuses = results.filter((r) => r.error === "ticket_reused").length
    expect(successes).toBe(1)
    expect(reuses).toBe(1)
  })

  test("successful consumeMode marks usedAt viaTicket.zod-valid candidate", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consumeMode({ raw, terminalID, generation, projectID, now: 2000 })
    const rec = state.serialize()[0]
    expect(rec).toBeDefined()
    expect(Ticket.zod.safeParse(rec).success).toBe(true)
    expect(rec!.usedAt).toBe(2000)
  })

  test("failed consumeMode does not mutate retained state", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const before = JSON.stringify(state.serialize())
    state.consumeMode({ raw, terminalID: "wrong", generation, projectID, now: 2000 })
    state.consumeMode({ raw, terminalID, generation, projectID, now: -1 })
    state.consumeMode({ raw: "bad", terminalID, generation, projectID, now: 2000 })
    expect(JSON.stringify(state.serialize())).toBe(before)
    expect(state.serialize()[0]?.usedAt).toBeUndefined()
  })

  test("consumeMode result carries no ticket material or digest", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw, digest } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const result = state.consumeMode({ raw, terminalID, generation, projectID, now: 2000 })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(raw)
    expect(serialized).not.toContain(digest)
  })

  test("consumeMode and consume are independent: consumeMode success blocks later consume", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    const modeResult = state.consumeMode({ raw, terminalID, generation, projectID, now: 2000 })
    expect(modeResult.success).toBe(true)
    const consumeResult = state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    expect(consumeResult.success).toBe(false)
    expect(consumeResult.error).toBe("ticket_reused")
  })

  test("consume and consumeMode are independent: consume success blocks later consumeMode", () => {
    const state = new TicketState({ random: fixedRandomSource(1) })
    const { raw } = state.issue({ terminalID, generation, projectID, mode: "write", now: 1000 })
    state.consume({ raw, terminalID, generation, projectID, mode: "write", now: 2000 })
    const modeResult = state.consumeMode({ raw, terminalID, generation, projectID, now: 2000 })
    expect(modeResult.success).toBe(false)
    expect(modeResult.error).toBe("ticket_reused")
  })
})
