import { describe, expect, test, beforeEach } from "bun:test"
import {
  isEnabled,
  toggle,
  setEnabled,
  tryAcquire,
  release,
  pendingCount,
  enabledSessionIDs,
  reset,
  autoApproveRequest,
} from "../../src/kilocode/permission/auto-approve"

beforeEach(() => {
  reset()
})

function makeRequest(id: string, sessionID: string) {
  return { id, sessionID } as Parameters<typeof autoApproveRequest>[1]
}

describe("session-scoped auto-approve controller", () => {
  test("1. new session defaults OFF", () => {
    expect(isEnabled("s1")).toBe(false)
  })

  test("2. OFF request enters manual queue — reply calls=0", () => {
    let replyCalls = 0
    const req = makeRequest("p1", "s1")
    const { handled } = autoApproveRequest("s1", req, async () => {
      replyCalls++
      return {}
    })
    expect(handled).toBe(false)
    expect(replyCalls).toBe(0)
  })

  test("3. ON request for enabled session — exact request ID, reply once, one call, manual queue empty", async () => {
    const replyCalls: string[] = []
    setEnabled("s1", true)
    const req = makeRequest("p1", "s1")
    const { handled, promise } = autoApproveRequest("s1", req, async (input) => {
      replyCalls.push(input.requestID)
      return {}
    })
    expect(handled).toBe(true)
    await promise
    expect(replyCalls).toEqual(["p1"])
    expect(pendingCount("s1")).toBe(0)
  })

  test("4. duplicate event for same request causes one reply", () => {
    const replyCalls: string[] = []
    setEnabled("s1", true)
    const req = makeRequest("p1", "s1")
    const first = autoApproveRequest("s1", req, async (input) => {
      replyCalls.push(input.requestID)
      return {}
    })
    const second = autoApproveRequest("s1", req, async (input) => {
      replyCalls.push(input.requestID)
      return {}
    })
    expect(first.handled).toBe(true)
    expect(second.handled).toBe(false)
    return first.promise.then(() => {
      expect(replyCalls).toEqual(["p1"])
    })
  })

  test("5. two unique requests each resolve once", () => {
    const replyCalls: string[] = []
    setEnabled("s1", true)
    const r1 = autoApproveRequest("s1", makeRequest("p1", "s1"), async (input) => {
      replyCalls.push(input.requestID)
      return {}
    })
    const r2 = autoApproveRequest("s1", makeRequest("p2", "s1"), async (input) => {
      replyCalls.push(input.requestID)
      return {}
    })
    expect(r1.handled).toBe(true)
    expect(r2.handled).toBe(true)
    return Promise.all([r1.promise, r2.promise]).then(() => {
      expect(replyCalls).toEqual(["p1", "p2"])
    })
  })

  test("6. request from another session remains manual", () => {
    setEnabled("s1", true)
    const req = makeRequest("p1", "s2")
    const { handled } = autoApproveRequest("s2", req, async () => ({}))
    expect(handled).toBe(false)
    expect(isEnabled("s2")).toBe(false)
  })

  test("7. disable causes next request to remain manual", () => {
    const replyCalls: string[] = []
    setEnabled("s1", true)
    const r1 = autoApproveRequest("s1", makeRequest("p1", "s1"), async (input) => {
      replyCalls.push(input.requestID)
      return {}
    })
    expect(r1.handled).toBe(true)
    setEnabled("s1", false)
    const r2 = autoApproveRequest("s1", makeRequest("p2", "s1"), async (input) => {
      replyCalls.push(input.requestID)
      return {}
    })
    expect(r2.handled).toBe(false)
    return r1.promise.then(() => {
      expect(replyCalls).toEqual(["p1"])
    })
  })

  test("8. enable with existing pending requests resolves them once", () => {
    const replyCalls: string[] = []
    const pending = [makeRequest("p1", "s1"), makeRequest("p2", "s1"), makeRequest("p3", "s1")]
    setEnabled("s1", true)
    const results = pending.map((req) =>
      autoApproveRequest("s1", req, async (input) => {
        replyCalls.push(input.requestID)
        return {}
      }),
    )
    expect(results.every((r) => r.handled)).toBe(true)
    return Promise.all(results.map((r) => r.promise)).then(() => {
      expect(replyCalls).toEqual(["p1", "p2", "p3"])
    })
  })

  test("9. reply failure restores/retains manual request and allows retry", async () => {
    let callCount = 0
    setEnabled("s1", true)
    const req = makeRequest("p1", "s1")
    const first = autoApproveRequest("s1", req, async () => {
      callCount++
      throw new Error("network")
    })
    expect(first.handled).toBe(true)
    try {
      await first.promise
      throw new Error("should have rejected")
    } catch {
      expect(callCount).toBe(1)
      expect(pendingCount("s1")).toBe(0)
      const second = autoApproveRequest("s1", req, async (input) => {
        callCount++
        return {}
      })
      expect(second.handled).toBe(true)
      await second.promise
      expect(callCount).toBe(2)
    }
  })

  test("10. new controller/process state defaults OFF regardless of global config", () => {
    reset()
    expect(isEnabled("any-session")).toBe(false)
    expect(enabledSessionIDs()).toEqual([])
    expect(pendingCount("any-session")).toBe(0)
  })

  test("toggle returns new state", () => {
    expect(toggle("s1")).toBe(true)
    expect(toggle("s1")).toBe(false)
  })

  test("enabledSessionIDs lists only enabled sessions", () => {
    setEnabled("s1", true)
    setEnabled("s2", false)
    setEnabled("s3", true)
    expect(enabledSessionIDs()).toEqual(["s1", "s3"])
  })

  test("release allows re-acquire", () => {
    setEnabled("s1", true)
    expect(tryAcquire("s1", "p1")).toBe(true)
    expect(tryAcquire("s1", "p1")).toBe(false)
    release("s1", "p1")
    expect(tryAcquire("s1", "p1")).toBe(true)
  })
})
