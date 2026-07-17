// kilocode_change - new file
import { BackgroundTaskRuntime } from "./background-task-runtime"
import { SubagentSpawn } from "./subagent-spawn"
import { SubagentTaskControl } from "./subagent-task-control"

export namespace BackgroundSubagentStart {
  export type Input = SubagentSpawn.Input
  export type Result = Awaited<ReturnType<typeof BackgroundTaskRuntime.start>>

  export async function start(input: Input): Promise<Result> {
    const created = SubagentTaskControl.createBackground({
      parentSessionID: input.parentSessionID,
      agentID: input.agent,
    })

    try {
      const prepared = await SubagentSpawn.prepare(input)
      const attached = SubagentTaskControl.attachChild(created.handle, {
        childSessionID: prepared.childSessionID,
        childUserMessageID: prepared.childUserMessageID,
      })
      if (!attached.applied || !attached.info) throw new Error("Background task child attachment failed")

      return await BackgroundTaskRuntime.start({
        ref: created.ref,
        handle: created.handle,
        childSessionID: prepared.childSessionID,
        childUserMessageID: prepared.childUserMessageID,
        launch: prepared.launch,
        completion: prepared.completion,
      })
    } catch (err) {
      SubagentTaskControl.discardUnpublished(created.handle)
      throw err
    }
  }
}
