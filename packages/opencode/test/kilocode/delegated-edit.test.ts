import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { BackgroundTaskTool } from "../../src/kilocode/background-task-tool"
import { DelegateEditTool } from "../../src/kilocode/delegate-edit-tool"
import { DelegatedEdit } from "../../src/kilocode/delegated-edit"
import { PopulateTool } from "../../src/kilocode/populate-tool"
import { AuthorityStore } from "../../src/kilocode/capability/authority-store"
import { ToolAsk } from "../../src/kilocode/permission/tool-ask"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
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
        expect(Permission.evaluate("bash", "git add .", git!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", 'git commit -m "test"', git!.permission).action).toBe("allow")
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

        // Wrong-operation, wrong-path, wrong-child, wrong-call: ordinary denials
        // preserved as Permission.DeniedError (no evidence is required to reject them).
        expect(() => DelegatedEdit.authorize(input(child.id, rules, "write"))).toThrow(Permission.DeniedError)
        expect(() => DelegatedEdit.authorize(input(child.id, rules, "edit", [".kilo/agent/orchestrator.md"]))).toThrow(
          Permission.DeniedError,
        )
        expect(() => DelegatedEdit.authorize(input(other.id))).toThrow(Permission.DeniedError)
        expect(() =>
          DelegatedEdit.authorize(input(child.id, DelegatedEdit.rules({ ...lease, call: "other-call" }))),
        ).toThrow(Permission.DeniedError)
        expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(false)

        // First exact-path delegated edit with matching EvidenceRecall succeeds.
        const evidence = {
          source: "delegated-edit-lease" as const,
          exactText: DelegatedEdit.canonicalLeaseText(lease, 0),
          purpose: "first edit on reviewer.md",
        }
        expect(DelegatedEdit.authorize({ ...input(child.id), evidence })).toBe(true)
        expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)
        // Replay on the same active consumed grant throws LeaseExhaustedError,
        // not Permission.DeniedError.
        expect(() => DelegatedEdit.authorize({ ...input(child.id), evidence })).toThrow(
          DelegatedEdit.LeaseExhaustedError,
        )

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
          "reason: target must not be a symbolic link",
        )
        expect(() => DelegatedEdit.scope({ operation: "edit", path: "escape/outside.ts" })).toThrow(
          "reason: target must remain physically inside the current project",
        )
        expect(() => DelegatedEdit.scope({ operation: "edit", path: "src/missing.ts" })).toThrow(
          "reason: target must already exist",
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
          ).rejects.toThrow("DELEGATED_EDIT_AUTHORIZATION_INVALID")
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
        const tool = await DelegateEditTool.init()
        await expect(
          tool.execute(
            {
              description: "missing target",
              prompt: "Edit a file that does not exist",
              operation: "edit",
              path: "missing.ts",
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
        ).rejects.toThrow("reason: target must already exist")
        expect(asks).toEqual([])
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
              child.permission?.findLast(
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
            // Phase2F evidence-recall pilot: supply verbatim canonical lease text.
            const leaseForEvidence = {
              parent: current.session.id,
              child: input.sessionID,
              call: "task-authorization" as const,
              scope: { operation: "edit" as const, path: allowed },
            }
            await edit.execute(
              {
                filePath: target,
                oldString: "description: focused read-only diff sanity reviewer",
                newString: "description: scoped read-only diff sanity reviewer",
                evidenceRecall: {
                  source: "delegated-edit-lease",
                  exactText: DelegatedEdit.canonicalLeaseText(leaseForEvidence, 0),
                  purpose: "apply the single authorized edit to reviewer.md",
                },
              },
              context("edit", "authorized"),
            )
            const after = (await Bun.file(target).text()).split(/\r?\n/)
            expect(after.filter((line, index) => line !== before[index])).toHaveLength(1)
            expect(after).toContain("description: scoped read-only diff sanity reviewer")
            // Replay on the active consumed grant throws LeaseExhaustedError.
            await expect(ask("edit", "replay")(request(allowed))).rejects.toBeInstanceOf(
              DelegatedEdit.LeaseExhaustedError,
            )
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
          const tool = await DelegateEditTool.init()
          await tool.execute(
            {
              description: "edit reviewer model",
              prompt: "Change exactly one line in .kilo/agent/reviewer.md",
              operation: "edit",
              path: ".kilo/agent/reviewer.md",
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
                operation: "edit",
                path: ".kilo/agent/reviewer.md",
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
    const original = SessionPrompt.prompt
    let child: Awaited<ReturnType<typeof Session.get>> | undefined
    let phase: Awaited<ReturnType<typeof Agent.get>> | undefined
    let allowed = ""
    let tools: Record<string, boolean> | undefined

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
              child.permission?.findLast(
                (rule) => rule.permission === "edit" && rule.action === "allow" && rule.pattern !== "*",
              )?.pattern ?? ""

            expect(
              child.permission?.filter((rule) => rule.permission === "delegate_edit" && rule.action === "allow"),
            ).toHaveLength(1)
            expect(DelegatedEdit.inspect(child.id)).toEqual({
              parent: current.session.id,
              child: child.id,
              call: "live-task",
              scope: { operation: "edit", path: path.join(".kilo", "agent", "reviewer.md") },
              consumed: false,
            })

            const internal = await AuthorityStore.load(child.id)
            expect(internal).toBeDefined()
            expect(internal!.childSessionID).toBe(child.id)
            expect(internal!.parentSessionID).toBe(current.session.id)
            expect(
              internal!.layers.some(
                (layer) =>
                  layer.kind === "control" &&
                  layer.sourceSessionID === current.session.id &&
                  layer.rules.some((rule) => rule.permission === "task" && rule.action === "deny"),
              ),
            ).toBe(true)
            expect(internal!.layers.some((layer) => layer.kind === "role")).toBe(true)
            expect(internal!.layers.some((layer) => layer.kind === "config")).toBe(true)

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

            const sibling = path.relative(
              Instance.worktree,
              path.join(Instance.directory, ".kilo", "agent", "orchestrator.md"),
            )
            const target = path.join(Instance.directory, ".kilo", "agent", "reviewer.md")
            const before = (await Bun.file(target).text()).split(/\r?\n/)

            const read = await ReadTool.init({ agent: phase! })
            await read.execute({ filePath: target }, context("read", "read-reviewer"))

            const leaseForEvidence = {
              parent: current.session.id,
              child: input.sessionID,
              call: "live-task" as const,
              scope: { operation: "edit" as const, path: allowed },
            }
            const edit = await EditTool.init({ agent: phase! })
            await edit.execute(
              {
                filePath: target,
                oldString: "description: focused read-only diff sanity reviewer",
                newString: "description: scoped read-only diff sanity reviewer",
                evidenceRecall: {
                  source: "delegated-edit-lease",
                  exactText: DelegatedEdit.canonicalLeaseText(leaseForEvidence, 0),
                  purpose: "apply the single authorized edit to reviewer.md",
                },
              },
              context("edit", "edit-first"),
            )

            const after = (await Bun.file(target).text()).split(/\r?\n/)
            expect(after.filter((line, index) => line !== before[index])).toHaveLength(1)
            expect(after).toContain("description: scoped read-only diff sanity reviewer")
            expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)

            await read.execute({ filePath: sibling }, context("read", "read-sibling"))

            await expect(ask("edit", "edit-sibling")(request(sibling))).rejects.toBeInstanceOf(Permission.DeniedError)

            await expect(ask("edit", "edit-second")(request(allowed))).rejects.toBeInstanceOf(
              DelegatedEdit.LeaseExhaustedError,
            )

            return { parts: [{ type: "text", text: "task complete" }] }
          }) as unknown as typeof SessionPrompt.prompt

          const ask = ToolAsk.build({
            sessionID: current.session.id,
            messageID: current.assistant,
            callID: "live-task",
            operation: "task",
            agent: parent!.permission,
            session: current.session.permission ?? [],
          }).ask
          const tool = await DelegateEditTool.init()
          await tool.execute(
            {
              description: "live delegated edit",
              prompt: "Read and edit reviewer.md once, then test sibling and replay denials.",
              operation: "edit",
              path: ".kilo/agent/reviewer.md",
            },
            {
              sessionID: current.session.id,
              messageID: current.assistant,
              callID: "live-task",
              agent: parent!.name,
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

          const children = await Session.children(current.session.id)
          expect(children).toHaveLength(1)
          const finalChild = await Session.get(children[0].id)
          expect(
            finalChild.permission?.filter((rule) => rule.permission === "delegate_edit" && rule.action === "allow"),
          ).toHaveLength(1)
          expect(DelegatedEdit.inspect(finalChild.id)).toBeUndefined()

          const postTaskAsk = ToolAsk.build({
            sessionID: finalChild.id,
            messageID: MessageID.ascending(),
            callID: "post-task-edit",
            operation: "edit",
            agent: phase!.permission,
            session: finalChild.permission ?? [],
          }).ask
          await expect(
            postTaskAsk({ permission: "edit", patterns: [allowed], always: ["*"], metadata: {} }),
          ).rejects.toBeInstanceOf(Permission.DeniedError)

          expect(await Bun.file(path.join(tmp.path, ".kilo", "agent", "reviewer.md")).text()).toContain(
            "description: scoped read-only diff sanity reviewer",
          )
          expect(await Bun.file(path.join(tmp.path, ".kilo", "agent", "orchestrator.md")).text()).toContain(
            "description: Coordinate complex tasks with planning-first delegation.",
          )
        },
      })
    } finally {
      ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = original
    }
  })

  test("fresh sequential leases support same-path repair and a different next path", async () => {
    const original = SessionPrompt.prompt
    const scopes: DelegatedEdit.Scope[] = []
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copy(dir, ["orchestrator", "phase2f-implementer", "reviewer"]),
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const parent = await Agent.get("orchestrator")
          const phase = await Agent.get("phase2f-implementer")
          expect(parent).toBeDefined()
          expect(phase).toBeDefined()
          const current = await setup()
          const reviewer = path.join(".kilo", "agent", "reviewer.md")
          const orchestrator = path.join(".kilo", "agent", "orchestrator.md")
          const steps = new Map([
            [
              "lease-first",
              {
                path: reviewer,
                old: "description: focused read-only diff sanity reviewer",
                next: "description: sequential delegated edit reviewer",
              },
            ],
            [
              "lease-repair",
              {
                path: reviewer,
                old: "description: sequential delegated edit reviewer",
                next: "description: focused read-only diff sanity reviewer",
              },
            ],
            [
              "lease-next-path",
              {
                path: orchestrator,
                old: "description: Coordinate complex tasks with planning-first delegation.",
                next: "description: Coordinate deterministic delegated edits.",
              },
            ],
          ])

          ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = (async (input: {
            sessionID: SessionID
          }) => {
            const child = await Session.get(input.sessionID)
            const lease = DelegatedEdit.inspect(child.id)
            expect(lease).toBeDefined()
            const step = steps.get(lease!.call)
            expect(step).toBeDefined()
            scopes.push(lease!.scope)
            const ask = ToolAsk.build({
              sessionID: child.id,
              messageID: MessageID.ascending(),
              callID: `edit-${lease!.call}`,
              operation: "edit",
              agent: phase!.permission,
              session: child.permission ?? [],
            }).ask
            const context: Tool.Context = {
              sessionID: child.id,
              messageID: MessageID.ascending(),
              callID: `edit-${lease!.call}`,
              agent: phase!.name,
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => {},
              ask,
              extra: {},
            }
            const file = path.join(tmp.path, step!.path)
            const read = await ReadTool.init({ agent: phase! })
            await read.execute({ filePath: file }, context)
            const evidence = {
              source: "delegated-edit-lease" as const,
              exactText: DelegatedEdit.canonicalLeaseText(lease!),
              purpose: `apply ${lease!.call}`,
            }
            const edit = await EditTool.init({ agent: phase! })
            await edit.execute(
              { filePath: file, oldString: step!.old, newString: step!.next, evidenceRecall: evidence },
              context,
            )
            await expect(
              ask({
                permission: "edit",
                patterns: [lease!.scope.path],
                always: ["*"],
                metadata: { evidenceRecall: evidence },
              }),
            ).rejects.toThrow("EDIT_LEASE_EXHAUSTED")
            return { parts: [{ type: "text", text: "lease complete" }] }
          }) as unknown as typeof SessionPrompt.prompt

          const tool = await DelegateEditTool.init()
          const run = async (call: string, target: string) => {
            const ask = ToolAsk.build({
              sessionID: current.session.id,
              messageID: current.assistant,
              callID: call,
              operation: "delegate_edit",
              agent: parent!.permission,
              session: current.session.permission ?? [],
            }).ask
            return tool.execute(
              {
                description: "sequential lease",
                prompt: "Apply exactly one authorized mutation",
                operation: "edit",
                path: target,
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

          await run("lease-first", reviewer)
          await run("lease-repair", reviewer)
          await run("lease-next-path", orchestrator)

          expect(scopes).toEqual([
            { operation: "edit", path: reviewer },
            { operation: "edit", path: reviewer },
            { operation: "edit", path: orchestrator },
          ])
          expect(await Session.children(current.session.id)).toHaveLength(3)
          expect(await Bun.file(path.join(tmp.path, reviewer)).text()).toContain(
            "description: focused read-only diff sanity reviewer",
          )
          expect(await Bun.file(path.join(tmp.path, orchestrator)).text()).toContain(
            "description: Coordinate deterministic delegated edits.",
          )
        },
      })
    } finally {
      ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = original
    }
  })

  test("populate lease fills an existing empty file through an explicit operation", async () => {
    const original = SessionPrompt.prompt
    const state = { prompts: 0, tools: undefined as Record<string, boolean> | undefined }
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await copy(dir, ["orchestrator", "phase2f-implementer"])
        await Bun.write(path.join(dir, "empty.ts"), "")
      },
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const parent = await Agent.get("orchestrator")
          const phase = await Agent.get("phase2f-implementer")
          expect(parent).toBeDefined()
          expect(phase).toBeDefined()
          const current = await setup()
          ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = (async (input: {
            sessionID: SessionID
            tools?: Record<string, boolean>
          }) => {
            state.prompts++
            state.tools = input.tools
            const child = await Session.get(input.sessionID)
            const lease = DelegatedEdit.inspect(child.id)
            expect(lease?.scope).toEqual({ operation: "populate", path: "empty.ts" })
            const ask = ToolAsk.build({
              sessionID: child.id,
              messageID: MessageID.ascending(),
              callID: "populate-empty",
              operation: "populate",
              agent: phase!.permission,
              session: child.permission ?? [],
            }).ask
            const populate = await PopulateTool.init({ agent: phase! })
            await populate.execute(
              {
                filePath: path.join(tmp.path, "empty.ts"),
                content: "export const ready = true\n",
                evidenceRecall: {
                  source: "delegated-edit-lease",
                  exactText: DelegatedEdit.canonicalLeaseText(lease!),
                  purpose: "populate the authorized empty file",
                },
              },
              {
                sessionID: child.id,
                messageID: MessageID.ascending(),
                callID: "populate-empty",
                agent: phase!.name,
                abort: AbortSignal.any([]),
                messages: [],
                metadata: () => {},
                ask,
                extra: {},
              },
            )
            return { parts: [{ type: "text", text: "populated" }] }
          }) as unknown as typeof SessionPrompt.prompt

          const tool = await DelegateEditTool.init()
          const context = (call: string): Tool.Context => ({
            sessionID: current.session.id,
            messageID: current.assistant,
            callID: call,
            agent: parent!.name,
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: ToolAsk.build({
              sessionID: current.session.id,
              messageID: current.assistant,
              callID: call,
              operation: "delegate_edit",
              agent: parent!.permission,
              session: current.session.permission ?? [],
            }).ask,
            extra: {},
          })
          await expect(
            tool.execute(
              { description: "wrong empty operation", prompt: "Edit empty.ts", operation: "edit", path: "empty.ts" },
              context("empty-edit"),
            ),
          ).rejects.toThrow("expected_operation: populate")
          expect(state.prompts).toBe(0)
          expect(await Session.children(current.session.id)).toHaveLength(0)

          await tool.execute(
            {
              description: "populate empty file",
              prompt: "Populate empty.ts",
              operation: "populate",
              path: "empty.ts",
            },
            context("empty-populate"),
          )
          expect(state.prompts).toBe(1)
          expect(state.tools?.edit).toBe(false)
          expect(state.tools?.write).toBe(false)
          expect(state.tools?.populate).toBeUndefined()
          expect(await Bun.file(path.join(tmp.path, "empty.ts")).text()).toBe("export const ready = true\n")
        },
      })
    } finally {
      ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = original
    }
  })

  test("read-only agents cannot receive delegated-edit authorization", async () => {
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
          const parent = await Agent.get("reviewer")
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
          const tool = await DelegateEditTool.init()
          await expect(
            tool.execute(
              {
                description: "invalid reviewer edit",
                prompt: "Edit reviewer config",
                operation: "edit",
                path: ".kilo/agent/reviewer.md",
              },
              {
                sessionID: current.session.id,
                messageID: current.assistant,
                callID: "reviewer-edit",
                agent: "reviewer",
                abort: AbortSignal.any([]),
                messages: [],
                metadata: () => {},
                ask,
                extra: {},
              },
            ),
          ).rejects.toThrow("reason: only Orchestrator may authorize Phase2F implementation tasks")
          expect(prompts).toBe(0)
          expect(await Session.children(current.session.id)).toHaveLength(0)
        },
      })
    } finally {
      ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = original
    }
  })

  test("delegate_edit has no child-resume argument", async () => {
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
          const tool = await DelegateEditTool.init()
          await expect(
            tool.execute(
              {
                description: "resume delegated edit",
                prompt: "Edit reviewer config",
                task_id: "ses_existing",
                operation: "edit",
                path: ".kilo/agent/reviewer.md",
              } as never,
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
          ).rejects.toThrow("DELEGATED_EDIT_AUTHORIZATION_INVALID")
          expect(state.prompts).toBe(0)
          expect(await Session.children(current.session.id)).toHaveLength(0)
        },
      })
    } finally {
      ;(SessionPrompt as unknown as { prompt: typeof SessionPrompt.prompt }).prompt = original
    }
  })

  // ─── Evidence-recall pilot tests ───────────────────────────────

  test("canonicalLeaseText renders path with both used-edits values", async () => {
    const lease = {
      parent: SessionID.make("ses_parent"),
      child: SessionID.make("ses_child"),
      call: "test",
      scope: { operation: "edit" as const, path: ".kilo/agent/reviewer.md" },
    }
    const text0 = DelegatedEdit.canonicalLeaseText(lease, 0)
    expect(text0).toContain("path: .kilo/agent/reviewer.md")
    expect(text0).toContain("allowed edits: 1")
    expect(text0).toContain("used edits: 0")

    const text1 = DelegatedEdit.canonicalLeaseText(lease, 1)
    expect(text1).toContain("used edits: 1")
    expect(text1).not.toContain("used edits: 0")
  })

  test("EvidenceFailedError message matches spec", () => {
    const err = new DelegatedEdit.EvidenceFailedError(".kilo/agent/reviewer.md")
    expect(err.message).toBe(
      "EVIDENCE_RECALL_FAILED\nsource: delegated-edit-lease\npath: .kilo/agent/reviewer.md\nno_tool_call_executed: true",
    )
    expect(err.path).toBe(".kilo/agent/reviewer.md")
  })

  test("LeaseExhaustedError message matches spec", () => {
    const err = new DelegatedEdit.LeaseExhaustedError(".kilo/agent/reviewer.md")
    expect(err.message).toBe("EDIT_LEASE_EXHAUSTED\npath: .kilo/agent/reviewer.md\nallowed: 1\nused: 1")
    expect(err.path).toBe(".kilo/agent/reviewer.md")
    expect(err.allowed).toBe(1)
    expect(err.used).toBe(1)
  })

  test("authorize throws EvidenceFailedError when evidence missing on Phase2F grant", async () => {
    await using tmp = await tmpdir({ git: true, init: (dir) => copy(dir, ["reviewer"]) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ title: "child", parentID: parent.id })
        const scope = DelegatedEdit.scope({ operation: "edit", path: ".kilo/agent/reviewer.md" })
        const lease = { parent: parent.id, child: child.id, call: "ev-test", scope }
        const rules = DelegatedEdit.rules(lease)
        const reservation = DelegatedEdit.reserve(lease)
        const binding = DelegatedEdit.bind(reservation, child.id)
        try {
          expect(() =>
            DelegatedEdit.authorize({
              sessionID: child.id,
              operation: "edit",
              permission: "edit",
              patterns: [scope.path],
              session: rules,
              // evidence deliberately omitted
            }),
          ).toThrow(DelegatedEdit.EvidenceFailedError)
        } finally {
          binding.release()
        }
      },
    })
  })

  test("authorize throws EvidenceFailedError on mismatching exactText", async () => {
    await using tmp = await tmpdir({ git: true, init: (dir) => copy(dir, ["reviewer"]) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ title: "child", parentID: parent.id })
        const scope = DelegatedEdit.scope({ operation: "edit", path: ".kilo/agent/reviewer.md" })
        const lease = { parent: parent.id, child: child.id, call: "ev-text", scope }
        const rules = DelegatedEdit.rules(lease)
        const reservation = DelegatedEdit.reserve(lease)
        const binding = DelegatedEdit.bind(reservation, child.id)
        try {
          expect(() =>
            DelegatedEdit.authorize({
              sessionID: child.id,
              operation: "edit",
              permission: "edit",
              patterns: [scope.path],
              session: rules,
              evidence: {
                source: "delegated-edit-lease" as const,
                exactText: "wrong text that does not match the canonical lease",
                purpose: "should fail",
              },
            }),
          ).toThrow(DelegatedEdit.EvidenceFailedError)
          expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(false)
        } finally {
          binding.release()
        }
      },
    })
  })

  test("matching evidence allows the delegated edit and consumes the grant", async () => {
    await using tmp = await tmpdir({ git: true, init: (dir) => copy(dir, ["reviewer"]) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ title: "child", parentID: parent.id })
        const scope = DelegatedEdit.scope({ operation: "edit", path: ".kilo/agent/reviewer.md" })
        const lease = { parent: parent.id, child: child.id, call: "ev-ok", scope }
        const rules = DelegatedEdit.rules(lease)
        const reservation = DelegatedEdit.reserve(lease)
        const binding = DelegatedEdit.bind(reservation, child.id)
        try {
          const expected = DelegatedEdit.canonicalLeaseText({
            parent: parent.id,
            child: child.id,
            call: "ev-ok",
            scope,
          })
          const result = DelegatedEdit.authorize({
            sessionID: child.id,
            operation: "edit",
            permission: "edit",
            patterns: [scope.path],
            session: rules,
            evidence: {
              source: "delegated-edit-lease" as const,
              exactText: expected,
              purpose: "edit the reviewer file as authorized",
            },
          })
          expect(result).toBe(true)
          expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)
        } finally {
          binding.release()
        }
      },
    })
  })

  test("explicit exhaustion throws LeaseExhaustedError with exact message on second exact-path edit while grant is bound", async () => {
    await using tmp = await tmpdir({ git: true, init: (dir) => copy(dir, ["reviewer"]) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ title: "child", parentID: parent.id })
        const scope = DelegatedEdit.scope({ operation: "edit", path: ".kilo/agent/reviewer.md" })
        const lease = { parent: parent.id, child: child.id, call: "exhaust", scope }
        const rules = DelegatedEdit.rules(lease)
        const reservation = DelegatedEdit.reserve(lease)
        const binding = DelegatedEdit.bind(reservation, child.id)
        try {
          // First exact-path call with matching evidence succeeds.
          const evidence = {
            source: "delegated-edit-lease" as const,
            exactText: DelegatedEdit.canonicalLeaseText(lease, 0),
            purpose: "consumes the grant",
          }
          expect(
            DelegatedEdit.authorize({
              sessionID: child.id,
              operation: "edit",
              permission: "edit",
              patterns: [scope.path],
              session: rules,
              evidence,
            }),
          ).toBe(true)
          expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)

          // Second exact-path call on the same active bound grant throws
          // LeaseExhaustedError (not Permission.DeniedError).
          try {
            DelegatedEdit.authorize({
              sessionID: child.id,
              operation: "edit",
              permission: "edit",
              patterns: [scope.path],
              session: rules,
              evidence,
            })
            expect("should have thrown").toBe("")
          } catch (err) {
            expect(err).toBeInstanceOf(DelegatedEdit.LeaseExhaustedError)
          }
        } finally {
          binding.release()
        }
        // After release, the same input throws Permission.DeniedError (missing
        // binding, not exhaustion).
        expect(() =>
          DelegatedEdit.authorize({
            sessionID: child.id,
            operation: "edit",
            permission: "edit",
            patterns: [scope.path],
            session: rules,
            evidence: {
              source: "delegated-edit-lease" as const,
              exactText: DelegatedEdit.canonicalLeaseText(lease, 0),
              purpose: "post-release should fail with denial not exhaustion",
            },
          }),
        ).toThrow(Permission.DeniedError)
      },
    })
  })

  test("missing evidence retry — EvidenceFailedError leaves grant unconsumed for subsequent retry", async () => {
    await using tmp = await tmpdir({ git: true, init: (dir) => copy(dir, ["reviewer"]) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ title: "child", parentID: parent.id })
        const scope = DelegatedEdit.scope({ operation: "edit", path: ".kilo/agent/reviewer.md" })
        const lease = { parent: parent.id, child: child.id, call: "evidence-retry", scope }
        const rules = DelegatedEdit.rules(lease)
        const reservation = DelegatedEdit.reserve(lease)
        const binding = DelegatedEdit.bind(reservation, child.id)
        try {
          const input = (evidence?: DelegatedEdit.EvidenceRecall) => ({
            sessionID: child.id,
            operation: "edit",
            permission: "edit",
            patterns: [scope.path],
            session: rules,
            evidence,
          })

          // First call without evidence throws EvidenceFailedError.
          expect(() => DelegatedEdit.authorize(input())).toThrow(DelegatedEdit.EvidenceFailedError)
          // Grant remains unconsumed.
          expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(false)

          // Retry with valid evidence succeeds.
          const valid = DelegatedEdit.canonicalLeaseText(lease, 0)
          expect(
            DelegatedEdit.authorize(
              input({ source: "delegated-edit-lease", exactText: valid, purpose: "retry after missing evidence" }),
            ),
          ).toBe(true)
          expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)
        } finally {
          binding.release()
        }
      },
    })
  })

  test("evidence retry full cycle — missing → retry OK → replay exhausted → sibling denied → post-task denied", async () => {
    await using tmp = await tmpdir({ git: true, init: (dir) => copy(dir, ["reviewer"]) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ title: "child", parentID: parent.id })
        const scope = DelegatedEdit.scope({ operation: "edit", path: ".kilo/agent/reviewer.md" })
        const lease = { parent: parent.id, child: child.id, call: "evidence-full-cycle", scope }
        const rules = DelegatedEdit.rules(lease)
        const reservation = DelegatedEdit.reserve(lease)
        const binding = DelegatedEdit.bind(reservation, child.id)
        const input = (recall?: DelegatedEdit.EvidenceRecall, paths?: string[]) => ({
          sessionID: child.id,
          operation: "edit",
          permission: "edit",
          patterns: paths ?? [scope.path],
          session: rules,
          evidence: recall,
        })
        try {
          // 2. First attempt: missing evidence → EvidenceFailedError
          try {
            DelegatedEdit.authorize(input())
            expect("should throw").toBe("EvidenceFailedError")
          } catch (err) {
            expect(err).toBeInstanceOf(DelegatedEdit.EvidenceFailedError)
          }

          // 3. Grant remains unconsumed
          expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(false)

          // 4. Second attempt: valid evidence succeeds
          const text = DelegatedEdit.canonicalLeaseText(lease, 0)
          const recall = { source: "delegated-edit-lease" as const, exactText: text, purpose: "full cycle" }
          expect(DelegatedEdit.authorize(input(recall))).toBe(true)
          expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)

          // 5. Third attempt: replay denied → LeaseExhaustedError
          try {
            DelegatedEdit.authorize(input(recall))
            expect("should throw").toBe("LeaseExhaustedError")
          } catch (err) {
            expect(err).toBeInstanceOf(DelegatedEdit.LeaseExhaustedError)
          }

          // 6. Sibling-path denied → Permission.DeniedError
          try {
            DelegatedEdit.authorize(input(recall, [".kilo/agent/orchestrator.md"]))
            expect("should throw").toBe("Permission.DeniedError")
          } catch (err) {
            expect(err).toBeInstanceOf(Permission.DeniedError)
          }
        } finally {
          binding.release()
        }

        // 7. Assert released
        expect(DelegatedEdit.inspect(child.id)).toBe(undefined)

        // 8. Post-task (post-release) denied → Permission.DeniedError
        try {
          DelegatedEdit.authorize(
            input({
              source: "delegated-edit-lease" as const,
              exactText: DelegatedEdit.canonicalLeaseText(lease, 0),
              purpose: "post-release",
            }),
          )
          expect("should throw").toBe("Permission.DeniedError")
        } catch (err) {
          expect(err).toBeInstanceOf(Permission.DeniedError)
        }
      },
    })
  })

  test("wrong operation on consumed grant throws DeniedError before exhaustion check", async () => {
    await using tmp = await tmpdir({ git: true, init: (dir) => copy(dir, ["reviewer"]) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ title: "child", parentID: parent.id })
        const scope = DelegatedEdit.scope({ operation: "edit", path: ".kilo/agent/reviewer.md" })
        const lease = { parent: parent.id, child: child.id, call: "op-consumed", scope }
        const rules = DelegatedEdit.rules(lease)
        const reservation = DelegatedEdit.reserve(lease)
        const binding = DelegatedEdit.bind(reservation, child.id)
        try {
          const evidence = {
            source: "delegated-edit-lease" as const,
            exactText: DelegatedEdit.canonicalLeaseText(lease, 0),
            purpose: "consumes the grant",
          }
          expect(
            DelegatedEdit.authorize({
              sessionID: child.id,
              operation: "edit",
              permission: "edit",
              patterns: [scope.path],
              session: rules,
              evidence,
            }),
          ).toBe(true)
          expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)

          // Operation check (line 224) precedes consumed check (line 228).
          expect(() =>
            DelegatedEdit.authorize({
              sessionID: child.id,
              operation: "write",
              permission: "edit",
              patterns: [scope.path],
              session: rules,
              evidence,
            }),
          ).toThrow(Permission.DeniedError)
        } finally {
          binding.release()
        }
      },
    })
  })

  test("wrong path on consumed grant throws DeniedError before exhaustion check", async () => {
    await using tmp = await tmpdir({ git: true, init: (dir) => copy(dir, ["reviewer"]) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ title: "child", parentID: parent.id })
        const scope = DelegatedEdit.scope({ operation: "edit", path: ".kilo/agent/reviewer.md" })
        const lease = { parent: parent.id, child: child.id, call: "path-consumed", scope }
        const rules = DelegatedEdit.rules(lease)
        const reservation = DelegatedEdit.reserve(lease)
        const binding = DelegatedEdit.bind(reservation, child.id)
        try {
          const evidence = {
            source: "delegated-edit-lease" as const,
            exactText: DelegatedEdit.canonicalLeaseText(lease, 0),
            purpose: "consumes the grant",
          }
          expect(
            DelegatedEdit.authorize({
              sessionID: child.id,
              operation: "edit",
              permission: "edit",
              patterns: [scope.path],
              session: rules,
              evidence,
            }),
          ).toBe(true)
          expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)

          // Path check (line 225-226) precedes consumed check (line 228).
          expect(() =>
            DelegatedEdit.authorize({
              sessionID: child.id,
              operation: "edit",
              permission: "edit",
              patterns: [".kilo/agent/orchestrator.md"],
              session: rules,
              evidence,
            }),
          ).toThrow(Permission.DeniedError)
        } finally {
          binding.release()
        }
      },
    })
  })
})
