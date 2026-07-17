// kilocode_change - new file
import type { MessageID } from "@/session/schema"
import { BackgroundTask } from "./background-task"
import { SubagentTaskControl } from "./subagent-task-control"

export namespace BackgroundTaskCompletion {
  export interface Input {
    resolve: () => SubagentTaskControl.Handle | undefined
    completion: Promise<{ resultMessageID: MessageID }>
  }

  export function observe(input: Input): Promise<BackgroundTask.TransitionResult> {
    return input.completion.then(
      ({ resultMessageID }) => {
        const handle = input.resolve()
        if (!handle) return { applied: false, info: undefined }
        return BackgroundTask.projectTransition(SubagentTaskControl.transitionToCompleted(handle, { resultMessageID }))
      },
      (error) => {
        const handle = input.resolve()
        if (!handle) return { applied: false, info: undefined }
        return BackgroundTask.projectTransition(SubagentTaskControl.transitionToFailed(handle, { error }))
      },
    )
  }
}
