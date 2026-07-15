import { expect, test } from "bun:test"
import { mountPromptControl } from "../fixture/tui-control-harness"

const parentID = "ses_parent"
const childID = "ses_child"
const siblingID = "ses_sibling"

async function run(input: { matchingMetadata: boolean; runtimeOwnership: boolean }) {
  const harness = await mountPromptControl({ parentID, childID, siblingID, ...input })

  try {
    expect(harness.active()).toBe(input.runtimeOwnership)
    const sync = harness.syncEvidence()
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    harness.advance(100)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    return {
      registered: harness.commandState.registered,
      enabled: harness.commandState.enabled,
      selected: harness.commandState.selected,
      abortSessionIDs: [...harness.abortSessionIDs],
      sync,
    }
  } finally {
    await harness.dispose()
  }
}

test("runtime ownership and synchronized task metadata independently enable foreground interruption", async () => {
  const stale = await run({ matchingMetadata: false, runtimeOwnership: true })
  const matching = await run({ matchingMetadata: true, runtimeOwnership: true })
  const none = await run({ matchingMetadata: false, runtimeOwnership: false })

  console.log(
    JSON.stringify({
      stale: { ...stale, sync: { ...stale.sync, parts: stale.sync.parts.length } },
      matching: { ...matching, sync: { ...matching.sync, parts: matching.sync.parts.length } },
      none: { ...none, sync: { ...none.sync, parts: none.sync.parts.length } },
    }),
  )

  expect(stale.sync.status).toBeUndefined()
  expect(stale.sync.messages).toEqual([])
  expect(stale.sync.parts).toHaveLength(0)
  expect(stale.registered).toBe(true)
  expect(stale.enabled).toBe(true)
  expect(stale.selected).toBe(2)
  expect(stale.abortSessionIDs).toEqual([childID])

  expect(matching.sync.status).toBeUndefined()
  expect(matching.sync.messages).toEqual([`msg_${parentID}`])
  expect(matching.sync.parts).toHaveLength(1)
  expect(matching.sync.parts[0]).toMatchObject({
    tool: "task",
    state: { status: "running", metadata: { sessionId: childID } },
  })
  expect(matching.registered).toBe(true)
  expect(matching.enabled).toBe(true)
  expect(matching.selected).toBe(2)
  expect(matching.abortSessionIDs).toEqual([childID])

  expect(none.sync.status).toBeUndefined()
  expect(none.sync.messages).toEqual([])
  expect(none.sync.parts).toHaveLength(0)
  expect(none.registered).toBe(true)
  expect(none.enabled).toBe(false)
  expect(none.selected).toBe(0)
  expect(none.abortSessionIDs).toEqual([])
}, 30_000)



test("exact-child ownership updates after mount without sibling interference", async () => {
  const harness = await mountPromptControl({
    parentID,
    childID,
    siblingID,
    matchingMetadata: false,
    runtimeOwnership: false,
  })

  try {
    expect(harness.active()).toBe(false)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    expect(harness.commandState.registered).toBe(true)
    expect(harness.commandState.enabled).toBe(false)
    expect(harness.commandState.selected).toBe(0)
    expect(harness.abortSessionIDs).toEqual([])

    harness.registerRuntime(siblingID)
    await harness.renderOnce()
    expect(harness.active()).toBe(false)
    expect(harness.active(siblingID)).toBe(true)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    expect(harness.commandState.enabled).toBe(false)
    expect(harness.commandState.selected).toBe(0)
    expect(harness.abortSessionIDs).toEqual([])

    const disposeChild = harness.registerRuntime(childID)
    await harness.renderOnce()
    expect(harness.active()).toBe(true)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    harness.advance(100)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    expect(harness.commandState.enabled).toBe(true)
    expect(harness.commandState.selected).toBe(2)
    expect(harness.abortSessionIDs).toEqual([childID])

    disposeChild()
    await harness.renderOnce()
    expect(harness.active()).toBe(false)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    expect(harness.commandState.enabled).toBe(false)
    expect(harness.commandState.selected).toBe(2)
    expect(harness.abortSessionIDs).toEqual([childID])
  } finally {
    await harness.dispose()
  }
}, 30_000)

test("stale registration disposer cannot remove replacement ownership", async () => {
  const harness = await mountPromptControl({
    parentID,
    childID,
    siblingID,
    matchingMetadata: false,
    runtimeOwnership: false,
  })

  try {
    const disposeA = harness.registerRuntime(childID)
    await harness.renderOnce()
    expect(harness.active()).toBe(true)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    expect(harness.commandState.enabled).toBe(true)
    expect(harness.commandState.selected).toBe(1)

    expect(harness.interruptRuntime(childID)).toBe(true)
    expect(harness.active()).toBe(false)
    const disposeB = harness.registerRuntime(childID)
    disposeA()
    await harness.renderOnce()
    expect(harness.active()).toBe(true)
    harness.advance(100)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    expect(harness.commandState.enabled).toBe(true)
    expect(harness.commandState.selected).toBe(2)
    expect(harness.abortSessionIDs).toEqual([childID])

    disposeB()
    await harness.renderOnce()
    expect(harness.active()).toBe(false)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    expect(harness.commandState.enabled).toBe(false)
    expect(harness.commandState.selected).toBe(2)
    expect(harness.abortSessionIDs).toEqual([childID])
  } finally {
    await harness.dispose()
  }
}, 30_000)
