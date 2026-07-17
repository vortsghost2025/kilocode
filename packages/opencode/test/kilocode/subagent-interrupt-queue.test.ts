import { afterEach, describe, expect, test } from "bun:test"
import { ForegroundTask } from "../../src/kilocode/foreground-task"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { SyncEvent } from "../../src/sync"
import { SessionStatus } from "../../src/session/status"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function resumed(sessionID: SessionID) {
  const done = deferred<void>()
  const unsubscribe = SyncEvent.subscribeAll(({ def, event }) => {
    if (def !== Session.Event.Updated) return
    if (event.aggregateID !== sessionID) return
    unsubscribe()
    queueMicrotask(() => queueMicrotask(() => done.resolve()))
  })
  return done.promise
}

function chat(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(payload))
      ctrl.close()
    },
  })
}

function hanging(ready: () => void) {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setTimeout> | undefined
  const first =
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant" } }],
    })}` + "\n\n"
  const rest =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: "late" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(first))
      ready()
      timer = setTimeout(() => {
        ctrl.enqueue(encoder.encode(rest))
        ctrl.close()
      }, 10000)
    },
    cancel() {
      if (timer) clearTimeout(timer)
    },
  })
}

afterEach(async () => {
  await resetDatabase()
})

describe("kilocode subagent interrupt queue recovery", () => {
  test("the same parent loop processes the queued prompt after child-only interruption", async () => {
    const started = deferred<void>()
    const release = deferred<void>()
    const state = { calls: 0 }
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 })
        }
        state.calls++
        started.resolve()
        await release.promise
        return new Response(chat("QUEUE_OK"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
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
                orchestrator: {
                  model: "alibaba/qwen-plus",
                },
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
          const session = await Session.create({ title: "Queued recovery" })
          const child = deferred<MessageV2.WithParts>()
          const startedChild = deferred<SessionID>()
          const drained = deferred<void>()
          child.promise.catch(() => drained.resolve())
          let queuedDone = false
          const orig = SessionPrompt.prompt

          ;(SessionPrompt as any).prompt = async (input: any) => {
            if (input.sessionID === session.id) return orig(input)
            const childID = SessionID.make(input.sessionID)
            await SessionStatus.set(childID, { type: "busy" })
            startedChild.resolve(childID)
            return child.promise
          }

          try {
            const first = SessionPrompt.prompt({
              sessionID: session.id,
              agent: "orchestrator",
              parts: [
                {
                  type: "subtask",
                  agent: "alpha",
                  description: "child",
                  prompt: "hold",
                },
              ],
            })

            const childID = await startedChild.promise
            const queuedID = MessageID.ascending()
            const saved = resumed(session.id)
            const queued = SessionPrompt.prompt({
              sessionID: session.id,
              messageID: queuedID,
              agent: "orchestrator",
              parts: [{ type: "text", text: "queued message" }],
            })
            queued.finally(() => {
              queuedDone = true
            })

            await saved
            expect(queuedDone).toBe(false)
            expect(() => SessionPrompt.assertNotBusy(session.id)).toThrow()

            await SessionPrompt.cancel(childID)
            await started.promise
            expect((await SessionStatus.get(session.id)).type).toBe("busy")

            release.resolve()

            const firstResult = await Promise.race([
              first,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("timed out waiting for first prompt")), 1000),
              ),
            ])
            const queuedResult = await Promise.race([
              queued,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("timed out waiting for queued prompt")), 1000),
              ),
            ])

            expect(queuedDone).toBe(true)
            expect(firstResult.info.id).toBe(queuedResult.info.id)
            expect(firstResult.parts.some((part) => part.type === "text" && part.text.includes("QUEUE_OK"))).toBe(true)
            expect(state.calls).toBe(1)
            expect(ForegroundTask.has(session.projectID, childID)).toBe(false)

            const messages = await Session.messages({ sessionID: session.id })
            const toolMessage = messages.find(
              (item) => item.info.role === "assistant" && item.info.finish === "tool-calls",
            )
            expect(toolMessage).toBeDefined()
            if (!toolMessage) throw new Error("expected tool message")
            const parts = await MessageV2.parts(toolMessage.info.id)
            const toolPart = parts.find((part) => part.type === "tool" && part.tool === "task")
            expect(toolPart).toBeDefined()
            if (!toolPart || toolPart.type !== "tool") throw new Error("expected task tool part")
            expect(toolPart.state.status).toBe("completed")
            if (toolPart.state.status === "completed") {
              expect(toolPart.state.metadata).toMatchObject({ interrupted: true })
            }
          } finally {
            child.reject(new Error("late child rejection"))
            await drained.promise
            ;(SessionPrompt as any).prompt = orig
          }
        },
      })
    } finally {
      server.stop(true)
    }
  }, 20000)

  test("true parent-session cancellation rejects a queued callback exactly once", async () => {
    const ready = deferred<void>()
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 })
        }
        return new Response(
          hanging(() => ready.resolve()),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        )
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
                build: {
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
          const session = await Session.create({ title: "Parent cancellation" })
          const run = SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "Cancel me" }],
          })

          await ready.promise

          let settles = 0
          const queuedID = MessageID.ascending()
          const saved = resumed(session.id)
          const queued = SessionPrompt.prompt({
            sessionID: session.id,
            messageID: queuedID,
            agent: "build",
            parts: [{ type: "text", text: "queued while parent busy" }],
          }).then(
            () => {
              settles++
              return undefined
            },
            (error) => {
              settles++
              return error
            },
          )

          await saved
          await SessionPrompt.cancel(session.id)

          const result = await Promise.race([
            run,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("timed out waiting for parent cancel")), 1000),
            ),
          ])
          expect(result.info.role).toBe("assistant")
          if (result.info.role === "assistant") {
            expect(result.info.error?.name).toBe("MessageAbortedError")
          }

          const err = await Promise.race([
            queued,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("timed out waiting for queued rejection")), 1000),
            ),
          ])

          expect(settles).toBe(1)
          expect(err).toBeInstanceOf(DOMException)
          if (err instanceof DOMException) {
            expect(err.name).toBe("AbortError")
          }
        },
      })
    } finally {
      server.stop(true)
    }
  }, 20000)

  test("unavailable deterministic subtask becomes a recoverable tool error", async () => {
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
        calls++
        return new Response(chat("RECOVERED_AFTER_INVALID_TOOL"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
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
                orchestrator: {
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
          const session = await Session.create({ title: "Invalid subtask recovery" })
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "orchestrator",
            parts: [
              {
                type: "subtask",
                agent: "missing-agent",
                description: "missing",
                prompt: "do not run",
                command: "recover",
              },
            ],
          })

          expect(calls).toBe(1)
          expect(
            result.parts.some((part) => part.type === "text" && part.text.includes("RECOVERED_AFTER_INVALID_TOOL")),
          ).toBe(true)

          const messages = await Session.messages({ sessionID: session.id })
          const invalid = messages
            .flatMap((message) => message.parts)
            .find((part) => part.type === "tool" && part.tool === "task" && part.state.status === "error")
          expect(invalid).toBeDefined()
          if (!invalid || invalid.type !== "tool" || invalid.state.status !== "error") {
            throw new Error("expected recoverable task tool error")
          }
          expect(invalid.state.error).toContain('Agent not found: "missing-agent"')
        },
      })
    } finally {
      server.stop(true)
    }
  }, 20000)
})
