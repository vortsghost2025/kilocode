// kilocode_change - new file
import type { SessionID } from "@/session/schema"
import { BackgroundTask } from "./background-task"
import { BackgroundTaskStartAck } from "./background-task-start-ack"
import { SubagentTaskControl } from "./subagent-task-control"

export namespace BackgroundTaskStart {
  export interface Input {
    ref: SubagentTaskControl.TaskRef
    handle: SubagentTaskControl.Handle
    childSessionID: SessionID
    launch: () => void
    startupFailure?: Promise<{
      error: unknown
    }>
  }

  export interface Result {
    info: BackgroundTask.Info
    ref: SubagentTaskControl.TaskRef
    handle: SubagentTaskControl.Handle
  }

  type Ready = { type: "opened" } | { type: "startup-failed"; error: unknown } | { type: "ack-failed"; error: unknown }

  export async function start(input: Input): Promise<Result> {
    const controller = new AbortController()
    const ack = BackgroundTaskStartAck.wait({ sessionID: input.childSessionID, signal: controller.signal })
    const opened = ack.then<Ready, Ready>(
      () => ({ type: "opened" }),
      (error) => ({ type: "ack-failed", error }),
    )
    const startup = input.startupFailure?.then<Ready, Ready>(
      ({ error }) => ({ type: "startup-failed", error }),
      (error) => ({ type: "startup-failed", error }),
    )
    const ready = startup ? Promise.race([opened, startup]) : opened
    const clear = () =>
      ack.then(
        () => undefined,
        () => undefined,
      )

    const starting = SubagentTaskControl.transitionToStarting(input.handle)
    if (
      !starting.applied ||
      !starting.info ||
      starting.info.execution !== "starting" ||
      starting.info.ref.taskID !== input.ref.taskID ||
      starting.info.ref.generation !== input.ref.generation
    ) {
      controller.abort()
      await clear()
      throw new Error("Background task failed to enter starting state")
    }

    try {
      input.launch()
    } catch (err) {
      controller.abort()
      await clear()
      SubagentTaskControl.transitionToFailed(input.handle, { error: err })
      throw err
    }

    const state = await ready
    if (state.type === "opened") {
      const running = SubagentTaskControl.transitionToRunning(input.handle)
      if (!running.applied || !running.info || running.info.execution !== "running") {
        throw new Error("Background task failed to enter running state")
      }
      return { info: BackgroundTask.project(running.info), ref: input.ref, handle: input.handle }
    }

    if (state.type === "startup-failed") {
      controller.abort()
      await clear()
      const failed = SubagentTaskControl.transitionToFailed(input.handle, { error: state.error })
      if (!failed.applied || !failed.info || failed.info.execution !== "failed") {
        throw new Error("Background task failed to enter failed state")
      }
      throw state.error
    }

    const failed = SubagentTaskControl.transitionToFailed(input.handle, { error: state.error })
    if (!failed.applied || !failed.info || failed.info.execution !== "failed") {
      throw new Error("Background task failed to enter failed state")
    }
    throw state.error
  }
}
