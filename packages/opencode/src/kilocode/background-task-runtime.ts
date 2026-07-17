// kilocode_change - new file
import type { MessageID, SessionID } from "@/session/schema"
import { BackgroundTaskStart } from "./background-task-start"
import { BackgroundTaskCompletion } from "./background-task-completion"
import { SubagentTaskControl } from "./subagent-task-control"

export namespace BackgroundTaskRuntime {
  type Settled = { ok: true; value: { resultMessageID: MessageID } } | { ok: false; error: unknown }
  type Status = "pending" | "active" | "released"

  interface State {
    status: Status
    ref: SubagentTaskControl.TaskRef
    authority: SubagentTaskControl.Handle | undefined
    settled: Promise<Settled> | undefined
    retained: Promise<void> | undefined
  }

  export interface Observer {
    activate(): Promise<void> | undefined
    release(): boolean
  }

  export interface Result extends BackgroundTaskStart.Result {
    observer: Observer
  }

  const active = new Map<string, Promise<void>>()

  function refKey(ref: SubagentTaskControl.TaskRef) {
    return `${ref.taskID}:${ref.generation}`
  }

  function revoke(state: State) {
    state.authority = undefined
  }

  function finish(state: State) {
    const retained = state.retained
    if (!retained) return
    const key = refKey(state.ref)
    if (active.get(key) === retained) active.delete(key)
    state.status = "released"
    revoke(state)
    state.settled = undefined
    state.retained = undefined
  }

  function observer(input: {
    ref: SubagentTaskControl.TaskRef
    handle: SubagentTaskControl.Handle
    settled: Promise<Settled>
  }): Observer {
    const state: State = {
      status: "pending",
      ref: input.ref,
      authority: input.handle,
      settled: input.settled,
      retained: undefined,
    }

    const resolveHandle = (): SubagentTaskControl.Handle | undefined => {
      return state.authority
    }

    return Object.freeze({
      activate() {
        if (state.status === "released") return undefined
        if (state.status === "active") return state.retained
        const authority = state.authority
        const settled = state.settled
        if (!authority || !settled) return undefined

        state.status = "active"
        const completion = settled.then((value) => {
          if (value.ok) return value.value
          throw value.error
        })
        const observed = BackgroundTaskCompletion.observe({ resolve: resolveHandle, completion })
        const retained: Promise<void> = observed.then(
          () => finish(state),
          () => finish(state),
        )
        state.retained = retained
        active.set(refKey(state.ref), retained)
        return retained
      },
      release() {
        if (state.status === "released") return false
        const retained = state.retained
        if (retained && active.get(refKey(state.ref)) === retained) active.delete(refKey(state.ref))
        state.status = "released"
        revoke(state)
        state.settled = undefined
        state.retained = undefined
        return true
      },
    })
  }

  export async function start(input: {
    ref: SubagentTaskControl.TaskRef
    handle: SubagentTaskControl.Handle
    childSessionID: SessionID
    childUserMessageID: MessageID
    launch: () => void
    completion: Promise<{ resultMessageID: MessageID }>
  }): Promise<Result> {
    const settled = input.completion.then<Settled, Settled>(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )
    const neverFailure = new Promise<never>(() => {})
    const startupFailure: Promise<{ error: unknown }> = settled.then((state) => {
      if (state.ok) return neverFailure
      return { error: state.error }
    })

    const result = await BackgroundTaskStart.start({
      ref: input.ref,
      handle: input.handle,
      childSessionID: input.childSessionID,
      launch: input.launch,
      startupFailure,
    })
    return {
      ...result,
      observer: observer({ ref: result.ref, handle: result.handle, settled }),
    }
  }

  export function isObserving(ref: SubagentTaskControl.TaskRef): boolean {
    return active.has(refKey(ref))
  }

  export function resetForTests() {
    active.clear()
  }
}
