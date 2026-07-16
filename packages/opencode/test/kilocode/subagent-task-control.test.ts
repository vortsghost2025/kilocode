import { afterEach, expect, test } from "bun:test"
import { BackgroundTask } from "../../src/kilocode/background-task"
import { SubagentTaskControl } from "../../src/kilocode/subagent-task-control"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

function sid() {
  return SessionID.make(Identifier.ascending("session"))
}

function mid() {
  return MessageID.make(Identifier.ascending("message"))
}

function provide<T>(directory: string, fn: () => T) {
  return Instance.provide({ directory, fn })
}

afterEach(() => Instance.disposeAll())

test("creates immutable non-authorizing references and parent-scoped views", async () => {
  await using tmp = await tmpdir()
  await provide(tmp.path, () => {
    const parent = sid()
    const foreign = sid()
    const created = SubagentTaskControl.create({
      parentSessionID: parent,
      agentID: "general",
      now: 10,
    })

    expect(created.info.execution).toBe("prepared")
    expect(created.info.cleanup).toBe("pending")
    expect(created.info.child).toBeUndefined()
    expect(created.info.agentID).toBe("general")
    expect(created.ref).toEqual({ taskID: created.info.ref.taskID, generation: 1 })
    expect(Object.isFrozen(created.ref)).toBe(true)
    expect(Object.isFrozen(created.info)).toBe(true)
    expect(JSON.parse(JSON.stringify(created.ref))).toEqual(created.ref)
    expect(JSON.stringify(created.ref)).not.toContain("owner")
    expect(JSON.stringify(created.info)).not.toContain("ownerToken")
    expect(JSON.stringify(created.handle)).toBe("{}")

    expect(SubagentTaskControl.inspect({ requesterParentSessionID: parent, ref: created.ref })).toEqual(created.info)
    expect(SubagentTaskControl.inspect({ requesterParentSessionID: foreign, ref: created.ref })).toBeUndefined()
    expect(SubagentTaskControl.list({ requesterParentSessionID: parent })).toEqual([created.info])
    expect(SubagentTaskControl.list({ requesterParentSessionID: foreign })).toEqual([])
    expect(
      SubagentTaskControl.inspect({
        requesterParentSessionID: parent,
        ref: { taskID: "task_missing", generation: 1 },
      }),
    ).toBeUndefined()
  })
})

test("rejects copied fake and task-reference-shaped handles", async () => {
  await using tmp = await tmpdir()
  await provide(tmp.path, () => {
    const created = SubagentTaskControl.create({ parentSessionID: sid(), agentID: "general" })
    const copied = { ...created.handle } as SubagentTaskControl.Handle
    const shaped = created.ref as unknown as SubagentTaskControl.Handle
    const forged = Object.freeze({}) as SubagentTaskControl.Handle

    expect(Reflect.ownKeys(created.handle)).toEqual([])
    expect(SubagentTaskControl.transitionToStarting(copied).applied).toBe(false)
    expect(SubagentTaskControl.transitionToStarting(shaped).applied).toBe(false)
    expect(SubagentTaskControl.transitionToStarting(forged).applied).toBe(false)
    expect(
      SubagentTaskControl.inspect({ requesterParentSessionID: created.info.parentSessionID, ref: created.ref })
        ?.execution,
    ).toBe("prepared")
  })
})

test("rejects active duplicates and invalidates stale generations on terminal replacement", async () => {
  await using tmp = await tmpdir()
  await provide(tmp.path, () => {
    const parent = sid()
    const first = SubagentTaskControl.create({
      taskID: "task_reused",
      parentSessionID: parent,
      agentID: "general",
      now: 20,
    })

    expect(() =>
      SubagentTaskControl.create({
        taskID: "task_reused",
        parentSessionID: parent,
        agentID: "general",
      }),
    ).toThrow("Background task already active")

    expect(SubagentTaskControl.transitionToFailed(first.handle, { error: new Error("done"), now: 21 }).applied).toBe(
      true,
    )
    const next = SubagentTaskControl.create({
      taskID: "task_reused",
      parentSessionID: parent,
      agentID: "explore",
      now: 22,
    })

    expect(next.ref.generation).toBe(2)
    expect(next.info.agentID).toBe("explore")
    expect(SubagentTaskControl.transitionToRunning(first.handle).applied).toBe(false)
    expect(SubagentTaskControl.inspect({ requesterParentSessionID: parent, ref: first.ref })).toBeUndefined()
    expect(SubagentTaskControl.transitionToRunning(next.handle, { now: 23 }).applied).toBe(true)

    expect(() =>
      SubagentTaskControl.create({
        taskID: "task_reused",
        parentSessionID: sid(),
        agentID: "general",
      }),
    ).toThrow("Background task already active")
  })
})

test("keeps project instances isolated and invalidates handles on disposal", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  const parent = sid()
  const created = await provide(first.path, () =>
    SubagentTaskControl.create({ taskID: "task_scoped", parentSessionID: parent, agentID: "general" }),
  )

  await provide(second.path, () => {
    expect(SubagentTaskControl.inspect({ requesterParentSessionID: parent, ref: created.ref })).toBeUndefined()
    const own = SubagentTaskControl.create({
      taskID: "task_scoped",
      parentSessionID: parent,
      agentID: "general",
    })
    expect(own.ref.generation).toBe(1)
    expect(SubagentTaskControl.transitionToStarting(created.handle).applied).toBe(false)
  })

  await provide(first.path, async () => {
    expect(SubagentTaskControl.inspect({ requesterParentSessionID: parent, ref: created.ref })).toBeDefined()
    await Instance.dispose()
  })
  await provide(first.path, () => {
    expect(SubagentTaskControl.inspect({ requesterParentSessionID: parent, ref: created.ref })).toBeUndefined()
    expect(SubagentTaskControl.transitionToStarting(created.handle).applied).toBe(false)
  })
})

test("represents optional child attachment without conflating task and child identities", async () => {
  await using tmp = await tmpdir()
  await provide(tmp.path, () => {
    const parent = sid()
    expect(() =>
      SubagentTaskControl.create({ parentSessionID: parent, agentID: "general", childSessionID: sid() }),
    ).toThrow("child attachment must be complete")
    expect(() =>
      SubagentTaskControl.create({ parentSessionID: parent, agentID: "general", childUserMessageID: mid() }),
    ).toThrow("child attachment must be complete")

    const created = SubagentTaskControl.create({
      taskID: "task_child",
      parentSessionID: parent,
      agentID: "general",
    })
    expect(created.info.child).toBeUndefined()

    const childSessionID = sid()
    const childUserMessageID = mid()
    const attached = SubagentTaskControl.attachChild(created.handle, { childSessionID, childUserMessageID })
    expect(attached.applied).toBe(true)
    expect(attached.info?.child).toEqual({ sessionID: childSessionID, userMessageID: childUserMessageID })
    expect(attached.info?.ref.taskID).not.toBe(childSessionID)
    expect(SubagentTaskControl.attachChild(created.handle, { childSessionID, childUserMessageID }).applied).toBe(false)

    expect(() =>
      SubagentTaskControl.create({
        taskID: childSessionID,
        parentSessionID: sid(),
        agentID: "general",
        childSessionID,
        childUserMessageID,
      }),
    ).toThrow("Background task handle must differ from child session")
  })
})

test("keeps execution cleanup and immutable terminal results independent", async () => {
  await using tmp = await tmpdir()
  await provide(tmp.path, () => {
    const created = SubagentTaskControl.create({ parentSessionID: sid(), agentID: "general" })
    const resultMessageID = mid()

    const starting = SubagentTaskControl.transitionToStarting(created.handle, { now: 29 })
    expect(starting.info?.execution).toBe("starting")
    expect(starting.info?.startedAt).toBe(29)
    expect(starting.info?.revision).toBe(1)
    expect(SubagentTaskControl.beginCleanup(created.handle).applied).toBe(false)

    const running = SubagentTaskControl.transitionToRunning(created.handle, { now: 30 })
    expect(running.applied).toBe(true)
    expect(running.info?.revision).toBe(2)
    const completed = SubagentTaskControl.transitionToCompleted(created.handle, { resultMessageID, now: 31 })
    expect(completed.info?.execution).toBe("completed")
    expect(completed.info?.cleanup).toBe("pending")
    expect(completed.info?.result).toEqual({ type: "success", resultMessageID })
    expect(Object.isFrozen(completed.info?.result)).toBe(true)

    const cleaning = SubagentTaskControl.beginCleanup(created.handle)
    expect(cleaning.info?.execution).toBe("completed")
    expect(cleaning.info?.cleanup).toBe("cleaning")
    expect(cleaning.info?.result).toEqual({ type: "success", resultMessageID })

    const cleaned = SubagentTaskControl.finishCleanup(created.handle)
    expect(cleaned.info?.execution).toBe("completed")
    expect(cleaned.info?.cleanup).toBe("cleaned")
    expect(cleaned.info?.result).toEqual({ type: "success", resultMessageID })
  })
})

test("projects compatibility views without exposing or sharing authoritative records", async () => {
  await using tmp = await tmpdir()
  await provide(tmp.path, () => {
    const parentSessionID = sid()
    const childSessionID = sid()
    const hidden = SubagentTaskControl.create({ parentSessionID, agentID: "general" })
    expect(BackgroundTask.get(hidden.ref.taskID)).toBeUndefined()
    expect(BackgroundTask.list({ parentSessionID })).toEqual([])

    const created = BackgroundTask.create({
      taskID: "bg_compat",
      parentSessionID,
      childSessionID,
      childUserMessageID: mid(),
      now: 40,
    })

    expect(created.info).toMatchObject({
      taskID: "bg_compat",
      parentSessionID,
      childSessionID,
      generation: 1,
      status: "queued",
      createdAt: 40,
    })
    expect("ownerToken" in created.info).toBe(false)
    expect(JSON.stringify(created.info)).not.toContain("ownerToken")

    created.info.status = "running"
    expect(BackgroundTask.get("bg_compat")?.status).toBe("queued")
    expect(BackgroundTask.transitionToRunning({ ...created.claim, now: 41 }).info?.status).toBe("running")
    expect(BackgroundTask.list({ parentSessionID })).toHaveLength(1)
    expect(BackgroundTask.list({ parentSessionID: sid() })).toEqual([])
  })
})
