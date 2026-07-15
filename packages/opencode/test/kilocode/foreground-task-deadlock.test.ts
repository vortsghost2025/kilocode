import { afterEach, describe, expect, test } from "bun:test"
import { ForegroundTask } from "../../src/kilocode/foreground-task"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { TaskTool } from "../../src/tool/task"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const providerID = ProviderID.make("openai")
const modelID = ModelID.make("gpt-4")

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function seed() {
  const session = await Session.create({})
  const userID = MessageID.ascending()
  const assistantID = MessageID.ascending()
  await Session.updateMessage({
    id: userID,
    role: "user",
    sessionID: session.id,
    agent: "orchestrator",
    model: { providerID, modelID },
    time: { created: Date.now() },
  })
  await Session.updateMessage({
    id: assistantID,
    role: "assistant",
    parentID: userID,
    sessionID: session.id,
    agent: "orchestrator",
    mode: "orchestrator",
    path: { cwd: Instance.directory, root: Instance.worktree },
    time: { created: Date.now() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID,
    providerID,
  })
  return { session, assistantID }
}

function ctx(input: { sessionID: SessionID; messageID: MessageID; metadata?: (value: unknown) => void }) {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    agent: "orchestrator",
    callID: `call-${MessageID.ascending()}`,
    abort: new AbortController().signal,
    metadata(value: unknown) {
      input.metadata?.(value)
    },
    async ask() {},
  } as any
}

afterEach(async () => {
  await resetDatabase()
})

describe("foreground-task-deadlock", () => {
  test("sequential foreground tasks survive interrupt and continue", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { agent: { alpha: { mode: "subagent" } } },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, assistantID } = await seed()
        const tool = await TaskTool.init()
        const childIDs: SessionID[] = []
        const deferreds = [deferred<MessageV2.WithParts>(), deferred<MessageV2.WithParts>()]
        const orig = SessionPrompt.prompt

        ;(SessionPrompt as any).prompt = async (input: { sessionID: string }) => {
          const id = SessionID.make(input.sessionID)
          const idx = childIDs.length
          childIDs.push(id)
          await SessionStatus.set(id, { type: "busy" })
          return deferreds[idx].promise
        }

        try {
          const first = tool.execute(
            { description: "task", prompt: "hold", subagent_type: "alpha" },
            ctx({ sessionID: session.id, messageID: assistantID }),
          )

          while (childIDs.length < 1) await Bun.sleep(10)
          const fgID = childIDs[0]
          expect(ForegroundTask.has(fgID)).toBe(true)

          await SessionPrompt.cancel(fgID)

          const res = await Promise.race([
            first,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out on first")), 1000)),
          ])
          expect(res.metadata).toMatchObject({ sessionId: fgID, interrupted: true })
          expect(res.output).toContain(`task_id: ${fgID}`)
          expect(ForegroundTask.has(fgID)).toBe(false)

          const second = tool.execute(
            { description: "resumed", prompt: "continue", subagent_type: "alpha" },
            ctx({ sessionID: session.id, messageID: assistantID }),
          )

          while (childIDs.length < 2) await Bun.sleep(10)
          const sgID = childIDs[1]
          expect(ForegroundTask.has(sgID)).toBe(true)

          await SessionPrompt.cancel(sgID)

          const res2 = await Promise.race([
            second,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out on second")), 1000)),
          ])
          expect(res2.metadata).toMatchObject({ sessionId: sgID, interrupted: true })
          expect(ForegroundTask.has(sgID)).toBe(false)
        } finally {
          deferreds[0].reject(new Error("late"))
          deferreds[1].reject(new Error("late"))
          await Bun.sleep(0)
          ;(SessionPrompt as any).prompt = orig
        }
      },
    })
  }, 15000)

  test("parallel distinct subagents both interrupt without interference", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { agent: { alpha: { mode: "subagent" }, beta: { mode: "subagent" } } },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, assistantID } = await seed()
        const tool = await TaskTool.init()
        const childIDs: SessionID[] = []
        const promA = deferred<MessageV2.WithParts>()
        const promB = deferred<MessageV2.WithParts>()
        const orig = SessionPrompt.prompt

        ;(SessionPrompt as any).prompt = async (input: { sessionID: string }) => {
          const id = SessionID.make(input.sessionID)
          const idx = childIDs.length
          childIDs.push(id)
          await SessionStatus.set(id, { type: "busy" })
          return idx === 0 ? promA.promise : promB.promise
        }

        try {
          const runA = tool.execute(
            { description: "A", prompt: "hold A", subagent_type: "alpha" },
            ctx({ sessionID: session.id, messageID: assistantID }),
          )
          while (childIDs.length < 1) await Bun.sleep(10)
          const idA = childIDs[0]

          const runB = tool.execute(
            { description: "B", prompt: "hold B", subagent_type: "beta" },
            ctx({ sessionID: session.id, messageID: assistantID }),
          )
          while (childIDs.length < 2) await Bun.sleep(10)
          const idB = childIDs[1]

          expect(idA).not.toBe(idB)
          expect(ForegroundTask.has(idA)).toBe(true)
          expect(ForegroundTask.has(idB)).toBe(true)

          await SessionPrompt.cancel(idA)
          const resA = await Promise.race([
            runA,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out on A")), 1000)),
          ])
          expect(resA.metadata).toMatchObject({ sessionId: idA, interrupted: true })
          expect(ForegroundTask.has(idA)).toBe(false)
          expect(ForegroundTask.has(idB)).toBe(true)

          await SessionPrompt.cancel(idB)
          const resB = await Promise.race([
            runB,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out on B")), 1000)),
          ])
          expect(resB.metadata).toMatchObject({ sessionId: idB, interrupted: true })
          expect(ForegroundTask.has(idB)).toBe(false)
        } finally {
          promA.reject(new Error("late A"))
          promB.reject(new Error("late B"))
          await Bun.sleep(0)
          ;(SessionPrompt as any).prompt = orig
        }
      },
    })
  }, 15000)
})
