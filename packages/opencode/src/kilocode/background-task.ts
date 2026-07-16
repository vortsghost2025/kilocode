import { randomUUID } from "crypto"
import type { MessageID, SessionID } from "@/session/schema"
import { SubagentTaskControl } from "./subagent-task-control"

export namespace BackgroundTask {
  export type TaskID = SubagentTaskControl.TaskID
  export type Status = "queued" | "running" | "completed" | "failed" | "cancelled"
  export type Failure = SubagentTaskControl.Failure

  export interface Info {
    taskID: TaskID
    parentSessionID: SessionID
    childSessionID: SessionID
    childUserMessageID: MessageID
    generation: number
    status: Status
    createdAt: number
    startedAt: number | undefined
    completedAt: number | undefined
    resultMessageID: MessageID | undefined
    error: Failure | undefined
  }

  export type Claim = SubagentTaskControl.CompatibilityClaim

  export interface CreateInput {
    taskID?: TaskID
    parentSessionID: SessionID
    childSessionID: SessionID
    childUserMessageID: MessageID
    now?: number
  }

  export interface CreateResult {
    info: Info
    claim: Claim
  }

  export interface TransitionResult {
    applied: boolean
    info: Info | undefined
  }

  interface Time {
    now?: number
  }

  export interface RunningInput extends Claim, Time {}

  export interface CompletedInput extends Claim, Time {
    resultMessageID: MessageID
  }

  export interface FailedInput extends Claim, Time {
    error: unknown
  }

  export interface CancelledInput extends Claim, Time {}

  function status(execution: SubagentTaskControl.Execution): Status {
    if (execution === "completed") return "completed"
    if (execution === "failed") return "failed"
    if (execution === "cancelled") return "cancelled"
    if (execution === "running") return "running"
    return "queued"
  }

  function view(input: SubagentTaskControl.Info): Info {
    if (!input.child) throw new Error(`Background task child unavailable: ${input.ref.taskID}`)
    const result = input.result
    return {
      taskID: input.ref.taskID,
      parentSessionID: input.parentSessionID,
      childSessionID: input.child.sessionID,
      childUserMessageID: input.child.userMessageID,
      generation: input.ref.generation,
      status: status(input.execution),
      createdAt: input.createdAt,
      startedAt: input.startedAt,
      completedAt: input.terminalAt,
      resultMessageID: result?.type === "success" ? result.resultMessageID : undefined,
      error: result?.type === "failure" ? { ...result.error } : undefined,
    }
  }

  function outcome(input: SubagentTaskControl.TransitionResult): TransitionResult {
    return {
      applied: input.applied,
      info: input.info ? view(input.info) : undefined,
    }
  }

  export function create(input: CreateInput): CreateResult {
    const created = SubagentTaskControl.create({
      taskID: input.taskID ?? `bg_${randomUUID()}`,
      parentSessionID: input.parentSessionID,
      agentID: "background",
      childSessionID: input.childSessionID,
      childUserMessageID: input.childUserMessageID,
      now: input.now,
    })
    return {
      info: view(created.info),
      claim: SubagentTaskControl.compatibilityClaim(created.handle),
    }
  }

  export function get(taskID: TaskID) {
    const info = SubagentTaskControl.compatibilityGet(taskID)
    return info?.child ? view(info) : undefined
  }

  export function list(input?: { parentSessionID?: SessionID }) {
    return SubagentTaskControl.compatibilityList(input)
      .filter((info) => info.child)
      .map(view)
  }

  export function transitionToRunning(input: RunningInput) {
    return outcome(SubagentTaskControl.compatibilityRunning(input))
  }

  export function transitionToCompleted(input: CompletedInput) {
    return outcome(SubagentTaskControl.compatibilityCompleted(input))
  }

  export function transitionToFailed(input: FailedInput) {
    return outcome(SubagentTaskControl.compatibilityFailed(input))
  }

  export function transitionToCancelled(input: CancelledInput) {
    return outcome(SubagentTaskControl.compatibilityCancelled(input))
  }

  /** @internal Exported for tests. */
  export function resetForTests() {
    SubagentTaskControl.resetForTests()
  }
}
