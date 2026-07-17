import { afterEach, describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session"
import { BackgroundTask } from "../../src/kilocode/background-task"
import { BackgroundTaskRuntime } from "../../src/kilocode/background-task-runtime"
import { SubagentTaskControl } from "../../src/kilocode/subagent-task-control"
import { tmpdir } from "../fixture/fixture"

function sid() {
  return SessionID.make(Identifier.ascending("session"))
}

function mid() {
  return MessageID.make(Identifier.ascending("message"))
}

function withInstance(directory: string, fn: () => Promise<void>) {
  return Instance.provide({ directory, fn })
}

type RuntimeInput = Omit<Parameters<typeof BackgroundTaskRuntime.start>[0], "ref" | "handle"> & {
  parentSessionID: SessionID
}

function startRaw(input: RuntimeInput) {
  const task = SubagentTaskControl.create({
    parentSessionID: input.parentSessionID,
    agentID: "background",
    childSessionID: input.childSessionID,
    childUserMessageID: input.childUserMessageID,
  })
  return BackgroundTaskRuntime.start({
    ref: task.ref,
    handle: task.handle,
    childSessionID: input.childSessionID,
    childUserMessageID: input.childUserMessageID,
    launch: input.launch,
    completion: input.completion,
  })
}

async function start(input: RuntimeInput) {
  const result = await startRaw(input)
  void result.observer.activate()
  return result
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function defer<T>(): Deferred<T> {
  let res: (value: T) => void
  let rej: (reason: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    res = resolve
    rej = reject
  })
  return { promise, resolve: res!, reject: rej! }
}

afterEach(async () => {
  BackgroundTaskRuntime.resetForTests()
  await Instance.disposeAll()
})

describe("BackgroundTaskRuntime", () => {
  test("original completion handlers are attached before launch executes", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    let thenCalls = 0
    const completion = new Promise<{ resultMessageID: MessageID }>((resolve) => {
      resolve({ resultMessageID: mid() })
    })
    const originalThen = completion.then

    try {
      Object.defineProperty(completion, "then", {
        value: function (onFulfilled: any, onRejected: any) {
          thenCalls++
          return originalThen.call(this, onFulfilled, onRejected)
        },
        configurable: true,
        writable: true,
      })

      await withInstance(tmp.path, async () => {
        await start({
          parentSessionID: parent,
          childSessionID: child,
          childUserMessageID: msg,
          launch: () => {
            expect(thenCalls).toBeGreaterThan(0)
            void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
          },
          completion,
        })
      })
    } finally {
      Object.defineProperty(completion, "then", {
        value: originalThen,
        configurable: true,
        writable: true,
      })
    }
  })

  test("start returns after TurnOpen without waiting for pending completion", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const p = start({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })

      const result = await Promise.race([
        p.then((r) => ({ returned: true as const, status: r.info.status })),
        Bun.sleep(200).then(() => ({ returned: false as const, status: "timeout" as const })),
      ])
      expect(result.returned).toBe(true)
      expect(result.status).toBe("running")

      completion.resolve({ resultMessageID: mid() })
    })
  })

  test("pending completion is retained after start returns", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const result = await start({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })

      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(true)
      expect(BackgroundTask.get(result.info.taskID)?.status).toBe("running")

      completion.resolve({ resultMessageID: mid() })
    })
  })

  test("fulfillment after start transitions running to completed", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const result = await start({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })

      const resultMsg = mid()
      completion.resolve({ resultMessageID: resultMsg })

      await Bun.sleep(20)
      const info = BackgroundTask.get(result.info.taskID)
      expect(info?.status).toBe("completed")
      expect(info?.resultMessageID).toBe(resultMsg)
    })
  })

  test("exact resultMessageID is stored after fulfillment", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const result = await start({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })

      const specificMsg = MessageID.make(Identifier.ascending("message"))
      completion.resolve({ resultMessageID: specificMsg })

      await Bun.sleep(20)
      const info = BackgroundTask.get(result.info.taskID)
      expect(info?.status).toBe("completed")
      expect(info?.resultMessageID).toBe(specificMsg)
    })
  })

  test("rejection transitions running to failed", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const result = await start({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })

      const err = new Error("child crashed")
      completion.reject(err)

      await Bun.sleep(20)
      const info = BackgroundTask.get(result.info.taskID)
      expect(info?.status).toBe("failed")
      expect(info?.error?.message).toBe("child crashed")
    })
  })

  test("observer retention removed after fulfillment", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const result = await start({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })

      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(true)
      completion.resolve({ resultMessageID: mid() })
      await Bun.sleep(20)
      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(false)
    })
  })

  test("observer retention removed after rejection", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const result = await start({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })

      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(true)
      completion.reject(new Error("boom"))
      await Bun.sleep(20)
      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(false)
    })
  })

  test("completion settling before TurnOpen still transitions to completed", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const result = await start({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })
      completion.resolve({ resultMessageID: mid() })
      await Bun.sleep(20)
      expect(BackgroundTask.get(result.info.taskID)?.status).toBe("completed")
    })
  })

  test("rejection before TurnOpen fails startup and marks task failed", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const err = new Error("early reject")
      completion.reject(err)
      let thrown: unknown
      try {
        await start({
          parentSessionID: parent,
          childSessionID: child,
          childUserMessageID: msg,
          launch: () => {},
          completion: completion.promise,
        })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBe(err)
      const tasks = SubagentTaskControl.list({ requesterParentSessionID: parent })
      expect(tasks.some((t) => t.execution === "failed")).toBe(true)
    })
  })

  test("early fulfillment is queued and applied once TurnOpen arrives", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const result = await start({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })
      const resultMsg = mid()
      completion.resolve({ resultMessageID: resultMsg })
      await Bun.sleep(20)
      const info = BackgroundTask.get(result.info.taskID)
      expect(info?.status).toBe("completed")
      expect(info?.resultMessageID).toBe(resultMsg)
    })
  })

  test("rejection during launch marks task failed and surfaces error", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const launchErr = new Error("launch boom")
      let thrown: unknown
      try {
        await start({
          parentSessionID: parent,
          childSessionID: child,
          childUserMessageID: msg,
          launch: () => {
            throw launchErr
          },
          completion: completion.promise,
        })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBe(launchErr)
      const tasksA = SubagentTaskControl.list({ requesterParentSessionID: parent })
      expect(tasksA.some((t) => t.execution === "failed")).toBe(true)
    })
  })

  test("rejection beats TurnOpen race and fails startup", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const err = new Error("race reject")
      completion.reject(err)
      void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
      let thrown: unknown
      try {
        await start({
          parentSessionID: parent,
          childSessionID: child,
          childUserMessageID: msg,
          launch: () => {},
          completion: completion.promise,
        })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBe(err)
      const tasksB = SubagentTaskControl.list({ requesterParentSessionID: parent })
      expect(tasksB.some((t) => t.execution === "failed")).toBe(true)
    })
  })

  test("cancellation after startup transitions running to cancelled", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const result = await start({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })

      const cancelled = SubagentTaskControl.transitionToCancelled(result.handle)
      expect(cancelled.applied).toBe(true)
      expect(cancelled.info?.execution).toBe("cancelled")
      completion.resolve({ resultMessageID: mid() })
    })
  })

  test("launch failure leaves task pending and reports launch error", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const launchErr = new Error("hard launch fail")
      let thrown: unknown
      try {
        await start({
          parentSessionID: parent,
          childSessionID: child,
          childUserMessageID: msg,
          launch: () => {
            throw launchErr
          },
          completion: completion.promise,
        })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBe(launchErr)
    })
  })

  test("production file imports only allowed dependencies", async () => {
    const source = await Bun.file(new URL("../../src/kilocode/background-task-runtime.ts", import.meta.url)).text()
    expect(source).not.toContain('from "../../src/kilocode/background-task"')
    expect(source).not.toContain('from "@/kilocode/background-task"')
  })

  test("settled completion activates exactly once after publication", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const resultMsg = mid()
    const completion = Promise.resolve({ resultMessageID: resultMsg })

    await withInstance(tmp.path, async () => {
      const result = await startRaw({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion,
      })

      expect(result.info.status).toBe("running")
      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(false)

      const first = result.observer.activate()
      expect(first).toBeInstanceOf(Promise)
      const second = result.observer.activate()
      expect(second).toBe(first)

      await first
      await Bun.sleep(20)

      const info = BackgroundTask.get(result.info.taskID)
      expect(info?.status).toBe("completed")
      expect(info?.resultMessageID).toBe(resultMsg)
      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(false)

      expect(result.observer.activate()).toBeUndefined()
    })
  })

  test("settled failure activates exactly once after publication", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const err = new Error("settled failure")
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const result = await startRaw({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })
      completion.reject(err)

      expect(result.info.status).toBe("running")
      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(false)

      const first = result.observer.activate()
      expect(first).toBeInstanceOf(Promise)
      const second = result.observer.activate()
      expect(second).toBe(first)

      await first
      await Bun.sleep(20)

      const info = BackgroundTask.get(result.info.taskID)
      expect(info?.status).toBe("failed")
      expect(info?.error?.message).toBe("settled failure")
      const inspected = SubagentTaskControl.inspect({ requesterParentSessionID: parent, ref: result.ref })
      const failure = inspected?.result
      expect(failure?.type).toBe("failure")
      if (failure?.type === "failure") expect(Object.isFrozen(failure.error)).toBe(true)
      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(false)

      expect(result.observer.activate()).toBeUndefined()
    })
  })

  test("unactivated observer release is idempotent and ignores late rejection", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    await withInstance(tmp.path, async () => {
      const result = await startRaw({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })

      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(false)
      expect(result.observer.release()).toBe(true)
      expect(result.observer.release()).toBe(false)
      expect(result.observer.activate()).toBeUndefined()
      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(false)

      completion.reject(new Error("late rejection"))
      await Bun.sleep(20)

      const info = BackgroundTask.get(result.info.taskID)
      expect(info?.status).toBe("running")
      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(false)
    })
  })

  test("observer release is exact and isolated between project instances", async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const parent = sid()
    const childA = sid()
    const msgA = mid()
    const childB = sid()
    const msgB = mid()

    const firstCompletion = defer<{ resultMessageID: MessageID }>()
    const secondCompletion = defer<{ resultMessageID: MessageID }>()

    let firstResult!: Awaited<ReturnType<typeof startRaw>>
    let secondResult!: Awaited<ReturnType<typeof startRaw>>
    let firstActivation!: Promise<void>
    let secondActivation!: Promise<void>

    await withInstance(first.path, async () => {
      firstResult = await startRaw({
        parentSessionID: parent,
        childSessionID: childA,
        childUserMessageID: msgA,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: childA })
        },
        completion: firstCompletion.promise,
      })
      firstActivation = firstResult.observer.activate()!
    })

    await withInstance(second.path, async () => {
      secondResult = await startRaw({
        parentSessionID: parent,
        childSessionID: childB,
        childUserMessageID: msgB,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: childB })
        },
        completion: secondCompletion.promise,
      })
      secondActivation = secondResult.observer.activate()!
    })

    const firstRef = firstResult.ref
    const secondRef = secondResult.ref

    expect(BackgroundTaskRuntime.isObserving(firstRef)).toBe(true)
    expect(BackgroundTaskRuntime.isObserving(secondRef)).toBe(true)

    expect(firstResult.observer.release()).toBe(true)
    expect(BackgroundTaskRuntime.isObserving(firstRef)).toBe(false)
    expect(BackgroundTaskRuntime.isObserving(secondRef)).toBe(true)

    expect(firstResult.observer.release()).toBe(false)
    expect(secondResult.observer.release()).toBe(true)
    expect(BackgroundTaskRuntime.isObserving(secondRef)).toBe(false)

    const resultMsgA = mid()
    const resultMsgB = mid()
    firstCompletion.resolve({ resultMessageID: resultMsgA })
    secondCompletion.resolve({ resultMessageID: resultMsgB })

    await firstActivation
    await secondActivation

    await withInstance(first.path, async () => {
      expect(BackgroundTaskRuntime.isObserving(firstRef)).toBe(false)
      const info = SubagentTaskControl.inspect({ requesterParentSessionID: parent, ref: firstRef })
      expect(info?.execution).toBe("running")
      expect(info?.result).toBeUndefined()
    })

    await withInstance(second.path, async () => {
      expect(BackgroundTaskRuntime.isObserving(secondRef)).toBe(false)
      const info = SubagentTaskControl.inspect({ requesterParentSessionID: parent, ref: secondRef })
      expect(info?.execution).toBe("running")
      expect(info?.result).toBeUndefined()
    })
  })
  test("active release then late rejection leaves task running and observer absent", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    let result!: Awaited<ReturnType<typeof startRaw>>
    let activation!: Promise<void>
    await withInstance(tmp.path, async () => {
      const r = await startRaw({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })
      activation = r.observer.activate()!
      result = r
    })

    expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(true)
    expect(result.observer.release()).toBe(true)
    expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(false)

    let rejected = false
    completion.promise.catch(() => {
      rejected = true
    })
    completion.reject(new Error("late rejection after release"))

    await activation

    expect(rejected).toBe(true)
    expect(result.observer.release()).toBe(false)

    await withInstance(tmp.path, async () => {
      expect(BackgroundTaskRuntime.isObserving(result.ref)).toBe(false)
      const info = SubagentTaskControl.inspect({ requesterParentSessionID: parent, ref: result.ref })
      expect(info?.execution).toBe("running")
      expect(info?.result).toBeUndefined()
    })
  })
  test("completion callback winning before release keeps a valid terminal transition", async () => {
    await using tmp = await tmpdir()
    const parent = sid()
    const child = sid()
    const msg = mid()
    const completion = defer<{ resultMessageID: MessageID }>()

    let result!: Awaited<ReturnType<typeof startRaw>>
    let activation!: Promise<void>
    await withInstance(tmp.path, async () => {
      const r = await startRaw({
        parentSessionID: parent,
        childSessionID: child,
        childUserMessageID: msg,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: child })
        },
        completion: completion.promise,
      })
      activation = r.observer.activate()!
      result = r

      const resultMsg = mid()
      completion.resolve({ resultMessageID: resultMsg })
      await activation

      expect(result.observer.release()).toBe(false)
    })

    await withInstance(tmp.path, async () => {
      const info = SubagentTaskControl.inspect({ requesterParentSessionID: parent, ref: result.ref })
      expect(info?.execution).toBe("completed")
      expect(info?.result?.type).toBe("success")
    })
  })
  test("one observer release cannot revoke or suppress another active observer", async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    const parent = sid()
    const childA = sid()
    const msgA = mid()
    const childB = sid()
    const msgB = mid()

    const aCompletion = defer<{ resultMessageID: MessageID }>()
    const bCompletion = defer<{ resultMessageID: MessageID }>()

    let aResult!: Awaited<ReturnType<typeof startRaw>>
    let bResult!: Awaited<ReturnType<typeof startRaw>>
    let aActivation!: Promise<void>
    let bActivation!: Promise<void>

    await withInstance(a.path, async () => {
      aResult = await startRaw({
        parentSessionID: parent,
        childSessionID: childA,
        childUserMessageID: msgA,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: childA })
        },
        completion: aCompletion.promise,
      })
      aActivation = aResult.observer.activate()!
    })

    await withInstance(b.path, async () => {
      bResult = await startRaw({
        parentSessionID: parent,
        childSessionID: childB,
        childUserMessageID: msgB,
        launch: () => {
          void Bus.publish(Session.Event.TurnOpen, { sessionID: childB })
        },
        completion: bCompletion.promise,
      })
      bActivation = bResult.observer.activate()!
    })

    expect(aResult.observer.release()).toBe(true)
    expect(BackgroundTaskRuntime.isObserving(aResult.ref)).toBe(false)
    expect(BackgroundTaskRuntime.isObserving(bResult.ref)).toBe(true)

    const aMsg = mid()
    aCompletion.resolve({ resultMessageID: aMsg })
    await aActivation

    await withInstance(a.path, async () => {
      const info = SubagentTaskControl.inspect({ requesterParentSessionID: parent, ref: aResult.ref })
      expect(info?.execution).toBe("running")
    })

    const bMsg = mid()
    await withInstance(b.path, async () => {
      bCompletion.resolve({ resultMessageID: bMsg })
      await bActivation
    })

    await withInstance(b.path, async () => {
      const info = SubagentTaskControl.inspect({ requesterParentSessionID: parent, ref: bResult.ref })
      expect(info?.execution).toBe("completed")
      expect(info?.result?.type).toBe("success")
    })
  })
})
