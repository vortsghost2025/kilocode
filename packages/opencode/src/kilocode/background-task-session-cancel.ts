// kilocode_change - new file
import { SessionPrompt } from "@/session/prompt"
import { BackgroundTask } from "./background-task"
import { BackgroundTaskCancel } from "./background-task-cancel"
import { SubagentTaskControl } from "./subagent-task-control"

export namespace BackgroundTaskSessionCancel {
  export function cancel(handle: SubagentTaskControl.Handle): Promise<BackgroundTask.TransitionResult> {
    return BackgroundTaskCancel.cancel({
      handle,
      cancelChild: (childSessionID) => SessionPrompt.cancel(childSessionID),
    })
  }
}
