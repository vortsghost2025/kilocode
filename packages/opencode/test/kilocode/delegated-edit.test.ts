import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { BackgroundTaskTool } from "../../src/kilocode/background-task-tool"
import { DelegatedEdit } from "../../src/kilocode/delegated-edit"
import { ToolAsk } from "../../src/kilocode/permission/tool-ask"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { EditTool } from "../../src/tool/edit"
import { ReadTool } from "../../src/tool/read"
import { TaskTool } from "../../src/tool/task"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../../../..")
const source = path.join(root, ".kilo", "agent")

async function copy(dir: string, names: string[]) {
  const target = path.join(dir, ".kilo", "agent")
  await fs.mkdir(target, { recursive: true })
  await Promise.all(
    names.map(async (name) => {
      const text = await Bun.file(path.join(source, `${name}.md`)).text()
      const content =
        name === "reviewer"
          ? text.replace(
              "description: scoped read-only diff sanity reviewer",
              "description: focused read-only diff sanity reviewer",
            )
          : text
      await Bun.write(path.join(target, `${name}.md`), content)
    }),
  )
}

function model(): Provider.Model {
  return {
    id: ModelID.make("qwen-plus"),
    providerID: ProviderID.make("alibaba"),
    api: { id: "qwen-plus", url: "http://127.0.0.1", npm: "@ai-sdk/openai-compatible" },
    name: "Test model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 10_000, output: 1_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

function reply(input: { tool: string; args: Record<string, unknown>; id: string } | { text: string }) {
  const chunks =
    "tool" in input
      ? [
          { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: input.id,
                      type: "function",
                      function: { name: input.tool, arguments: JSON.stringify(input.args) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]
      : [
          { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { content: input.text }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", ...chunk })}`)
    .concat("data: [DONE]")
    .join("\n\n")
  return new Response(body + "\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

function gate() {
  const state: { resolve?: () => void } = {}
  const promise = new Promise<void>((resolve) => {
    state.resolve = resolve
  })
  return { promise, resolve: () => state.resolve?.() }
}

async function setup() {
  const session = await Session.create({ title: "delegated edit parent" })
  const user = MessageID.ascending()
  const assistant = MessageID.ascending()
  await Session.updateMessage({
    id: user,
    role: "user",
    sessionID: session.id,
    agent: "orchestrator",
    model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") },
    time: { created: Date.now() },
  })
  await Session.updateMessage({
    id: assistant,
    role: "assistant",
    parentID: user,
    sessionID: session.id,
    agent: "orchestrator",
    mode: "orchestrator",
    path: { cwd: Instance.directory, root: Instance.worktree },
    time: { created: Date.now() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelID.make("gpt-4"),
    providerID: ProviderID.make("openai"),
  })
  return { session, assistant }
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("delegated edit authorization", () => {
  test("real agent policies separate implementation, delegation, review, and Git ownership", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copy(dir, ["orchestrator", "phase2f-implementer", "reviewer", "git-ops", "command-check"]),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const orchestrator = await Agent.get("orchestrator")
        const phase = await Agent.get("phase2f-implementer")
        const reviewer = await Agent.get("reviewer")
        const git = await Agent.get("git-ops")
        const check = await Agent.get("command-check")
        expect(orchestrator).toBeDefined()
        expect(phase).toBeDefined()
        expect(reviewer).toBeDefined()
        expect(git).toBeDefined()
        expect(check).toBeDefined()

        expect(Permission.evaluate("edit", ".kilo/agent/reviewer.md", orchestrator!.permission).action).toBe("deny")
        expect(Permission.evaluate("delegate_edit", "phase2f-implementer", orchestrator!.permission).action).toBe(
          "allow",
        )
        expect(Permission.evaluate("delegate_edit", "reviewer", orchestrator!.permission).action).toBe("deny")

        expect(Permission.evaluate("edit", ".kilo/agent/reviewer.md", phase!.permission).action).toBe("allow")
        expect(Permission.evaluate("write", ".kilo/agent/reviewer.md", phase!.permission).action).toBe("deny")
        expect(Permission.evaluate("apply_patch", ".kilo/agent/reviewer.md", phase!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "bun test test/tool/task.test.ts", phase!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "bun run typecheck", phase!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "bunx prettier --check src", phase!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "prettier --write src", phase!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "git diff --check", phase!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "npm install", phase!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "git add .", phase!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", 'git commit -m "test"', phase!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "git push sean sean/subagent-runtime-a6d1", phase!.permission).action).toBe(
          "deny",
        )
        expect(Permission.evaluate("bash", "git ls-remote sean", phase!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "bun test test/tool/task.test.ts", check!.permission).action).toBe("allow")

        expect(Permission.evaluate("edit", ".kilo/agent/reviewer.md", reviewer!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "git add .", git!.permission).action).toBe("ask")
        expect(Permission.evaluate("bash", 'git commit -m "test"', git!.permission).action).toBe("ask")
      },
    })
  })

  test("lease identity fails closed for wrong operation, path, child, call, missing grant, and replay", async () => {
    await using tmp = await tmpdir({ git: true, init: (dir) => copy(dir, ["reviewer"]) })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ title: "child", parentID: parent.id })
        const other = await Session.create({ title: "other", parentID: parent.id })
        const scope = DelegatedEdit.scope({ operation: "edit", path: ".kilo/agent/reviewer.md" })
        const lease = { parent: parent.id, child: child.id, call: "task-call", scope }
        const rules = DelegatedEdit.rules(lease)
        const input = (sessionID: SessionID, session = rules, operation = "edit", patterns = [scope.path]) => ({
          sessionID,
          operation,
          permission: "edit",
          patterns,
          session,
        })
        const reservation = DelegatedEdit.reserve(lease)
        const binding = DelegatedEdit.bind(reservation, child.id)

        expect(() => DelegatedEdit.authorize(input(child.id, rules, "write"))).toThrow(Permission.DeniedError)
        expect(() => DelegatedEdit.authorize(input(child.id, rules, "edit", [".kilo/agent/orchestrator.md"]))).toThrow(
          Permission.DeniedError,
        )
        expect(() => DelegatedEdit.authorize(input(other.id))).toThrow(Permission.DeniedError)
        expect(() =>
          DelegatedEdit.authorize(input(child.id, DelegatedEdit.rules({ ...lease, call: "other-call" }))),
        ).toThrow(Permission.DeniedError)
        expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(false)

        expect(DelegatedEdit.authorize(input(child.id))).toBe(true)
        expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)
        expect(() => DelegatedEdit.authorize(input(child.id))).toThrow(Permission.DeniedError)

        binding.release()
        expect(DelegatedEdit.inspect(child.id)).toBeUndefined()
        expect(() => DelegatedEdit.authorize(input(child.id))).toThrow(Permission.DeniedError)
        expect(() => DelegatedEdit.authorize(input(child.id, []))).toThrow(Permission.DeniedError)
        expect(() => DelegatedEdit.reserve(lease)).toThrow("Delegated edit authorization already used")

        const retry = { parent: parent.id, call: "retryable-call", scope }
        const abandoned = DelegatedEdit.reserve(retry)
        DelegatedEdit.release(abandoned)
        const reserved = DelegatedEdit.reserve(retry)
        DelegatedEdit.release(reserved)
      },
    })
  })

  test("scope requires an existing regular physical file inside the project", async () => {
    await using outside = await tmpdir()
    await Bun.write(path.join(outside.path, "outside.ts"), "export const outside = true\n")
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "src", "inside.ts"), "export const inside = true\n")
        const link = await fs
          .symlink(path.join(dir, "src", "inside.ts"), path.join(dir, "src", "link.ts"), "file")
          .then(
            () => "src/link.ts",
            async (err) => {
              if (typeof err !== "object" || err === null || !("code" in err) || err.code !== "EPERM") throw err
              await fs.mkdir(path.join(dir, "src", "linked"))
              await fs.symlink(path.join(dir, "src", "linked"), path.join(dir, "src", "link"), "junction")
              return "src/link"
            },
          )
        await fs.symlink(outside.path, path.join(dir, "escape"), process.platform === "win32" ? "junction" : "dir")
        return link
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(DelegatedEdit.scope({ operation: "edit", path: "src/inside.ts" })).toEqual({
          operation: "edit",
          path: path.join("src", "inside.ts"),
        })
        expect(() => DelegatedEdit.scope({ operation: "edit", path: tmp.extra })).toThrow(
          "Delegated edit target must not be a symbolic link",
        )
        expect(() => DelegatedEdit.scope({ operation: "edit", path: "escape/outside.ts" })).toThrow(
          "Delegated edit target must remain physically inside the current project",
        )
        expect(() => DelegatedEdit.scope({ operation: "edit", path: "src/missing.ts" })).toThrow(
          "Delegated edit target must already exist",
        )
      },
    })
  })

  test("phase2f without authorization is rejected before child creation", async () => {
    const original = SessionPrompt.prompt
    const state = { prompts: 0 }
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copy(dir, ["orchestrator", "phase2f-implementer"]),
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const parent = await Agent.get("orchestrator")
          expect(parent).toBeDefined()
          const current = await setup()
          ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = (async () => {
            state.prompts++
            return { parts: [{ type: "text", text: "unexpected" }] }
          }) as unknown as typeof SessionPrompt.prompt
          const ask = ToolAsk.build({
            sessionID: current.session.id,
            messageID: current.assistant,
            callID: "phase-without-authorization",
            operation: "task",
            agent: parent!.permission,
            session: current.session.permission ?? [],
          }).ask
          const tool = await TaskTool.init()
          await expect(
            tool.execute(
              {
                description: "missing authorization",
                prompt: "Edit reviewer config",
                subagent_type: "phase2f-implementer",
              },
              {
                sessionID: current.session.id,
                messageID: current.assistant,
                callID: "phase-without-authorization",
                agent: parent!.name,
                abort: AbortSignal.any([]),
                messages: [],
                metadata: () => {},
                ask,
                extra: {},
              },
            ),
          ).rejects.toThrow("Phase2F requires a structured exact-path edit authorization")
          expect(state.prompts).toBe(0)
          expect(await Session.children(current.session.id)).toHaveLength(0)
        },
      })
    } finally {
      ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = original
    }
  })

  test("invalid target is rejected before delegate permission or child creation", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copy(dir, ["orchestrator", "phase2f-implementer"]),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const current = await setup()
        const asks: string[] = []
        const tool = await TaskTool.init()
        await expect(
          tool.execute(
            {
              description: "missing target",
              prompt: "Edit a file that does not exist",
              subagent_type: "phase2f-implementer",
              authorization: { operation: "edit", path: "missing.ts" },
            },
            {
              sessionID: current.session.id,
              messageID: current.assistant,
              callID: "missing-target",
              agent: "orchestrator",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => {},
              ask: async (input) => {
                asks.push(input.permission)
              },
              extra: {},
            },
          ),
        ).rejects.toThrow("Delegated edit target must already exist")
        expect(asks).toEqual(["task"])
        expect(await Session.children(current.session.id)).toHaveLength(0)
      },
    })
  })

  test("background task rejects phase2f before child creation", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copy(dir, ["orchestrator", "phase2f-implementer"]),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const current = await setup()
        const before = await Session.children(current.session.id)
        const tool = await BackgroundTaskTool.init()
        await expect(
          tool.execute(
            {
              action: "start",
              description: "forbidden background implementation",
              prompt: "Edit reviewer config",
              subagent_type: "phase2f-implementer",
            },
            {
              sessionID: current.session.id,
              messageID: current.assistant,
              callID: "background-phase2f",
              agent: "orchestrator",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => {},
              ask: async () => {},
              extra: {},
            },
          ),
        ).rejects.toThrow("Phase2F implementation tasks are foreground-only")
        expect(await Session.children(current.session.id)).toHaveLength(before.length)
      },
    })
  })

  test("read-only agents run without edit authorization", async () => {
    const original = SessionPrompt.prompt
    const seen: string[] = []
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copy(dir, ["orchestrator", "reviewer", "repo-architecture-explainer"]),
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const parent = await Agent.get("orchestrator")
          expect(parent).toBeDefined()
          const current = await setup()
          ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = (async (input: {
            agent: string
          }) => {
            seen.push(input.agent)
            return { parts: [{ type: "text", text: "done" }] }
          }) as unknown as typeof SessionPrompt.prompt
          const tool = await TaskTool.init()
          const run = async (agent: string, call: string) => {
            const ask = ToolAsk.build({
              sessionID: current.session.id,
              messageID: current.assistant,
              callID: call,
              operation: "task",
              agent: parent!.permission,
              session: current.session.permission ?? [],
            }).ask
            await tool.execute(
              {
                description: "read-only review",
                prompt: "Inspect the requested files without editing",
                subagent_type: agent,
              },
              {
                sessionID: current.session.id,
                messageID: current.assistant,
                callID: call,
                agent: parent!.name,
                abort: AbortSignal.any([]),
                messages: [],
                metadata: () => {},
                ask,
                extra: {},
              },
            )
          }

          await run("reviewer", "reviewer-read-only")
          await run("repo-architecture-explainer", "architecture-read-only")

          expect(seen).toEqual(["reviewer", "repo-architecture-explainer"])
          expect(await Session.children(current.session.id)).toHaveLength(2)
        },
      })
    } finally {
      ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = original
    }
  })

  test("foreground task grants one exact edit and denies siblings, other operations, and replay", async () => {
    let child: Awaited<ReturnType<typeof Session.get>> | undefined
    let phase: Awaited<ReturnType<typeof Agent.get>> | undefined
    let allowed = ""
    let tools: Record<string, boolean> | undefined
    const original = SessionPrompt.prompt

    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copy(dir, ["orchestrator", "phase2f-implementer", "reviewer"]),
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const parent = await Agent.get("orchestrator")
          phase = await Agent.get("phase2f-implementer")
          expect(parent).toBeDefined()
          expect(phase).toBeDefined()
          const current = await setup()

          ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = (async (input: {
            sessionID: SessionID
            tools?: Record<string, boolean>
          }) => {
            child = await Session.get(input.sessionID)
            tools = input.tools
            allowed =
              child.permission?.find(
                (rule) => rule.permission === "edit" && rule.action === "allow" && rule.pattern !== "*",
              )?.pattern ?? ""
            const sibling = path.relative(
              Instance.worktree,
              path.join(Instance.directory, ".kilo", "agent", "orchestrator.md"),
            )
            const ask = (operation: string, callID: string) =>
              ToolAsk.build({
                sessionID: input.sessionID,
                messageID: MessageID.ascending(),
                callID,
                operation,
                agent: phase!.permission,
                session: child!.permission ?? [],
              }).ask
            const context = (operation: string, callID: string): Tool.Context => ({
              sessionID: input.sessionID,
              messageID: MessageID.ascending(),
              callID,
              agent: phase!.name,
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => {},
              ask: ask(operation, callID),
              extra: {},
            })
            const request = (target: string) => ({
              permission: "edit",
              patterns: [target],
              always: ["*"],
              metadata: {},
            })

            await expect(
              ask(
                "bash",
                "validation",
              )({
                permission: "bash",
                patterns: ["bun test test/kilocode/delegated-edit.test.ts"],
                always: ["*"],
                metadata: {},
              }),
            ).rejects.toBeInstanceOf(Permission.DeniedError)
            await expect(ask("edit", "wrong-path")(request(sibling))).rejects.toBeInstanceOf(Permission.DeniedError)
            await expect(ask("write", "wrong-operation")(request(allowed))).rejects.toBeInstanceOf(
              Permission.DeniedError,
            )
            const target = path.join(Instance.directory, ".kilo", "agent", "reviewer.md")
            const before = (await Bun.file(target).text()).split(/\r?\n/)
            const read = await ReadTool.init({ agent: phase! })
            await read.execute({ filePath: target }, context("read", "read-target"))
            const edit = await EditTool.init({ agent: phase! })
            await edit.execute(
              {
                filePath: target,
                oldString: "description: focused read-only diff sanity reviewer",
                newString: "description: scoped read-only diff sanity reviewer",
              },
              context("edit", "authorized"),
            )
            const after = (await Bun.file(target).text()).split(/\r?\n/)
            expect(after.filter((line, index) => line !== before[index])).toHaveLength(1)
            expect(after).toContain("description: scoped read-only diff sanity reviewer")
            await expect(ask("edit", "replay")(request(allowed))).rejects.toBeInstanceOf(Permission.DeniedError)
            return { parts: [{ type: "text", text: "done" }] }
          }) as unknown as typeof SessionPrompt.prompt

          const ask = ToolAsk.build({
            sessionID: current.session.id,
            messageID: current.assistant,
            callID: "task-authorization",
            operation: "task",
            agent: parent!.permission,
            session: current.session.permission ?? [],
          }).ask
          const tool = await TaskTool.init()
          await tool.execute(
            {
              description: "edit reviewer model",
              prompt: "Change exactly one line in .kilo/agent/reviewer.md",
              subagent_type: "phase2f-implementer",
              authorization: {
                operation: "edit",
                path: ".kilo/agent/reviewer.md",
              },
            },
            {
              sessionID: current.session.id,
              messageID: current.assistant,
              callID: "task-authorization",
              agent: "orchestrator",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => {},
              ask,
              extra: {},
            },
          )

          expect(child).toBeDefined()
          expect(allowed).not.toBe("")
          expect(tools?.bash).toBe(false)
          expect(tools?.write).toBe(false)
          expect(tools?.apply_patch).toBe(false)
          expect(Permission.evaluate("edit", allowed, phase!.permission, child!.permission ?? []).action).toBe("allow")
          const sibling = path.relative(
            Instance.worktree,
            path.join(Instance.directory, ".kilo", "agent", "orchestrator.md"),
          )
          expect(Permission.evaluate("edit", sibling, phase!.permission, child!.permission ?? []).action).toBe("deny")

          const replay = ToolAsk.build({
            sessionID: child!.id,
            messageID: MessageID.ascending(),
            callID: "post-task-replay",
            operation: "edit",
            agent: phase!.permission,
            session: child!.permission ?? [],
          }).ask
          await expect(
            replay({ permission: "edit", patterns: [allowed], always: ["*"], metadata: {} }),
          ).rejects.toBeInstanceOf(Permission.DeniedError)

          const count = (await Session.children(current.session.id)).length
          await expect(
            tool.execute(
              {
                description: "replay reviewer edit",
                prompt: "Attempt to replay the same authorization",
                subagent_type: "phase2f-implementer",
                authorization: { operation: "edit", path: ".kilo/agent/reviewer.md" },
              },
              {
                sessionID: current.session.id,
                messageID: current.assistant,
                callID: "task-authorization",
                agent: "orchestrator",
                abort: AbortSignal.any([]),
                messages: [],
                metadata: () => {},
                ask,
                extra: {},
              },
            ),
          ).rejects.toThrow("Delegated edit authorization already used by task call task-authorization")
          expect(await Session.children(current.session.id)).toHaveLength(count)
        },
      })
    } finally {
      ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = original
    }
  })

  test("live child tool loop consumes one exact edit and denies sibling, replay, and post-task use", async () => {
    const entered = [gate(), gate(), gate()]
    const release = [gate(), gate(), gate()]
    const state: { calls: number; dir: string; child?: SessionID; tools?: string[] } = { calls: 0, dir: "" }
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 })
        }
        const body = (await req.json()) as {
          tools?: Array<{ name?: string; function?: { name?: string } }>
        }
        if (!state.tools) state.tools = body.tools?.map((item) => item.function?.name ?? item.name ?? "") ?? []
        const reviewer = path.join(state.dir, ".kilo", "agent", "reviewer.md")
        const sibling = path.join(state.dir, ".kilo", "agent", "orchestrator.md")
        const steps = [
          { tool: "read", args: { filePath: reviewer }, id: "read-reviewer" },
          {
            tool: "edit",
            args: {
              filePath: reviewer,
              oldString: "description: focused read-only diff sanity reviewer",
              newString: "description: scoped read-only diff sanity reviewer",
            },
            id: "edit-first",
          },
          { tool: "read", args: { filePath: sibling }, id: "read-sibling" },
          {
            tool: "edit",
            args: {
              filePath: sibling,
              oldString: "description: Coordinate complex tasks with planning-first delegation.",
              newString: "description: unauthorized sibling edit",
            },
            id: "edit-sibling",
          },
          {
            tool: "edit",
            args: {
              filePath: reviewer,
              oldString: "description: scoped read-only diff sanity reviewer",
              newString: "description: unauthorized second edit",
            },
            id: "edit-second",
          },
          { text: "task complete" },
          {
            tool: "edit",
            args: {
              filePath: reviewer,
              oldString: "description: scoped read-only diff sanity reviewer",
              newString: "description: unauthorized post-task edit",
            },
            id: "edit-post-task",
          },
          { text: "post-task replay denied" },
        ] as const
        const index = state.calls++
        const pause = index === 0 ? 0 : index === 2 ? 1 : index === 4 ? 2 : undefined
        if (pause !== undefined) {
          entered[pause].resolve()
          await release[pause].promise
        }
        const step = steps[index] ?? { text: "unexpected extra request" }
        return reply(step)
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          state.dir = dir
          await copy(dir, ["orchestrator", "phase2f-implementer", "reviewer"])
          const phase = path.join(dir, ".kilo", "agent", "phase2f-implementer.md")
          await Bun.write(
            phase,
            (await Bun.file(phase).text()).replace("model: kilo/poolside/laguna-m.1:free", "model: alibaba/qwen-plus"),
          )
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` },
                },
              },
              agent: {
                orchestrator: { model: "alibaba/qwen-plus" },
                "phase2f-implementer": { model: "alibaba/qwen-plus" },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const parent = await Agent.get("orchestrator")
          const phase = await Agent.get("phase2f-implementer")
          expect(parent).toBeDefined()
          expect(phase).toBeDefined()
          expect(phase!.model).toEqual({ providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") })
          const current = await setup()
          const ask = ToolAsk.build({
            sessionID: current.session.id,
            messageID: current.assistant,
            callID: "live-task",
            operation: "task",
            agent: parent!.permission,
            session: current.session.permission ?? [],
          }).ask
          const tool = await TaskTool.init()
          const run = tool.execute(
            {
              description: "live delegated edit",
              prompt: "Read and edit reviewer.md once, then test sibling and replay denials.",
              subagent_type: "phase2f-implementer",
              authorization: { operation: "edit", path: ".kilo/agent/reviewer.md" },
            },
            {
              sessionID: current.session.id,
              messageID: current.assistant,
              callID: "live-task",
              agent: parent!.name,
              abort: AbortSignal.any([]),
              messages: [],
              metadata(input) {
                const id = input.metadata?.sessionId
                if (typeof id === "string") state.child = SessionID.make(id)
              },
              ask,
              extra: {},
            },
          )

          await entered[0].promise
          expect(state.child).toBeDefined()
          expect(state.tools).toContain("edit")
          expect(state.tools).not.toContain("bash")
          expect(state.tools).not.toContain("write")
          expect(state.tools).not.toContain("apply_patch")
          const active = await Session.get(state.child!)
          expect(active.permission?.filter((rule) => rule.permission === "delegate_edit")).toHaveLength(1)
          expect(DelegatedEdit.inspect(active.id)).toEqual({
            parent: current.session.id,
            child: active.id,
            call: "live-task",
            scope: { operation: "edit", path: path.join(".kilo", "agent", "reviewer.md") },
            consumed: false,
          })
          release[0].resolve()

          await entered[1].promise
          expect(DelegatedEdit.inspect(active.id)?.consumed).toBe(true)
          release[1].resolve()

          await entered[2].promise
          expect(DelegatedEdit.inspect(active.id)?.consumed).toBe(true)
          release[2].resolve()
          await run

          const children = await Session.children(current.session.id)
          expect(children).toHaveLength(1)
          const child = await Session.get(children[0].id)
          expect(child.permission?.filter((rule) => rule.permission === "delegate_edit")).toHaveLength(1)
          expect(DelegatedEdit.inspect(child.id)).toBeUndefined()
          expect(await Bun.file(path.join(tmp.path, ".kilo", "agent", "reviewer.md")).text()).toContain(
            "description: scoped read-only diff sanity reviewer",
          )
          expect(await Bun.file(path.join(tmp.path, ".kilo", "agent", "orchestrator.md")).text()).toContain(
            "description: Coordinate complex tasks with planning-first delegation.",
          )

          await SessionPrompt.prompt({
            sessionID: child.id,
            agent: phase!.name,
            model: { providerID: model().providerID, modelID: model().id },
            parts: [{ type: "text", text: "Attempt the same delegated edit after task completion." }],
          })

          expect(state.calls).toBe(8)
          expect(await Bun.file(path.join(tmp.path, ".kilo", "agent", "reviewer.md")).text()).toContain(
            "description: scoped read-only diff sanity reviewer",
          )
          const messages = await Session.messages({ sessionID: child.id })
          const edits = messages
            .flatMap((message) => message.parts)
            .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "edit")
          expect(edits).toHaveLength(4)
          expect(edits[0]?.state.status).toBe("completed")
          for (const part of edits.slice(1)) {
            expect(part.state.status).toBe("error")
            if (part.state.status === "error") {
              expect(part.state.error).toContain("prevents you from using this specific tool call")
            }
          }
        },
      })
    } finally {
      server.stop(true)
    }
  }, 30_000)

  test("selected child must already have edit capability", async () => {
    const original = SessionPrompt.prompt
    let prompts = 0
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copy(dir, ["orchestrator", "reviewer"]),
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const parent = await Agent.get("orchestrator")
          const current = await setup()
          ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = (async () => {
            prompts++
            return { parts: [{ type: "text", text: "unexpected" }] }
          }) as unknown as typeof SessionPrompt.prompt
          const ask = ToolAsk.build({
            sessionID: current.session.id,
            messageID: current.assistant,
            callID: "reviewer-edit",
            operation: "task",
            agent: parent!.permission,
            session: current.session.permission ?? [],
          }).ask
          const tool = await TaskTool.init()
          await expect(
            tool.execute(
              {
                description: "invalid reviewer edit",
                prompt: "Edit reviewer config",
                subagent_type: "reviewer",
                authorization: { operation: "edit", path: ".kilo/agent/reviewer.md" },
              },
              {
                sessionID: current.session.id,
                messageID: current.assistant,
                callID: "reviewer-edit",
                agent: "orchestrator",
                abort: AbortSignal.any([]),
                messages: [],
                metadata: () => {},
                ask,
                extra: {},
              },
            ),
          ).rejects.toThrow('Agent "reviewer" does not allow delegated edits')
          expect(prompts).toBe(0)
        },
      })
    } finally {
      ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = original
    }
  })

  test("delegated edit authorization cannot resume an existing child task", async () => {
    const original = SessionPrompt.prompt
    const state = { prompts: 0 }
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copy(dir, ["orchestrator", "phase2f-implementer"]),
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const parent = await Agent.get("orchestrator")
          expect(parent).toBeDefined()
          const current = await setup()
          ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = (async () => {
            state.prompts++
            return { parts: [{ type: "text", text: "unexpected" }] }
          }) as unknown as typeof SessionPrompt.prompt
          const ask = ToolAsk.build({
            sessionID: current.session.id,
            messageID: current.assistant,
            callID: "resume-edit",
            operation: "task",
            agent: parent!.permission,
            session: current.session.permission ?? [],
          }).ask
          const tool = await TaskTool.init()
          await expect(
            tool.execute(
              {
                description: "resume delegated edit",
                prompt: "Edit reviewer config",
                subagent_type: "phase2f-implementer",
                task_id: "ses_existing",
                authorization: { operation: "edit", path: ".kilo/agent/reviewer.md" },
              },
              {
                sessionID: current.session.id,
                messageID: current.assistant,
                callID: "resume-edit",
                agent: parent!.name,
                abort: AbortSignal.any([]),
                messages: [],
                metadata: () => {},
                ask,
                extra: {},
              },
            ),
          ).rejects.toThrow("Delegated edit authorization cannot resume an existing task")
          expect(state.prompts).toBe(0)
        },
      })
    } finally {
      ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = original
    }
  })
})
