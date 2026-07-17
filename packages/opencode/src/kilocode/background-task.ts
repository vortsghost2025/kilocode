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
    ref: SubagentTaskControl.TaskRef
    handle: SubagentTaskControl.Handle
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

  export function project(input: SubagentTaskControl.Info): Info {
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

  export function projectTransition(input: SubagentTaskControl.TransitionResult): TransitionResult {
    return {
      applied: input.applied,
      info: input.info ? project(input.info) : undefined,
    }
  }

  export function create(input: CreateInput): CreateResult {
    const created = input.taskID
      ? SubagentTaskControl.create({
          taskID: input.taskID,
          parentSessionID: input.parentSessionID,
          agentID: "background",
          childSessionID: input.childSessionID,
          childUserMessageID: input.childUserMessageID,
          now: input.now,
        })
      : (() => {
          const task = SubagentTaskControl.createBackground({
            parentSessionID: input.parentSessionID,
            agentID: "background",
            now: input.now,
          })
          try {
            const attached = SubagentTaskControl.attachChild(task.handle, {
              childSessionID: input.childSessionID,
              childUserMessageID: input.childUserMessageID,
            })
            if (!attached.applied || !attached.info) throw new Error("Background task child attachment failed")
            const published = SubagentTaskControl.publish(task.handle)
            if (!published.applied || !published.info) throw new Error("Background task publication failed")
            return { ...task, info: published.info }
          } catch (err) {
            SubagentTaskControl.discardUnpublished(task.handle)
            throw err
          }
        })()
    return {
      info: project(created.info),
      claim: SubagentTaskControl.compatibilityClaim(created.handle),
      ref: created.ref,
      handle: created.handle,
    }
  }

  export function get(taskID: TaskID) {
    const info = SubagentTaskControl.compatibilityGet(taskID)
    return info?.child ? project(info) : undefined
  }

  export function list(input?: { parentSessionID?: SessionID }) {
    return SubagentTaskControl.compatibilityList(input)
      .filter((info) => info.child)
      .map(project)
  }

  export function transitionToRunning(input: RunningInput) {
    return projectTransition(SubagentTaskControl.compatibilityRunning(input))
  }

  export function transitionToCompleted(input: CompletedInput) {
    return projectTransition(SubagentTaskControl.compatibilityCompleted(input))
  }

  export function transitionToFailed(input: FailedInput) {
    return projectTransition(SubagentTaskControl.compatibilityFailed(input))
  }

  export function transitionToCancelled(input: CancelledInput) {
    return projectTransition(SubagentTaskControl.compatibilityCancelled(input))
  }

  /** @internal Exported for tests. */
  export function resetForTests() {
    SubagentTaskControl.resetForTests()
  }
}
