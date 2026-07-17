import { afterEach, describe, expect, test } from "bun:test"
import { ForegroundTask } from "../../src/kilocode/foreground-task"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function scope(id: string) {
  return ProjectID.make(id)
}

async function provide<T>(fn: () => T) {
  await using tmp = await tmpdir({ git: true })
  return Instance.provide({ directory: tmp.path, fn })
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("kilocode foreground task registry", () => {
  test("register adds an entry and interrupt removes it exactly once", async () => {
    await provide(() => {
      const projectID = Instance.project.id
      const id = SessionID.make("foreground-task-a")
      const state = { calls: 0 }
      const dispose = ForegroundTask.register(projectID, id, {
        interrupt() {
          state.calls++
        },
      })

      expect(ForegroundTask.has(projectID, id)).toBe(true)
      expect(ForegroundTask.interrupt(projectID, id)).toBe(true)
      expect(state.calls).toBe(1)
      expect(ForegroundTask.has(projectID, id)).toBe(false)
      expect(ForegroundTask.interrupt(projectID, id)).toBe(false)

      dispose()
      expect(ForegroundTask.has(projectID, id)).toBe(false)
    })
  })

  test("disposer removes only its own entry", async () => {
    await provide(() => {
      const projectID = Instance.project.id
      const id = SessionID.make("foreground-task-b")
      const old = ForegroundTask.register(projectID, id, {
        interrupt() {},
      })

      expect(ForegroundTask.interrupt(projectID, id)).toBe(true)

      const next = ForegroundTask.register(projectID, id, {
        interrupt() {},
      })

      old()
      expect(ForegroundTask.has(projectID, id)).toBe(true)

      next()
      expect(ForegroundTask.has(projectID, id)).toBe(false)
    })
  })

  test("duplicate active registration is rejected", async () => {
    await provide(() => {
      const projectID = Instance.project.id
      const id = SessionID.make("foreground-task-c")
      const dispose = ForegroundTask.register(projectID, id, {
        interrupt() {},
      })

      expect(() =>
        ForegroundTask.register(projectID, id, {
          interrupt() {},
        }),
      ).toThrow(`Foreground task already registered for session ${id}`)

      dispose()
    })
  })

  test("interrupt on an absent scoped entry returns false", () => {
    const projectID = scope("foreground-project-missing")
    const id = SessionID.make("foreground-task-missing")
    expect(ForegroundTask.interrupt(projectID, id)).toBe(false)
    expect(ForegroundTask.has(projectID, id)).toBe(false)
  })

  test("timeout and observers remain isolated across projects with the same session id", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const firstID = await Instance.provide({ directory: first.path, fn: () => Instance.project.id })
    const secondID = await Instance.provide({ directory: second.path, fn: () => Instance.project.id })
    const id = SessionID.make("foreground-task-shared")
    const expired = deferred<void>()
    const firstEvents: boolean[] = []
    const secondEvents: boolean[] = []

    expect(firstID).not.toBe(secondID)

    const unwatchFirst = ForegroundTask.subscribe(firstID, id, (active) => firstEvents.push(active))
    const disposeFirst = ForegroundTask.register(
      firstID,
      id,
      {
        interrupt() {},
      },
      { timeoutMs: 0 },
    )

    const unwatchSecond = ForegroundTask.subscribe(secondID, id, (active) => secondEvents.push(active))
    expect(ForegroundTask.has(secondID, id)).toBe(false)
    ForegroundTask.register(
      secondID,
      id,
      {
        interrupt() {},
        timeout() {
          expired.resolve()
        },
      },
      { timeoutMs: 0 },
    )

    expect(ForegroundTask.timeout(scope("foreground-project-timeout-wrong"), id)).toBe(false)
    expect(ForegroundTask.timeout(secondID, id)).toBe(true)
    await expired.promise

    expect(ForegroundTask.has(secondID, id)).toBe(false)
    expect(secondEvents).toEqual([false, true, false])
    expect(ForegroundTask.has(firstID, id)).toBe(true)
    expect(firstEvents).toEqual([false, true])

    disposeFirst()
    expect(firstEvents).toEqual([false, true, false])
    unwatchFirst()
    unwatchSecond()
  })

  test("wrong-project interrupt cannot affect the matching session in another project", () => {
    const first = scope("foreground-project-interrupt-a")
    const second = scope("foreground-project-interrupt-b")
    const id = SessionID.make("foreground-task-interrupt-shared")
    const state = { calls: 0 }
    const dispose = ForegroundTask.register(first, id, {
      interrupt() {
        state.calls++
      },
    })

    expect(ForegroundTask.interrupt(second, id)).toBe(false)
    expect(state.calls).toBe(0)
    expect(ForegroundTask.has(first, id)).toBe(true)
    expect(ForegroundTask.interrupt(first, id)).toBe(true)
    expect(state.calls).toBe(1)
    dispose()
  })

  test("wrong-project completion cannot resolve the matching session in another project", () => {
    const first = scope("foreground-project-complete-a")
    const second = scope("foreground-project-complete-b")
    const id = SessionID.make("foreground-task-complete-shared")
    const message = {} as MessageV2.WithParts
    const state = { result: undefined as MessageV2.WithParts | undefined }
    const dispose = ForegroundTask.register(first, id, {
      interrupt() {},
      complete(result) {
        state.result = result
      },
    })

    expect(ForegroundTask.complete(second, id, message)).toBe(false)
    expect(state.result).toBeUndefined()
    expect(ForegroundTask.has(first, id)).toBe(true)
    expect(ForegroundTask.complete(first, id, message)).toBe(true)
    expect(state.result).toBe(message)
    expect(ForegroundTask.has(first, id)).toBe(false)
    dispose()
  })

  test("has and subscribe are safe without an Instance context", () => {
    const projectID = scope("foreground-project-no-context")
    const id = SessionID.make("foreground-task-no-context")
    const events: boolean[] = []

    expect(ForegroundTask.has(projectID, id)).toBe(false)
    const unsubscribe = ForegroundTask.subscribe(projectID, id, (active) => events.push(active))
    expect(events).toEqual([false])
    unsubscribe()
  })

  test("cleanup removes stale listeners before recreating a project bucket", () => {
    const projectID = scope("foreground-project-cleanup")
    const id = SessionID.make("foreground-task-cleanup")
    const stale: boolean[] = []
    const unsubscribe = ForegroundTask.subscribe(projectID, id, (active) => stale.push(active))

    unsubscribe()
    const first = ForegroundTask.register(projectID, id, { interrupt() {} }, { timeoutMs: 0 })
    first()
    expect(stale).toEqual([false])

    const events: boolean[] = []
    const next = ForegroundTask.subscribe(projectID, id, (active) => events.push(active))
    const dispose = ForegroundTask.register(projectID, id, { interrupt() {} }, { timeoutMs: 0 })
    expect(events).toEqual([false, true])
    dispose()
    expect(events).toEqual([false, true, false])
    next()
  })
})
