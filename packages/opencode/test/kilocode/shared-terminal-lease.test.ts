import { test, expect, describe } from "bun:test"
import { LeaseState } from "../../src/kilocode/shared-terminal/lease"
import { LIMITS, Lease } from "../../src/kilocode/shared-terminal/schema"

const agent = { type: "agent" as const, sessionID: "s1", agentID: "a1", callID: "k1" }
const agent2 = { type: "agent" as const, sessionID: "s2", agentID: "a2", callID: "k2" }
const terminalID = "t-001"
const generation = 1

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

describe("LeaseState: acquire", () => {
  test("successful acquire creates agent-only lease with correct timing", () => {
    const state = new LeaseState()
    const now = 1000
    const lease = state.acquire({ terminalID, generation, actor: agent, now })
    expect(lease.terminalID).toBe(terminalID)
    expect(lease.generation).toBe(generation)
    expect(lease.actor).toEqual(agent)
    expect(lease.revision).toBe(0)
    expect(lease.acquiredAt).toBe(now)
    expect(lease.expiresAt).toBe(now + LIMITS.LEASE_IDLE_MS)
    expect(lease.maxAt).toBe(now + LIMITS.LEASE_MAX_MS)
  })

  test("competing acquire rejected while valid lease active", () => {
    const state = new LeaseState()
    state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("lease_missing", () => state.acquire({ terminalID, generation, actor: agent2, now: 2000 }))
  })

  test("same agent identity rejected while lease active", () => {
    const state = new LeaseState()
    state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("lease_missing", () => state.acquire({ terminalID, generation, actor: agent, now: 2000 }))
  })

  test("private-mode acquire rejection", () => {
    const state = new LeaseState()
    const result = state.setPrivateMode(true)
    expect(result.revoked).toBe(false)
    expectErrorCode("private_mode", () => state.acquire({ terminalID, generation, actor: agent, now: 1000 }))
  })
})

describe("LeaseState: refresh", () => {
  test("refresh before idle expiry succeeds and increments revision", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    const refreshed = state.refresh({
      terminalID,
      generation,
      leaseID: lease.id,
      actor: agent,
      revision: lease.revision,
      now: 10000,
    })
    expect(refreshed.revision).toBe(1)
    expect(refreshed.expiresAt).toBe(10000 + LIMITS.LEASE_IDLE_MS)
    expect(refreshed.maxAt).toBe(lease.maxAt)
  })

  test("refresh capped by maxAt", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    let current = lease
    for (const now of [14000, 28000, 42000, 56000]) {
      current = state.refresh({
        terminalID,
        generation,
        leaseID: current.id,
        actor: agent,
        revision: current.revision,
        now,
      })
    }
    expect(current.expiresAt).toBe(lease.maxAt)
    expect(current.maxAt).toBe(lease.maxAt)
  })

  test("stale revision refresh rejected", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.refresh({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 2000 })
    expectErrorCode("lease_stale", () =>
      state.refresh({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 3000 }),
    )
  })

  test("wrong terminal rejected", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("lease_missing", () =>
      state.refresh({
        terminalID: "t-999",
        generation,
        leaseID: lease.id,
        actor: agent,
        revision: lease.revision,
        now: 2000,
      }),
    )
  })

  test("wrong generation rejected", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("lease_missing", () =>
      state.refresh({
        terminalID,
        generation: 999,
        leaseID: lease.id,
        actor: agent,
        revision: lease.revision,
        now: 2000,
      }),
    )
  })

  test("wrong actor rejected", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("lease_missing", () =>
      state.refresh({ terminalID, generation, leaseID: lease.id, actor: agent2, revision: lease.revision, now: 2000 }),
    )
  })

  test("private-mode refresh rejection", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    const result = state.setPrivateMode(true)
    expect(result.revoked).toBe(true)
    expect(result.leaseID).toBe(lease.id)
    expectErrorCode("private_mode", () =>
      state.refresh({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 2000 }),
    )
  })
})

describe("LeaseState: validate", () => {
  test("validate requires exact terminal, generation, actor, leaseID, revision", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expect(() =>
      state.validate({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 2000 }),
    ).not.toThrow()
  })

  test("validate rejects missing lease", () => {
    const state = new LeaseState()
    expectErrorCode("lease_missing", () =>
      state.validate({ terminalID, generation, leaseID: "bogus", actor: agent, revision: 0, now: 2000 }),
    )
  })

  test("validate rejects stale revision", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.refresh({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 2000 })
    expectErrorCode("lease_stale", () =>
      state.validate({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 3000 }),
    )
  })

  test("validate rejects expired lease", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("lease_expired", () =>
      state.validate({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 16000 }),
    )
  })

  test("validate does not mutate lease", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.validate({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 2000 })
    expect(state.inspect()?.revision).toBe(lease.revision)
  })
})

describe("LeaseState: release", () => {
  test("release success clears lease", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.release({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision })
    expect(state.inspect()).toBeUndefined()
  })

  test("stale release rejected", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.refresh({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 2000 })
    expectErrorCode("lease_stale", () =>
      state.release({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision }),
    )
  })

  test("repeated release rejected", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.release({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision })
    expectErrorCode("lease_missing", () =>
      state.release({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision }),
    )
  })
})

describe("LeaseState: timeout", () => {
  test("timeout at expiresAt clears lease", () => {
    const state = new LeaseState()
    state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.checkTimeout(16000)
    expect(state.inspect()).toBeUndefined()
  })

  test("timeout at maxAt clears lease", () => {
    const state = new LeaseState()
    state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.checkTimeout(61000)
    expect(state.inspect()).toBeUndefined()
  })

  test("timeout idempotence", () => {
    const state = new LeaseState()
    state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.checkTimeout(16000)
    state.checkTimeout(17000)
    state.checkTimeout(18000)
    expect(state.inspect()).toBeUndefined()
  })
})

describe("LeaseState: humanPreempt", () => {
  test("human preemption invalidates active lease", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    const result = state.humanPreempt()
    expect(result.revoked).toBe(true)
    expect(result.leaseID).toBe(lease.id)
    expect(state.inspect()).toBeUndefined()
  })

  test("preemption with no active lease is idempotent", () => {
    const state = new LeaseState()
    const result = state.humanPreempt()
    expect(result.revoked).toBe(false)
    expect(result.leaseID).toBeUndefined()
  })

  test("preempted lease handle becomes stale", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.humanPreempt()
    expectErrorCode("lease_missing", () =>
      state.refresh({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 2000 }),
    )
  })
})

describe("LeaseState: no mutation after rejection", () => {
  test("rejected acquire does not mutate state", () => {
    const state = new LeaseState()
    state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    const before = state.inspect()
    try {
      state.acquire({ terminalID, generation, actor: agent2, now: 2000 })
    } catch {}
    expect(before).toEqual(state.inspect())
  })

  test("rejected refresh does not mutate state", () => {
    const state = new LeaseState()
    state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    const before = state.inspect()
    try {
      state.refresh({ terminalID, generation, leaseID: "x", actor: agent2, revision: 0, now: 2000 })
    } catch {}
    expect(before).toEqual(state.inspect())
  })
})

describe("LeaseState: boundary tests", () => {
  test("idle boundary at 14_999 ms is valid", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expect(() =>
      state.validate({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 15999 }),
    ).not.toThrow()
  })

  test("idle boundary at 15_000 ms is expired", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("lease_expired", () =>
      state.validate({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 16000 }),
    )
  })

  test("absolute boundary at 59_999 ms is valid", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    let current = lease
    for (const now of [14000, 28000, 42000, 56000]) {
      current = state.refresh({
        terminalID,
        generation,
        leaseID: current.id,
        actor: agent,
        revision: current.revision,
        now,
      })
    }
    expect(() =>
      state.validate({
        terminalID,
        generation,
        leaseID: current.id,
        actor: agent,
        revision: current.revision,
        now: 60999,
      }),
    ).not.toThrow()
  })

  test("absolute boundary at 60_000 ms is expired", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    let current = lease
    for (const now of [14000, 28000, 42000, 56000]) {
      current = state.refresh({
        terminalID,
        generation,
        leaseID: current.id,
        actor: agent,
        revision: current.revision,
        now,
      })
    }
    expectErrorCode("lease_expired", () =>
      state.validate({
        terminalID,
        generation,
        leaseID: current.id,
        actor: agent,
        revision: current.revision,
        now: 61000,
      }),
    )
  })
})

// BLOCKER 1: actor aliasing
describe("LeaseState: actor aliasing", () => {
  test("mutating original acquire input actor does not change internal state", () => {
    const state = new LeaseState()
    const actor = { type: "agent" as const, sessionID: "s1", agentID: "a1", callID: "k1" }
    const lease = state.acquire({ terminalID, generation, actor, now: 1000 })
    actor.sessionID = "MUTATED"
    expect(state.inspect()?.actor.sessionID).toBe("s1")
    expect(lease.actor.sessionID).toBe("s1")
  })

  test("mutating returned lease.actor does not change internal state", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: { ...agent }, now: 1000 })
    lease.actor.sessionID = "MUTATED"
    expect(state.inspect()?.actor.sessionID).toBe("s1")
  })

  test("mutating inspect result does not change later inspect or validation", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: { ...agent }, now: 1000 })
    const snap1 = state.inspect()
    snap1!.actor.sessionID = "MUTATED"
    expect(state.inspect()?.actor.sessionID).toBe("s1")
    expect(() =>
      state.validate({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 2000 }),
    ).not.toThrow()
  })

  test("acquire and inspect return distinct actor objects from internal state", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: { ...agent }, now: 1000 })
    const internal = state.inspect()
    expect(lease.actor).not.toBe(internal?.actor)
    expect(internal).toBeDefined()
    expect(lease.actor).toEqual(internal!.actor)
  })

  test("refresh returns a fresh actor clone", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: { ...agent }, now: 1000 })
    const refreshed = state.refresh({
      terminalID,
      generation,
      leaseID: lease.id,
      actor: agent,
      revision: lease.revision,
      now: 2000,
    })
    const internal = state.inspect()
    expect(refreshed.actor).not.toBe(internal?.actor)
    expect(internal).toBeDefined()
    expect(refreshed.actor).toEqual(internal!.actor)
  })
})

// BLOCKER 2: private mode revocation
describe("LeaseState: private mode revocation", () => {
  test("enter private mode revokes active lease", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    const result = state.setPrivateMode(true)
    expect(result.revoked).toBe(true)
    expect(result.leaseID).toBe(lease.id)
    expect(state.inspect()).toBeUndefined()
  })

  test("validate while private returns private_mode", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.setPrivateMode(true)
    expectErrorCode("private_mode", () =>
      state.validate({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 2000 }),
    )
  })

  test("old handle remains stale after private mode ends", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.setPrivateMode(true)
    state.setPrivateMode(false)
    expect(state.isPrivateMode()).toBe(false)
    expectErrorCode("lease_missing", () =>
      state.refresh({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: 2000 }),
    )
  })

  test("repeated private-mode entry is idempotent", () => {
    const state = new LeaseState()
    state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    const r1 = state.setPrivateMode(true)
    expect(r1.revoked).toBe(true)
    const r2 = state.setPrivateMode(true)
    expect(r2.revoked).toBe(false)
    expect(state.inspect()).toBeUndefined()
  })

  test("private-mode entry with no lease does not create state", () => {
    const state = new LeaseState()
    const result = state.setPrivateMode(true)
    expect(result.revoked).toBe(false)
    expect(state.inspect()).toBeUndefined()
    state.setPrivateMode(false)
    expect(state.inspect()).toBeUndefined()
  })

  test("leaving private mode does not restore the revoked lease", () => {
    const state = new LeaseState()
    state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.setPrivateMode(true)
    state.setPrivateMode(false)
    const newLease = state.acquire({ terminalID, generation, actor: agent, now: 2000 })
    expect(newLease.revision).toBe(0)
  })

  test("rejected operations leave state unchanged after private entry", () => {
    const state = new LeaseState()
    state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    state.setPrivateMode(true)
    const before = state.inspect()
    try {
      state.acquire({ terminalID, generation, actor: agent2, now: 2000 })
    } catch {}
    expect(before).toEqual(state.inspect())
  })
})

// Runtime contract: Lease.zod validation
describe("LeaseState: runtime contract validation", () => {
  test("every constructed lease passes Lease.zod", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expect(Lease.zod.safeParse(lease).success).toBe(true)
    const refreshed = state.refresh({
      terminalID,
      generation,
      leaseID: lease.id,
      actor: agent,
      revision: lease.revision,
      now: 2000,
    })
    expect(Lease.zod.safeParse(refreshed).success).toBe(true)
  })

  test("inspect result passes Lease.zod", () => {
    const state = new LeaseState()
    state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expect(Lease.zod.safeParse(state.inspect()).success).toBe(true)
  })

  test("rejects empty terminalID without mutating state", () => {
    const state = new LeaseState()
    expectErrorCode("terminal_missing", () => state.acquire({ terminalID: "", generation, actor: agent, now: 1000 }))
    expect(state.inspect()).toBeUndefined()
  })

  test("rejects negative generation without mutating state", () => {
    const state = new LeaseState()
    expectErrorCode("terminal_missing", () => state.acquire({ terminalID, generation: -1, actor: agent, now: 1000 }))
    expect(state.inspect()).toBeUndefined()
  })

  test("rejects fractional now without mutating state", () => {
    const state = new LeaseState()
    expectErrorCode("terminal_missing", () => state.acquire({ terminalID, generation, actor: agent, now: 1000.5 }))
    expect(state.inspect()).toBeUndefined()
  })

  test("rejects overflow in maxAt calculation", () => {
    const state = new LeaseState()
    const nearMax = Number.MAX_SAFE_INTEGER - LIMITS.LEASE_MAX_MS + 1
    expectErrorCode("offset_overflow", () => state.acquire({ terminalID, generation, actor: agent, now: nearMax }))
    expect(state.inspect()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// BLOCKER 1 (final): validate every public transition input. Runtime callers
// are not guaranteed to obey TypeScript types. Invalid actor shapes, NaN /
// fractional / negative timestamps, unsafe integers, and empty IDs must all
// fail deterministically with a structured error code — never a TypeError,
// never a mutation, never a cleared lease.
// ---------------------------------------------------------------------------
describe("LeaseState: actor shape rejection (acquire)", () => {
  test("undefined actor -> terminal_missing, no state", () => {
    const state = new LeaseState()
    expectErrorCode("terminal_missing", () =>
      state.acquire({ terminalID, generation, actor: undefined as unknown as typeof agent, now: 1000 }),
    )
    expect(state.inspect()).toBeUndefined()
  })

  test("human actor -> terminal_missing, no state", () => {
    const state = new LeaseState()
    const human = { type: "human" as const, clientID: "c1" }
    expectErrorCode("terminal_missing", () =>
      state.acquire({ terminalID, generation, actor: human as unknown as typeof agent, now: 1000 }),
    )
    expect(state.inspect()).toBeUndefined()
  })

  test("agent actor missing sessionID -> terminal_missing, no state", () => {
    const state = new LeaseState()
    const partial = { type: "agent" as const, agentID: "a1", callID: "k1" } as unknown as typeof agent
    expectErrorCode("terminal_missing", () => state.acquire({ terminalID, generation, actor: partial, now: 1000 }))
    expect(state.inspect()).toBeUndefined()
  })

  test("agent actor with empty agentID -> terminal_missing, no state", () => {
    const state = new LeaseState()
    const emptyAgent = { type: "agent" as const, sessionID: "s1", agentID: "", callID: "k1" }
    expectErrorCode("terminal_missing", () =>
      state.acquire({ terminalID, generation, actor: emptyAgent as unknown as typeof agent, now: 1000 }),
    )
    expect(state.inspect()).toBeUndefined()
  })

  test("system actor -> terminal_missing, no state", () => {
    const state = new LeaseState()
    const sys = { type: "system" as const, reason: "create" as const }
    expectErrorCode("terminal_missing", () =>
      state.acquire({ terminalID, generation, actor: sys as unknown as typeof agent, now: 1000 }),
    )
    expect(state.inspect()).toBeUndefined()
  })

  test("null actor -> terminal_missing, no state", () => {
    const state = new LeaseState()
    expectErrorCode("terminal_missing", () =>
      state.acquire({ terminalID, generation, actor: null as unknown as typeof agent, now: 1000 }),
    )
    expect(state.inspect()).toBeUndefined()
  })

  test("array actor -> terminal_missing, no state", () => {
    const state = new LeaseState()
    expectErrorCode("terminal_missing", () =>
      state.acquire({ terminalID, generation, actor: [] as unknown as typeof agent, now: 1000 }),
    )
    expect(state.inspect()).toBeUndefined()
  })

  test("actor missing callID -> terminal_missing, no state", () => {
    const state = new LeaseState()
    const partial = { type: "agent" as const, sessionID: "s1", agentID: "a1" } as unknown as typeof agent
    expectErrorCode("terminal_missing", () => state.acquire({ terminalID, generation, actor: partial, now: 1000 }))
    expect(state.inspect()).toBeUndefined()
  })
})

describe("LeaseState: invalid timestamps in validate", () => {
  test("negative now -> terminal_missing, lease not cleared", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("terminal_missing", () =>
      state.validate({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: -1 }),
    )
    expect(state.inspect()?.id).toBe(lease.id)
  })

  test("fractional now -> terminal_missing, lease not cleared", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("terminal_missing", () =>
      state.validate({
        terminalID,
        generation,
        leaseID: lease.id,
        actor: agent,
        revision: lease.revision,
        now: 1500.5,
      }),
    )
    expect(state.inspect()?.id).toBe(lease.id)
  })

  test("NaN now -> terminal_missing, lease NOT cleared", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("terminal_missing", () =>
      state.validate({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: NaN }),
    )
    // Critical: NaN must NOT reach isActive() and clear an active lease.
    expect(state.inspect()?.id).toBe(lease.id)
  })

  test("Infinity now -> terminal_missing, lease not cleared", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("terminal_missing", () =>
      state.validate({
        terminalID,
        generation,
        leaseID: lease.id,
        actor: agent,
        revision: lease.revision,
        now: Infinity,
      }),
    )
    expect(state.inspect()?.id).toBe(lease.id)
  })
})

describe("LeaseState: NaN now in checkTimeout does not clear active lease", () => {
  test("checkTimeout(NaN) leaves lease intact", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("terminal_missing", () => state.checkTimeout(NaN))
    expect(state.inspect()?.id).toBe(lease.id)
  })

  test("checkTimeout(-1) leaves lease intact", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("terminal_missing", () => state.checkTimeout(-1))
    expect(state.inspect()?.id).toBe(lease.id)
  })

  test("checkTimeout(fractional) leaves lease intact", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("terminal_missing", () => state.checkTimeout(1000.5))
    expect(state.inspect()?.id).toBe(lease.id)
  })
})

describe("LeaseState: invalid revision and generation in transitions", () => {
  test("negative revision in refresh -> terminal_missing, lease unchanged", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("terminal_missing", () =>
      state.refresh({ terminalID, generation, leaseID: lease.id, actor: agent, revision: -1, now: 2000 }),
    )
    expect(state.inspect()?.revision).toBe(0)
  })

  test("unsafe generation (> MAX_SAFE_INTEGER) in acquire -> terminal_missing", () => {
    const state = new LeaseState()
    expectErrorCode("terminal_missing", () =>
      state.acquire({ terminalID, generation: Number.MAX_SAFE_INTEGER + 1, actor: agent, now: 1000 }),
    )
    expect(state.inspect()).toBeUndefined()
  })

  test("NaN revision in release -> terminal_missing, lease not cleared", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("terminal_missing", () =>
      state.release({
        terminalID,
        generation,
        leaseID: lease.id,
        actor: agent,
        revision: NaN as unknown as number,
      }),
    )
    expect(state.inspect()?.id).toBe(lease.id)
  })

  test("empty leaseID in refresh -> terminal_missing, lease unchanged", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("terminal_missing", () =>
      state.refresh({ terminalID, generation, leaseID: "", actor: agent, revision: lease.revision, now: 2000 }),
    )
    expect(state.inspect()?.revision).toBe(0)
  })

  test("NaN generation in validate -> terminal_missing, lease intact", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: agent, now: 1000 })
    expectErrorCode("terminal_missing", () =>
      state.validate({
        terminalID,
        generation: NaN as unknown as number,
        leaseID: lease.id,
        actor: agent,
        revision: lease.revision,
        now: 2000,
      }),
    )
    expect(state.inspect()?.id).toBe(lease.id)
  })
})

describe("LeaseState: state unchanged after every rejection (matrix)", () => {
  // acquire-invalid-actor tests use a FRESH state (no existing lease) so the
  // only failure path is actor validation — an active-lease collision would
  // mask the actor defect. refresh/validate/release/checkTimeout tests use a
  // state with exactly one lease and a captured handle.

  test("acquire with undefined actor on fresh state", () => {
    const state = new LeaseState()
    expectErrorCode("terminal_missing", () =>
      state.acquire({ terminalID, generation, actor: undefined as unknown as typeof agent, now: 1000 }),
    )
    expect(state.inspect()).toBeUndefined()
  })

  test("acquire with human actor on fresh state", () => {
    const state = new LeaseState()
    expectErrorCode("terminal_missing", () =>
      state.acquire({
        terminalID,
        generation,
        actor: { type: "human", clientID: "c1" } as unknown as typeof agent,
        now: 1000,
      }),
    )
    expect(state.inspect()).toBeUndefined()
  })

  test("acquire with NaN now on fresh state", () => {
    const state = new LeaseState()
    expectErrorCode("terminal_missing", () =>
      state.acquire({ terminalID, generation, actor: agent, now: NaN as unknown as number }),
    )
    expect(state.inspect()).toBeUndefined()
  })

  test("refresh with missing sessionID actor leaves state unchanged", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: { ...agent }, now: 1000 })
    const before = state.inspect()
    expectErrorCode("terminal_missing", () =>
      state.refresh({
        terminalID,
        generation,
        leaseID: lease.id,
        actor: { type: "agent", agentID: "a1", callID: "k1" } as unknown as typeof agent,
        revision: lease.revision,
        now: 2000,
      }),
    )
    expect(state.inspect()).toEqual(before)
  })

  test("refresh with NaN now leaves state unchanged", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: { ...agent }, now: 1000 })
    const before = state.inspect()
    expectErrorCode("terminal_missing", () =>
      state.refresh({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: NaN }),
    )
    expect(state.inspect()).toEqual(before)
  })

  test("validate with NaN now leaves active lease intact", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: { ...agent }, now: 1000 })
    const before = state.inspect()
    expectErrorCode("terminal_missing", () =>
      state.validate({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: NaN }),
    )
    expect(state.inspect()).toEqual(before)
  })

  test("validate with negative now leaves active lease intact", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: { ...agent }, now: 1000 })
    const before = state.inspect()
    expectErrorCode("terminal_missing", () =>
      state.validate({ terminalID, generation, leaseID: lease.id, actor: agent, revision: lease.revision, now: -5 }),
    )
    expect(state.inspect()).toEqual(before)
  })

  test("release with NaN revision leaves active lease intact", () => {
    const state = new LeaseState()
    const lease = state.acquire({ terminalID, generation, actor: { ...agent }, now: 1000 })
    const before = state.inspect()
    expectErrorCode("terminal_missing", () =>
      state.release({ terminalID, generation, leaseID: lease.id, actor: agent, revision: NaN as unknown as number }),
    )
    expect(state.inspect()).toEqual(before)
  })

  test("checkTimeout with NaN does not clear active lease", () => {
    const state = new LeaseState()
    state.acquire({ terminalID, generation, actor: { ...agent }, now: 1000 })
    const before = state.inspect()
    expectErrorCode("terminal_missing", () => state.checkTimeout(NaN))
    expect(state.inspect()).toEqual(before)
  })
})
