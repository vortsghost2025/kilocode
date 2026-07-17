import { afterEach, describe, expect, test } from "bun:test"
import { ForegroundTask } from "../../src/kilocode/foreground-task"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
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

function ctx(input: {
  sessionID: SessionID
  messageID: MessageID
  abort?: AbortSignal
  metadata?: (value: unknown) => void
}) {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    agent: "orchestrator",
    callID: `call-${MessageID.ascending()}`,
    abort: input.abort ?? new AbortController().signal,
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
        const starts = [deferred<SessionID>(), deferred<SessionID>()]
        const drains = [deferred<void>(), deferred<void>()]
        deferreds.forEach((item, index) => item.promise.catch(() => drains[index].resolve()))
        const orig = SessionPrompt.prompt

        ;(SessionPrompt as any).prompt = async (input: { sessionID: string }) => {
          const id = SessionID.make(input.sessionID)
          const idx = childIDs.length
          childIDs.push(id)
          await SessionStatus.set(id, { type: "busy" })
          starts[idx].resolve(id)
          return deferreds[idx].promise
        }

        try {
          const first = tool.execute(
            { description: "task", prompt: "hold", subagent_type: "alpha" },
            ctx({ sessionID: session.id, messageID: assistantID }),
          )

          const fgID = await starts[0].promise
          expect(ForegroundTask.has(session.projectID, fgID)).toBe(true)

          await SessionPrompt.cancel(fgID)

          const res = await Promise.race([
            first,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out on first")), 1000)),
          ])
          expect(res.metadata).toMatchObject({ sessionId: fgID, interrupted: true })
          expect(res.output).toContain(`task_id: ${fgID}`)
          expect(ForegroundTask.has(session.projectID, fgID)).toBe(false)

          const second = tool.execute(
            { description: "resumed", prompt: "continue", subagent_type: "alpha" },
            ctx({ sessionID: session.id, messageID: assistantID }),
          )

          const sgID = await starts[1].promise
          expect(ForegroundTask.has(session.projectID, sgID)).toBe(true)

          await SessionPrompt.cancel(sgID)

          const res2 = await Promise.race([
            second,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out on second")), 1000)),
          ])
          expect(res2.metadata).toMatchObject({ sessionId: sgID, interrupted: true })
          expect(ForegroundTask.has(session.projectID, sgID)).toBe(false)
        } finally {
          deferreds[0].reject(new Error("late"))
          deferreds[1].reject(new Error("late"))
          await Promise.all(drains.map((item) => item.promise))
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
        const starts = [deferred<SessionID>(), deferred<SessionID>()]
        const drains = [deferred<void>(), deferred<void>()]
        promA.promise.catch(() => drains[0].resolve())
        promB.promise.catch(() => drains[1].resolve())
        const orig = SessionPrompt.prompt

        ;(SessionPrompt as any).prompt = async (input: { sessionID: string }) => {
          const id = SessionID.make(input.sessionID)
          const idx = childIDs.length
          childIDs.push(id)
          await SessionStatus.set(id, { type: "busy" })
          starts[idx].resolve(id)
          return idx === 0 ? promA.promise : promB.promise
        }

        try {
          const runA = tool.execute(
            { description: "A", prompt: "hold A", subagent_type: "alpha" },
            ctx({ sessionID: session.id, messageID: assistantID }),
          )
          const idA = await starts[0].promise

          const runB = tool.execute(
            { description: "B", prompt: "hold B", subagent_type: "beta" },
            ctx({ sessionID: session.id, messageID: assistantID }),
          )
          const idB = await starts[1].promise

          expect(idA).not.toBe(idB)
          expect(ForegroundTask.has(session.projectID, idA)).toBe(true)
          expect(ForegroundTask.has(session.projectID, idB)).toBe(true)

          await SessionPrompt.cancel(idA)
          const resA = await Promise.race([
            runA,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out on A")), 1000)),
          ])
          expect(resA.metadata).toMatchObject({ sessionId: idA, interrupted: true })
          expect(ForegroundTask.has(session.projectID, idA)).toBe(false)
          expect(ForegroundTask.has(session.projectID, idB)).toBe(true)

          await SessionPrompt.cancel(idB)
          const resB = await Promise.race([
            runB,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out on B")), 1000)),
          ])
          expect(resB.metadata).toMatchObject({ sessionId: idB, interrupted: true })
          expect(ForegroundTask.has(session.projectID, idB)).toBe(false)
        } finally {
          promA.reject(new Error("late A"))
          promB.reject(new Error("late B"))
          await Promise.all(drains.map((item) => item.promise))
          ;(SessionPrompt as any).prompt = orig
        }
      },
    })
  }, 15000)

  test("unresponsive child timeout returns parent control without starting another child", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { agent: { alpha: { mode: "subagent" } } },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, assistantID } = await seed()
        const tool = await TaskTool.init()
        const child = deferred<MessageV2.WithParts>()
        const started = deferred<SessionID>()
        const drained = deferred<void>()
        const state = { starts: 0 }
        const orig = SessionPrompt.prompt

        child.promise.catch(() => drained.resolve())
        ;(SessionPrompt as any).prompt = async (input: { sessionID: string }) => {
          state.starts++
          started.resolve(SessionID.make(input.sessionID))
          return child.promise
        }

        try {
          const run = tool.execute(
            { description: "timeout", prompt: "hold", subagent_type: "alpha" },
            ctx({ sessionID: session.id, messageID: assistantID }),
          )
          const childID = await started.promise

          expect(state.starts).toBe(1)
          expect(ForegroundTask.timeout(session.projectID, childID)).toBe(true)
          const result = await run

          expect(state.starts).toBe(1)
          expect(result.metadata).toMatchObject({ sessionId: childID, interrupted: false, timedOut: true })
          expect(result.output).toContain("Task timed out after producing no progress")
          expect(ForegroundTask.has(session.projectID, childID)).toBe(false)

          child.reject(new Error("late timeout rejection"))
          await drained.promise
        } finally {
          ;(SessionPrompt as any).prompt = orig
        }
      },
    })
  }, 15000)

  test("persisted child result wins over later interruption and returns in task_result", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { agent: { alpha: { mode: "subagent" } } },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, assistantID } = await seed()
        const tool = await TaskTool.init()
        const child = deferred<MessageV2.WithParts>()
        const started = deferred<{ sessionID: SessionID; messageID: MessageID }>()
        const drained = deferred<void>()
        const orig = SessionPrompt.prompt

        child.promise.catch(() => drained.resolve())
        ;(SessionPrompt as any).prompt = async (input: { sessionID: string; messageID: string }) => {
          started.resolve({
            sessionID: SessionID.make(input.sessionID),
            messageID: MessageID.make(input.messageID),
          })
          return child.promise
        }

        try {
          const run = tool.execute(
            { description: "persisted", prompt: "finish", subagent_type: "alpha" },
            ctx({ sessionID: session.id, messageID: assistantID }),
          )
          const info = await started.promise
          const finalID = MessageID.ascending()
          await Session.updateMessage({
            id: info.messageID,
            role: "user",
            sessionID: info.sessionID,
            agent: "alpha",
            model: { providerID, modelID },
            time: { created: Date.now() },
          })
          const final = {
            id: finalID,
            role: "assistant" as const,
            parentID: info.messageID,
            sessionID: info.sessionID,
            agent: "alpha",
            mode: "alpha",
            path: { cwd: Instance.directory, root: Instance.worktree },
            time: { created: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID,
            providerID,
          }
          await Session.updateMessage(final)
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: finalID,
            sessionID: info.sessionID,
            type: "text",
            text: "PERSISTED_RESULT",
          })
          await Session.updateMessage({
            ...final,
            finish: "stop",
            time: { ...final.time, completed: Date.now() },
          })
          const persisted = await MessageV2.get({ sessionID: info.sessionID, messageID: finalID })
          expect(ForegroundTask.complete(session.projectID, info.sessionID, persisted)).toBe(true)

          const result = await run
          expect(result.metadata).toMatchObject({ sessionId: info.sessionID, interrupted: false })
          const newline = String.fromCharCode(10)
          expect(result.output).toContain(["<task_result>", "PERSISTED_RESULT", "</task_result>"].join(newline))

          await SessionPrompt.cancel(info.sessionID)
          expect(ForegroundTask.interrupt(session.projectID, info.sessionID)).toBe(false)
          expect(result.output).not.toContain("Task was interrupted")

          child.reject(new Error("late persisted rejection"))
          await drained.promise
        } finally {
          ;(SessionPrompt as any).prompt = orig
        }
      },
    })
  }, 15000)

  test("cancellation before child completion wins and repeated interrupt is harmless", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { agent: { alpha: { mode: "subagent" } } },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, assistantID } = await seed()
        const tool = await TaskTool.init()
        const child = deferred<MessageV2.WithParts>()
        const started = deferred<SessionID>()
        const drained = deferred<void>()
        const abort = new AbortController()
        const orig = SessionPrompt.prompt

        child.promise.catch(() => drained.resolve())
        ;(SessionPrompt as any).prompt = async (input: { sessionID: string }) => {
          started.resolve(SessionID.make(input.sessionID))
          return child.promise
        }

        try {
          const run = tool.execute(
            { description: "cancel", prompt: "hold", subagent_type: "alpha" },
            ctx({ sessionID: session.id, messageID: assistantID, abort: abort.signal }),
          )
          const childID = await started.promise

          abort.abort()
          abort.abort()
          const result = await run

          expect(result.metadata).toMatchObject({ sessionId: childID, interrupted: true })
          expect(result.output).toContain("Task was interrupted")
          expect(ForegroundTask.interrupt(session.projectID, childID)).toBe(false)

          child.reject(new Error("late cancellation rejection"))
          await drained.promise
        } finally {
          ;(SessionPrompt as any).prompt = orig
        }
      },
    })
  }, 15000)

  for (const failure of [
    { status: 429, code: "ResourceExhausted" },
    { status: 502, code: "provider_unavailable" },
  ]) {
    test(`${failure.status} child failure returns parent control without retry or fallback`, async () => {
      const state = { calls: 0 }
      const server = Bun.serve({
        port: 0,
        fetch() {
          state.calls++
          return Response.json({ error: { message: failure.code, code: failure.code } }, { status: failure.status })
        },
      })

      try {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(
              `${dir}/opencode.json`,
              JSON.stringify({
                $schema: "https://opencode.ai/config.json",
                enabled_providers: ["alibaba"],
                provider: {
                  alibaba: {
                    options: {
                      apiKey: "test-key",
                      baseURL: `${server.url.origin}/v1`,
                    },
                  },
                },
                agent: {
                  alpha: {
                    mode: "subagent",
                    model: "alibaba/qwen-plus",
                  },
                },
              }),
            )
          },
        })

        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const { session, assistantID } = await seed()
            const tool = await TaskTool.init()
            const result = await tool.execute(
              { description: `failure ${failure.status}`, prompt: "fail once", subagent_type: "alpha" },
              ctx({ sessionID: session.id, messageID: assistantID }),
            )

            expect(state.calls).toBe(1)
            expect(result.output).toContain("<task_result>")
            expect(result.output).toContain(`HTTP ${failure.status}`)
            expect(result.output).toContain(failure.code)
            expect(ForegroundTask.has(session.projectID, (result.metadata as { sessionId: SessionID }).sessionId)).toBe(
              false,
            )
          },
        })
      } finally {
        server.stop(true)
      }
    }, 15000)
  }
})
