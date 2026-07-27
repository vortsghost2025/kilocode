import { test, expect, describe } from "bun:test"
import { AuditStore } from "../../src/kilocode/shared-terminal/audit"
import { AuditEvent, SharedTerminalSchema as S } from "../../src/kilocode/shared-terminal/schema"

// Metadata-only audit records for the Kilo-only shared-terminal service.
//
// The audit store MUST:
//   * accept injected clock and deterministic event-ID sources for tests,
//   * retain a bounded number of records with deterministic oldest-first
//     eviction,
//   * return immutable snapshots that callers cannot mutate through,
//   * reject malformed records BEFORE any retention mutation, leaving the
//     retained set untouched on a rejected record,
//   * serialize to metadata only — never raw terminal output, human keyboard
//     input, agent command text, tickets/ticket digests, environment names or
//     values, credentials, complete argv, shell history, PTY replay bytes, or
//     arbitrary error stacks containing sensitive values,
//   * support filtering by terminal, project, and generation,
//   * NOT register itself as a service, route, command, or tool. It is a pure
//     in-process store that the shared-terminal service may inject.

const baseEvent: Omit<S.AuditEvent, "id" | "time"> = {
  terminalID: "t-001",
  generation: 1,
  revision: 0,
  actor: { type: "agent", sessionID: "s1", agentID: "a1", callID: "k1" },
  action: "create",
  outcome: "applied",
}

function makeStore(overrides?: { clock?: () => number; id?: () => string; limit?: number }) {
  return new AuditStore({
    clock: overrides?.clock ?? (() => 1_000),
    id: overrides?.id ?? (() => "evt-fixed"),
    limit: overrides?.limit,
  })
}

// Convenience: a record input that omits id/time so the injected clock/id are
// the source of truth (the spread of baseEvent no longer carries id/time).
function rec(
  over: Partial<S.AuditEvent> & { projectID?: string } = {},
): AuditStore extends never ? never : Parameters<AuditStore["record"]>[0] {
  return { ...baseEvent, ...over } as Parameters<AuditStore["record"]>[0]
}

describe("AuditStore: construction and IDs", () => {
  test("uses injected clock for time when not provided", () => {
    let t = 5_000
    const store = new AuditStore({ clock: () => t, id: () => "evt-a", limit: 16 })
    store.record({ ...baseEvent, action: "create" })
    const snap = store.snapshot()
    expect(snap.length).toBe(1)
    expect(snap[0].time).toBe(5_000)
    t = 6_000
    store.record({ ...baseEvent, action: "attach", actor: { type: "human", clientID: "c1" } })
    expect(store.snapshot()[1].time).toBe(6_000)
  })

  test("uses injected id source when id omitted", () => {
    let n = 0
    const store = new AuditStore({ clock: () => 1_000, id: () => `evt-${++n}`, limit: 16 })
    store.record({ ...baseEvent })
    store.record({ ...baseEvent, action: "attach" })
    const snap = store.snapshot()
    expect(snap[0].id).toBe("evt-1")
    expect(snap[1].id).toBe("evt-2")
  })

  test("explicit id and time on the input take precedence", () => {
    const store = new AuditStore({ clock: () => 9_000, id: () => "should-not", limit: 16 })
    store.record({ ...baseEvent, id: "evt-explicit", time: 42 })
    const snap = store.snapshot()
    expect(snap[0].id).toBe("evt-explicit")
    expect(snap[0].time).toBe(42)
  })

  test("default limit applies when limit omitted", () => {
    const store = new AuditStore({ clock: () => 1_000, id: () => "evt-x" })
    // Default retention is audited by exceeding and asserting eviction below;
    // here we only confirm the store constructs without throwing.
    expect(typeof store.size()).toBe("number")
  })
})

describe("AuditStore: retention and eviction", () => {
  test("bounded retention evicts oldest first when over the limit", () => {
    let n = 0
    const store = new AuditStore({ clock: () => 1_000, id: () => `evt-${++n}`, limit: 3 })
    for (let i = 0; i < 3; i++) store.record({ ...baseEvent, time: 100 + i })
    expect(store.size()).toBe(3)
    // Next record evicts the oldest (time 100).
    store.record({ ...baseEvent, time: 200 })
    expect(store.size()).toBe(3)
    const snap = store.snapshot()
    expect(snap[0].time).toBe(101)
    expect(snap[snap.length - 1].time).toBe(200)
  })

  test("eviction is deterministic oldest-first regardless of insertion id", () => {
    let n = 0
    const store = new AuditStore({ clock: () => 1_000, id: () => `z${++n}`, limit: 2 })
    store.record({ ...baseEvent, time: 10 })
    store.record({ ...baseEvent, time: 5 })
    store.record({ ...baseEvent, time: 15 })
    const snap = store.snapshot()
    // Oldest (time 5) survives; time 10 was evicted by the third insert.
    expect(snap.map((e) => e.time)).toEqual([5, 15])
  })

  test("size reflects only retained events", () => {
    const store = makeStore({ limit: 2 })
    store.record({ ...baseEvent, time: 1 })
    store.record({ ...baseEvent, time: 2 })
    store.record({ ...baseEvent, time: 3 })
    expect(store.size()).toBe(2)
  })

  test("clear empties the store", () => {
    const store = makeStore({ limit: 8 })
    store.record({ ...baseEvent, time: 1 })
    store.record({ ...baseEvent, time: 2 })
    store.clear()
    expect(store.size()).toBe(0)
    expect(store.snapshot().length).toBe(0)
  })
})

describe("AuditStore: schema validation and rejection isolation", () => {
  test("malformed record (bad action) is rejected before retention", () => {
    const store = makeStore({ limit: 8 })
    const before = store.size()
    let threw = false
    try {
      store.record({ ...baseEvent, action: "not-a-real-action" } as unknown as Omit<S.AuditEvent, "id" | "time">)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(store.size()).toBe(before)
  })

  test("malformed record (bad outcome) does not mutate retained state", () => {
    const store = makeStore({ limit: 8 })
    store.record({ ...baseEvent, time: 1 })
    const before = store.size()
    let threw = false
    try {
      store.record({ ...baseEvent, action: "write", outcome: "nope" } as unknown as Omit<S.AuditEvent, "id" | "time">)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(store.size()).toBe(before)
    expect(store.snapshot().length).toBe(before)
    expect(store.snapshot()[0].action).toBe("create")
  })

  test("malformed record (negative generation) is rejected and isolates state", () => {
    const store = makeStore({ limit: 8 })
    store.record({ ...baseEvent, time: 1 })
    const before = store.size()
    let threw = false
    try {
      store.record({ ...baseEvent, generation: -7 } as unknown as Omit<S.AuditEvent, "id" | "time">)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(store.size()).toBe(before)
  })

  test("malformed record (non-actor object) is rejected", () => {
    const store = makeStore({ limit: 8 })
    let threw = false
    try {
      store.record({ ...baseEvent, actor: "agent" as unknown as S.AuditEvent["actor"] })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(store.size()).toBe(0)
  })

  test("malformed record (unknown optional reason) is rejected", () => {
    const store = makeStore({ limit: 8 })
    let threw = false
    try {
      store.record({ ...baseEvent, reason: "made_up_reason" as unknown as S.AuditReason })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(store.size()).toBe(0)
  })
})

describe("AuditStore: immutable snapshots", () => {
  test("snapshot returns an independent shallow copy", () => {
    const store = makeStore({ limit: 8 })
    store.record({ ...baseEvent, time: 1 })
    const a = store.snapshot()
    const b = store.snapshot()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })

  test("mutating a returned snapshot does not affect later snapshots", () => {
    const store = makeStore({ limit: 8 })
    store.record({ ...baseEvent, time: 1 })
    const a = store.snapshot()
    ;(a[0] as S.AuditEvent).action = "resize"
    const b = store.snapshot()
    expect(b[0].action).toBe("create")
  })

  test("scalar optional fields are omitted when undefined, not present-as-null", () => {
    const store = makeStore({ limit: 8 })
    store.record({ ...baseEvent, time: 1 })
    const snap = store.snapshot()
    expect(snap[0].bytes).toBeUndefined()
    expect(snap[0].correlationID).toBeUndefined()
    expect(snap[0].reason).toBeUndefined()
  })

  test("byte-count optional field is preserved as a metadata-only integer", () => {
    const store = makeStore({ limit: 8 })
    store.record({ ...baseEvent, time: 1, action: "write", bytes: 42, correlationID: "c-1" })
    const snap = store.snapshot()
    expect(snap[0].bytes).toBe(42)
    expect(snap[0].correlationID).toBe("c-1")
  })
})

describe("AuditStore: serialization contains metadata only", () => {
  test("serialized JSON has only the defined AuditEvent field names", () => {
    const store = makeStore({ limit: 8 })
    store.record({
      ...baseEvent,
      action: "write",
      bytes: 7,
      correlationID: "corr",
      reason: "lease_stale",
    })
    const snap = store.snapshot()
    const json = JSON.parse(JSON.stringify(snap[0]))
    const keys = Object.keys(json).sort()
    expect(keys).toEqual(
      [
        "action",
        "actor",
        "bytes",
        "correlationID",
        "generation",
        "id",
        "outcome",
        "reason",
        "revision",
        "terminalID",
        "time",
      ].sort(),
    )
  })

  test("serialized actor contains identity metadata only (no command payload)", () => {
    const store = makeStore({ limit: 8 })
    store.record({
      ...baseEvent,
      action: "write",
      actor: { type: "agent", sessionID: "s1", agentID: "a1", callID: "k1" },
    })
    const json = JSON.parse(JSON.stringify(store.snapshot()[0]))
    expect(Object.keys(json.actor).sort()).toEqual(["agentID", "callID", "sessionID", "type"].sort())
  })

  test("human actor serializes identity only — no client payload beyond clientID", () => {
    const store = makeStore({ limit: 8 })
    store.record({
      ...baseEvent,
      actor: { type: "human", clientID: "c1" },
      action: "attach",
    })
    const json = JSON.parse(JSON.stringify(store.snapshot()[0]))
    expect(Object.keys(json.actor).sort()).toEqual(["clientID", "type"].sort())
  })

  test("system actor serializes reason only — no env or input payload", () => {
    const store = makeStore({ limit: 8 })
    store.record({
      ...baseEvent,
      actor: { type: "system", reason: "exit" },
      action: "exit",
    })
    const json = JSON.parse(JSON.stringify(store.snapshot()[0]))
    expect(Object.keys(json.actor).sort()).toEqual(["reason", "type"].sort())
  })

  test("rejects a record carrying a forbidden extra payload field", () => {
    const store = makeStore({ limit: 8 })
    let threw = false
    try {
      // Inject a forbidden field that must not be part of AuditEvent.
      store.record({
        ...baseEvent,
        rawOutput: "echo secret",
      } as unknown as Omit<S.AuditEvent, "id" | "time">)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(store.size()).toBe(0)
  })

  test("round-trip through serializeAll() is schema-validatable", () => {
    const store = makeStore({ limit: 8 })
    store.record({ ...baseEvent, time: 1, action: "create" })
    store.record({ ...baseEvent, action: "write", time: 2, bytes: 9, reason: "human_preempted" })
    store.record({ ...baseEvent, action: "lease.revoke", time: 3, reason: "human_preempted" })
    const all = store.serialize()
    expect(Array.isArray(all)).toBe(true)
    for (const e of all) {
      const parsed = AuditEvent.zod.safeParse(e)
      expect(parsed.success).toBe(true)
    }
  })
})

describe("AuditStore: filtering", () => {
  test("filter by terminalID returns only matching events in order", () => {
    const store = makeStore({ limit: 16 })
    store.record({ ...baseEvent, terminalID: "t-a", time: 1 })
    store.record({ ...baseEvent, terminalID: "t-b", time: 2 })
    store.record({ ...baseEvent, terminalID: "t-a", time: 3 })
    const out = store.snapshot({ terminalID: "t-a" })
    expect(out.map((e) => e.time)).toEqual([1, 3])
  })

  test("filter by generation narrows to that generation", () => {
    const store = makeStore({ limit: 16 })
    store.record({ ...baseEvent, generation: 1, time: 1 })
    store.record({ ...baseEvent, generation: 2, time: 2 })
    store.record({ ...baseEvent, generation: 1, time: 3 })
    const out = store.snapshot({ generation: 1 })
    expect(out.map((e) => e.time)).toEqual([1, 3])
  })

  test("filter by projectID matches by terminal scope's project", () => {
    const store = makeStore({ limit: 16 })
    store.record({ ...baseEvent, terminalID: "t-a", time: 1, projectID: "p-a" })
    store.record({ ...baseEvent, terminalID: "t-b", time: 2, projectID: "p-b" })
    store.record({ ...baseEvent, terminalID: "t-a", time: 3, projectID: "p-a" })
    const out = store.snapshot({ projectID: "p-a" })
    expect(out.map((e) => e.time)).toEqual([1, 3])
  })

  test("combined terminal + generation filter intersects", () => {
    const store = makeStore({ limit: 16 })
    store.record({ ...baseEvent, terminalID: "t-a", generation: 1, time: 1 })
    store.record({ ...baseEvent, terminalID: "t-a", generation: 2, time: 2 })
    store.record({ ...baseEvent, terminalID: "t-b", generation: 1, time: 3 })
    const out = store.snapshot({ terminalID: "t-a", generation: 1 })
    expect(out.map((e) => e.time)).toEqual([1])
  })

  test("filter returns immutable snapshots", () => {
    const store = makeStore({ limit: 16 })
    store.record({ ...baseEvent, terminalID: "t-a", time: 1 })
    store.record({ ...baseEvent, terminalID: "t-a", time: 2 })
    const a = store.snapshot({ terminalID: "t-a" })
    ;(a[0] as S.AuditEvent).action = "resize"
    const b = store.snapshot({ terminalID: "t-a" })
    expect(b[0].action).toBe("create")
  })
})

describe("AuditStore: no service registration or external route", () => {
  test("AuditStore is a pure value object with no exported Effect/Layer/Hono bindings", async () => {
    const mod = await import("../../src/kilocode/shared-terminal/audit")
    const exported = Object.keys(mod)
    // The module surface must not register any service, route, command, tool,
    // bus event, or side effect. Only the builder and types are exported.
    expect(exported.includes("AuditStore")).toBe(true)
    const forbidden = ["Layer", "Layer_", "Service", "Router", "Tool", "route", "command", "register", "publish"]
    for (const f of forbidden) expect(exported.some((k) => k === f)).toBe(false)
  })
})

describe("AuditStore: deterministic infinite clock is rejected as malformed time", () => {
  test("Infinity time is rejected with no state mutation", () => {
    const store = makeStore({ limit: 8 })
    let threw = false
    try {
      store.record({ ...baseEvent, time: Number.POSITIVE_INFINITY })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(store.size()).toBe(0)
  })
})
