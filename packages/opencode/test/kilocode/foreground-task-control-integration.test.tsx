import { expect, test } from "bun:test"
import { ForegroundTask } from "../../src/kilocode/foreground-task"
import { Interrupt } from "../../src/kilocode/interrupt"
import { SessionID } from "../../src/session/schema"
import { mountPromptControl } from "../fixture/tui-control-harness"

type HarnessInput = Parameters<typeof mountPromptControl>[0]
type Cleanup = Parameters<NonNullable<HarnessInput["onRestore"]>>[0]
type Host = typeof globalThis & { window?: unknown }

const parentID = SessionID.make("ses_parent")
const childID = SessionID.make("ses_child")
const siblingID = SessionID.make("ses_sibling")

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
  const matching = await run({ matchingMetadata: true, runtimeOwnership: false })
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

test("runtime-only ownership completes exact-child interrupt lifecycle once", async () => {
  const harness = await mountPromptControl({
    parentID,
    childID,
    siblingID,
    matchingMetadata: false,
    runtimeOwnership: true,
  })

  try {
    expect(harness.active()).toBe(true)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    harness.advance(100)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    expect(harness.commandState.enabled).toBe(true)
    expect(harness.commandState.selected).toBe(2)
    expect(harness.abortSessionIDs).toEqual([childID])

    expect(harness.interruptRuntime()).toBe(true)
    await harness.renderOnce()
    expect(harness.active()).toBe(false)
    const success = harness.lifecycle().filter((result) => result.actions.some((action) => action.type === "success"))
    expect(success).toHaveLength(1)
    expect(success[0]?.state).toMatchObject({ pending: false, target: null })
    const notices = harness.toasts.filter(
      (toast) => toast.variant === "info" && toast.message === "Subagent stopped; context preserved.",
    )
    expect(notices).toHaveLength(1)

    const selected = harness.commandState.selected
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    expect(harness.commandState.enabled).toBe(false)
    expect(harness.commandState.selected).toBe(selected)

    harness.setMetadata(true)
    await harness.renderOnce()
    harness.setMetadata(false)
    await harness.renderOnce()
    expect(harness.lifecycle().filter((result) => result.actions.some((action) => action.type === "success"))).toHaveLength(1)
    expect(
      harness.toasts.filter(
        (toast) => toast.variant === "info" && toast.message === "Subagent stopped; context preserved.",
      ),
    ).toHaveLength(1)
    expect(harness.lifecycle().at(-1)?.state).toMatchObject({ pending: false, target: null })
  } finally {
    await harness.dispose()
  }
}, 30_000)

test("renderer cleanup restores animation-frame property presence", async () => {
  const harness = await mountPromptControl({
    parentID,
    childID,
    siblingID,
    matchingMetadata: false,
    runtimeOwnership: false,
  })
  const original = harness.frame.original

  await harness.dispose()
  expect(harness.frame.current()).toEqual(original)
}, 30_000)

test("mount failure restores probes before a subsequent normal harness", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Interrupt, "onForegroundTask")
  if (!descriptor) throw new Error("interrupt lifecycle reducer is unavailable")
  const host = globalThis as Host
  const frame = () => ({
    raf: globalThis.requestAnimationFrame,
    hasRaf: Object.prototype.hasOwnProperty.call(globalThis, "requestAnimationFrame"),
    caf: globalThis.cancelAnimationFrame,
    hasCaf: Object.prototype.hasOwnProperty.call(globalThis, "cancelAnimationFrame"),
  })
  const original = {
    frame: frame(),
    env: Object.getOwnPropertyDescriptor(process.env, "OTUI_USE_CONSOLE"),
    window: host.window,
    hasWindow: Object.prototype.hasOwnProperty.call(host, "window"),
    date: Date.now,
    timeout: globalThis.setTimeout,
    clear: globalThis.clearTimeout,
    sighup: [...process.listeners("SIGHUP")],
  }
  const failure = new Error("forced foreground harness mount failure")
  const cleanups: Cleanup[] = []
  const result = await mountPromptControl({
    parentID,
    childID,
    siblingID,
    matchingMetadata: false,
    runtimeOwnership: true,
    failure,
    onRestore: (evidence) => {
      cleanups.push(evidence)
    },
  }).then(
    (harness) => ({ harness }),
    (err: unknown) => ({ err }),
  )
  if ("harness" in result) {
    await result.harness.dispose()
    throw new Error("forced harness mount unexpectedly succeeded")
  }

  expect(result.err).toBe(failure)
  expect(Object.getOwnPropertyDescriptor(Interrupt, "onForegroundTask")).toEqual(descriptor)
  expect(frame()).toEqual(original.frame)
  expect(Object.getOwnPropertyDescriptor(process.env, "OTUI_USE_CONSOLE")).toEqual(original.env)
  expect(host.window).toBe(original.window)
  expect(Object.prototype.hasOwnProperty.call(host, "window")).toBe(original.hasWindow)
  expect(Date.now).toBe(original.date)
  expect(globalThis.setTimeout).toBe(original.timeout)
  expect(globalThis.clearTimeout).toBe(original.clear)
  expect(process.listeners("SIGHUP")).toEqual(original.sighup)
  expect(ForegroundTask.has(childID)).toBe(false)
  expect(ForegroundTask.has(siblingID)).toBe(false)
  expect(cleanups).toEqual([{ listeners: 0, pending: 0, rendererDestroyed: true, toastRestored: true }])

  const harness = await mountPromptControl({
    parentID,
    childID,
    siblingID,
    matchingMetadata: false,
    runtimeOwnership: true,
  })
  try {
    expect(harness.lifecycle()).toHaveLength(0)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    harness.advance(100)
    harness.trigger("session.interrupt")
    await harness.renderOnce()
    expect(harness.abortSessionIDs).toEqual([childID])
    expect(harness.interruptRuntime()).toBe(true)
    await harness.renderOnce()
    expect(harness.lifecycle()).toHaveLength(1)
    expect(harness.lifecycle()[0]?.actions).toEqual([{ type: "success" }])
    expect(harness.lifecycle()[0]?.state).toMatchObject({ pending: false, target: null })
  } finally {
    await harness.dispose()
  }
  expect(Object.getOwnPropertyDescriptor(Interrupt, "onForegroundTask")).toEqual(descriptor)
  expect(frame()).toEqual(original.frame)
  expect(Object.getOwnPropertyDescriptor(process.env, "OTUI_USE_CONSOLE")).toEqual(original.env)
  expect(ForegroundTask.has(childID)).toBe(false)
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
