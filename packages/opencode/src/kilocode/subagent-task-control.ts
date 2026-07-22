import { randomUUID } from "node:crypto"
import { Instance } from "@/project/instance"
import type { MessageID, SessionID } from "@/session/schema"

export namespace SubagentTaskControl {
  export type TaskID = string
  export type Execution = "prepared" | "starting" | "running" | "completed" | "failed" | "cancelled"
  export type Cleanup = "pending" | "cleaning" | "cleaned" | "cleanup_failed"

  export interface Failure {
    name?: string
    message: string
  }

  export type TerminalResult =
    | Readonly<{ type: "success"; resultMessageID: MessageID }>
    | Readonly<{ type: "failure"; error: Readonly<Failure> }>
    | Readonly<{ type: "cancelled" }>

  export type TaskRef = Readonly<{ taskID: TaskID; generation: number }>
  export type Child = Readonly<{ sessionID: SessionID; userMessageID: MessageID }>
  export type Retention = Readonly<{ retainUntil?: number }>

  export interface Info {
    ref: TaskRef
    parentSessionID: SessionID
    agentID: string
    child: Child | undefined
    execution: Execution
    cleanup: Cleanup
    revision: number
    createdAt: number
    startedAt: number | undefined
    terminalAt: number | undefined
    result: TerminalResult | undefined
    retention: Retention
  }

  const brand = Symbol("SubagentTaskControl.Handle")
  /** @internal An identity-only control capability. */
  export type Handle = Readonly<{ [brand]: true }>

  export interface CompatibilityClaim {
    taskID: TaskID
    generation: number
    ownerToken: symbol
  }

  export interface CreateInput {
    taskID?: TaskID
    parentSessionID: SessionID
    agentID: string
    childSessionID?: SessionID
    childUserMessageID?: MessageID
    retainUntil?: number
    now?: number
  }

  export interface CreateResult {
    ref: TaskRef
    handle: Handle
    info: Info
  }

  export interface TransitionResult {
    applied: boolean
    info: Info | undefined
  }

  interface Entry {
    taskID: TaskID
    generation: number
    ownerToken: symbol
    published: boolean
    parentSessionID: SessionID
    agentID: string
    childSessionID: SessionID | undefined
    childUserMessageID: MessageID | undefined
    execution: Execution
    cleanup: Cleanup
    revision: number
    createdAt: number
    startedAt: number | undefined
    terminalAt: number | undefined
    result: TerminalResult | undefined
    retainUntil: number | undefined
    slots: { startup: unknown | undefined; execution: unknown | undefined; cleanup: unknown | undefined }
  }

  interface State {
    entries: Map<TaskID, Entry>
    handles: WeakMap<Handle, CompatibilityClaim>
    disposed: boolean
  }

  interface Time {
    now?: number
  }

  const state = Instance.state(
    (): State => ({ entries: new Map(), handles: new WeakMap(), disposed: false }),
    async (current) => {
      current.disposed = true
      current.entries.clear()
    },
  )

  const live = (execution: Execution) => execution === "prepared" || execution === "starting" || execution === "running"
  const makeID = () => `task_${randomUUID()}`
  const makeBackgroundID = () => `bg_${randomUUID()}`
  const ref = (entry: Entry): TaskRef => Object.freeze({ taskID: entry.taskID, generation: entry.generation })
  const copyFailure = (input: Failure): Readonly<Failure> =>
    Object.freeze({ ...(input.name ? { name: input.name } : {}), message: input.message })

  const copyResult = (input: TerminalResult | undefined): TerminalResult | undefined => {
    if (!input) return undefined
    if (input.type === "success") return Object.freeze({ type: "success", resultMessageID: input.resultMessageID })
    if (input.type === "failure") return Object.freeze({ type: "failure", error: copyFailure(input.error) })
    return Object.freeze({ type: "cancelled" })
  }

  const child = (entry: Entry): Child | undefined => {
    if (!entry.childSessionID || !entry.childUserMessageID) return undefined
    return Object.freeze({ sessionID: entry.childSessionID, userMessageID: entry.childUserMessageID })
  }

  const view = (entry: Entry): Info =>
    Object.freeze({
      ref: ref(entry),
      parentSessionID: entry.parentSessionID,
      agentID: entry.agentID,
      child: child(entry),
      execution: entry.execution,
      cleanup: entry.cleanup,
      revision: entry.revision,
      createdAt: entry.createdAt,
      startedAt: entry.startedAt,
      terminalAt: entry.terminalAt,
      result: copyResult(entry.result),
      retention: Object.freeze({ ...(entry.retainUntil === undefined ? {} : { retainUntil: entry.retainUntil }) }),
    })

  const outcome = (applied: boolean, entry?: Entry): TransitionResult => ({
    applied,
    info: entry ? view(entry) : undefined,
  })
  const owns = (entry: Entry, claim: CompatibilityClaim) =>
    entry.generation === claim.generation && entry.ownerToken === claim.ownerToken
  const claim = (handle: Handle) => state().handles.get(handle)

  function entry(handle: Handle) {
    const found = claim(handle)
    if (!found) return undefined
    const current = state().entries.get(found.taskID)
    if (!current || !owns(current, found)) return undefined
    return current
  }

  function transition(handle: Handle, allow: (execution: Execution) => boolean, apply: (entry: Entry) => void) {
    const current = entry(handle)
    if (!current) return outcome(false)
    if (!allow(current.execution)) return outcome(false, current)
    apply(current)
    current.revision++
    return outcome(true, current)
  }

  function compatibilityTransition(
    input: CompatibilityClaim,
    allow: (execution: Execution) => boolean,
    apply: (entry: Entry) => void,
  ) {
    const current = state().entries.get(input.taskID)
    if (!current) return outcome(false)
    if (!owns(current, input) || !allow(current.execution)) return outcome(false, current)
    apply(current)
    current.revision++
    return outcome(true, current)
  }

  function error(input: unknown): Failure {
    if (input instanceof Error) return { name: input.name, message: input.message }
    if (typeof input === "object" && input !== null) {
      const value = input as Record<string, unknown>
      const name = typeof value.name === "string" ? value.name : undefined
      return {
        ...(name ? { name } : {}),
        message: typeof value.message === "string" ? value.message : String(input),
      }
    }
    return { message: String(input) }
  }

  function insert(input: CreateInput & { published: boolean }): CreateResult {
    const current = state()
    if (current.disposed) throw new Error("Subagent task control state is disposed")
    const taskID = input.taskID ?? makeID()
    if ((input.childSessionID === undefined) !== (input.childUserMessageID === undefined)) {
      throw new Error(`Subagent task child attachment must be complete: ${taskID}`)
    }
    if (input.childSessionID && taskID === input.childSessionID) {
      throw new Error(`Background task handle must differ from child session: ${taskID}`)
    }
    const prev = current.entries.get(taskID)
    if (prev && live(prev.execution)) throw new Error(`Background task already active: ${taskID}`)
    if (prev && prev.parentSessionID !== input.parentSessionID) {
      throw new Error(`Background task parent mismatch: ${taskID}`)
    }

    const ownerToken = Symbol(taskID)
    const next: Entry = {
      taskID,
      generation: prev ? prev.generation + 1 : 1,
      ownerToken,
      published: input.published,
      parentSessionID: input.parentSessionID,
      agentID: input.agentID,
      childSessionID: input.childSessionID,
      childUserMessageID: input.childUserMessageID,
      execution: "prepared",
      cleanup: "pending",
      revision: 0,
      createdAt: input.now ?? Date.now(),
      startedAt: undefined,
      terminalAt: undefined,
      result: undefined,
      retainUntil: input.retainUntil,
      slots: { startup: undefined, execution: undefined, cleanup: undefined },
    }
    current.entries.set(taskID, next)
    const handle = Object.freeze({}) as Handle
    current.handles.set(handle, { taskID, generation: next.generation, ownerToken })
    return { ref: ref(next), handle, info: view(next) }
  }

  export function create(input: CreateInput): CreateResult {
    return insert({ ...input, published: true })
  }

  export function createBackground(input: { parentSessionID: SessionID; agentID: string; now?: number }): CreateResult {
    return insert({
      taskID: makeBackgroundID(),
      parentSessionID: input.parentSessionID,
      agentID: input.agentID,
      now: input.now,
      published: false,
    })
  }

  export function publish(handle: Handle) {
    const current = entry(handle)
    if (!current) return outcome(false)
    if (current.published) return outcome(false, current)
    if (!current.childSessionID || !current.childUserMessageID) return outcome(false, current)
    current.published = true
    current.revision++
    return outcome(true, current)
  }

  export function discardUnpublished(handle: Handle) {
    const current = entry(handle)
    if (!current || current.published) return false
    const entries = state().entries
    if (entries.get(current.taskID) !== current) return false
    entries.delete(current.taskID)
    return true
  }

  export function inspect(input: { requesterParentSessionID: SessionID; ref: TaskRef }) {
    const current = state().entries.get(input.ref.taskID)
    if (!current) return undefined
    if (current.generation !== input.ref.generation) return undefined
    if (current.parentSessionID !== input.requesterParentSessionID) return undefined
    return view(current)
  }

  export function list(input: { requesterParentSessionID: SessionID }) {
    return [...state().entries.values()]
      .filter((entry) => entry.parentSessionID === input.requesterParentSessionID)
      .map(view)
  }

  export function attachChild(handle: Handle, input: { childSessionID: SessionID; childUserMessageID: MessageID }) {
    const current = entry(handle)
    if (!current) return outcome(false)
    if (current.execution !== "prepared") return outcome(false, current)
    if (current.taskID === input.childSessionID) {
      throw new Error(`Background task handle must differ from child session: ${current.taskID}`)
    }
    if (current.childSessionID || current.childUserMessageID) return outcome(false, current)
    current.childSessionID = input.childSessionID
    current.childUserMessageID = input.childUserMessageID
    current.revision++
    return outcome(true, current)
  }

  export function transitionToStarting(handle: Handle, input: Time = {}) {
    return transition(
      handle,
      (execution) => execution === "prepared",
      (entry) => {
        entry.execution = "starting"
        entry.startedAt = input.now ?? Date.now()
      },
    )
  }

  export function transitionToRunning(handle: Handle, input: Time = {}) {
    return transition(
      handle,
      (execution) => execution === "prepared" || execution === "starting",
      (entry) => {
        entry.execution = "running"
        entry.startedAt = input.now ?? Date.now()
      },
    )
  }

  export function transitionToCompleted(handle: Handle, input: Time & { resultMessageID: MessageID }) {
    return transition(
      handle,
      (execution) => execution === "running",
      (entry) => {
        entry.execution = "completed"
        entry.terminalAt = input.now ?? Date.now()
        entry.result = Object.freeze({ type: "success", resultMessageID: input.resultMessageID })
      },
    )
  }

  export function transitionToFailed(handle: Handle, input: Time & { error: unknown }) {
    return transition(
      handle,
      (execution) => execution === "prepared" || execution === "starting" || execution === "running",
      (entry) => {
        entry.execution = "failed"
        entry.terminalAt = input.now ?? Date.now()
        entry.result = Object.freeze({ type: "failure", error: copyFailure(error(input.error)) })
      },
    )
  }

  export function transitionToCancelled(handle: Handle, input: Time = {}) {
    return transition(
      handle,
      (execution) => execution === "prepared" || execution === "starting" || execution === "running",
      (entry) => {
        entry.execution = "cancelled"
        entry.terminalAt = input.now ?? Date.now()
        entry.result = Object.freeze({ type: "cancelled" })
      },
    )
  }

  export function beginCleanup(handle: Handle) {
    const current = entry(handle)
    if (!current) return outcome(false)
    if (live(current.execution) || current.cleanup !== "pending") return outcome(false, current)
    current.cleanup = "cleaning"
    current.revision++
    return outcome(true, current)
  }

  export function finishCleanup(handle: Handle) {
    const current = entry(handle)
    if (!current) return outcome(false)
    if (current.cleanup !== "cleaning") return outcome(false, current)
    current.cleanup = "cleaned"
    current.revision++
    return outcome(true, current)
  }

  export function failCleanup(handle: Handle) {
    const current = entry(handle)
    if (!current) return outcome(false)
    if (current.cleanup !== "cleaning") return outcome(false, current)
    current.cleanup = "cleanup_failed"
    current.revision++
    return outcome(true, current)
  }

  /** @internal Compatibility bridge for the existing BackgroundTask facade. */
  export function compatibilityClaim(handle: Handle): CompatibilityClaim {
    const found = claim(handle)
    if (!found) throw new Error("Subagent task control handle is unavailable")
    return { taskID: found.taskID, generation: found.generation, ownerToken: found.ownerToken }
  }

  /** @internal Compatibility bridge for existing background lifecycle adapters. */
  export function compatibilityGet(taskID: TaskID) {
    const current = state().entries.get(taskID)
    return current ? view(current) : undefined
  }

  /** @internal Compatibility bridge for existing background lifecycle adapters. */
  export function compatibilityList(input?: { parentSessionID?: SessionID }) {
    return [...state().entries.values()]
      .filter((entry) => !input?.parentSessionID || entry.parentSessionID === input.parentSessionID)
      .map(view)
  }

  /** @internal Compatibility bridge for existing background lifecycle adapters. */
  export function compatibilityRunning(input: CompatibilityClaim & Time) {
    return compatibilityTransition(
      input,
      (execution) => execution === "prepared",
      (entry) => {
        entry.execution = "running"
        entry.startedAt = input.now ?? Date.now()
      },
    )
  }

  /** @internal Compatibility bridge for existing background lifecycle adapters. */
  export function compatibilityCompleted(input: CompatibilityClaim & Time & { resultMessageID: MessageID }) {
    return compatibilityTransition(
      input,
      (execution) => execution === "running",
      (entry) => {
        entry.execution = "completed"
        entry.terminalAt = input.now ?? Date.now()
        entry.result = Object.freeze({ type: "success", resultMessageID: input.resultMessageID })
      },
    )
  }

  /** @internal Compatibility bridge for existing background lifecycle adapters. */
  export function compatibilityFailed(input: CompatibilityClaim & Time & { error: unknown }) {
    return compatibilityTransition(
      input,
      (execution) => execution === "prepared" || execution === "running",
      (entry) => {
        entry.execution = "failed"
        entry.terminalAt = input.now ?? Date.now()
        entry.result = Object.freeze({ type: "failure", error: copyFailure(error(input.error)) })
      },
    )
  }

  /** @internal Compatibility bridge for existing background lifecycle adapters. */
  export function compatibilityCancelled(input: CompatibilityClaim & Time) {
    return compatibilityTransition(
      input,
      (execution) => execution === "prepared" || execution === "running",
      (entry) => {
        entry.execution = "cancelled"
        entry.terminalAt = input.now ?? Date.now()
        entry.result = Object.freeze({ type: "cancelled" })
      },
    )
  }

  /** @internal Exported for focused tests. */
  export function resetForTests() {
    state().entries.clear()
  }
}
