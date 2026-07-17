// kilocode_change - new file
import { MessageV2 } from "@/session/message-v2"
import { Instance } from "@/project/instance"
import type { SessionID } from "@/session/schema"
import { BackgroundSubagentStart } from "./background-subagent-start"
import { BackgroundTask } from "./background-task"
import { BackgroundTaskSessionCancel } from "./background-task-session-cancel"
import { SubagentTaskControl } from "./subagent-task-control"

export namespace BackgroundSubagentControl {
  export interface HandleInput {
    parentSessionID: SessionID
    taskID: BackgroundTask.TaskID
  }

  export interface ResultView {
    info: BackgroundTask.Info
    message: MessageV2.WithParts | undefined
  }

  // Temporary A6D1 control-capability retention. Remove in A6D2.
  const handles = Instance.state(
    () => new Map<BackgroundTask.TaskID, SubagentTaskControl.Handle>(),
    async (current) => current.clear(),
  )

  export async function start(input: BackgroundSubagentStart.Input): Promise<BackgroundTask.Info> {
    const started = await BackgroundSubagentStart.start(input)
    const published = SubagentTaskControl.publish(started.handle)
    if (!published.applied || !published.info) {
      started.observer.release()
      SubagentTaskControl.discardUnpublished(started.handle)
      throw new Error("Background task publication failed")
    }
    handles().set(published.info.ref.taskID, started.handle)
    void started.observer.activate()
    return BackgroundTask.project(published.info)
  }

  export function status(input: HandleInput): BackgroundTask.Info | undefined {
    const info = BackgroundTask.get(input.taskID)
    if (!info) return undefined
    if (info.parentSessionID !== input.parentSessionID) return undefined
    return info
  }

  export async function result(input: HandleInput): Promise<ResultView | undefined> {
    const info = status(input)
    if (!info) return undefined
    if (info.status !== "completed") return { info, message: undefined }
    if (!info.resultMessageID) {
      throw new Error(`Background task completed without result message: ${input.taskID}`)
    }
    const message = await MessageV2.get({
      sessionID: info.childSessionID,
      messageID: info.resultMessageID,
    })
    return { info, message }
  }

  export async function cancel(input: HandleInput): Promise<BackgroundTask.TransitionResult | undefined> {
    const info = status(input)
    if (!info) return undefined
    const handle = handles().get(input.taskID)
    if (!handle) throw new Error(`Background task handle unavailable: ${input.taskID}`)
    return BackgroundTaskSessionCancel.cancel(handle)
  }

  /** @internal Exported for tests. */
  export function resetForTests() {
    handles().clear()
  }
}
