// kilocode_change - new file
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { fn } from "../../../src/util/fn"
import fs from "node:fs/promises"
import path from "node:path"
import { Agent } from "../../../src/agent/agent"
import { BackgroundSubagentControl } from "../../../src/kilocode/background-subagent-control"
import { BackgroundTask } from "../../../src/kilocode/background-task"
import { BackgroundTaskTool } from "../../../src/kilocode/background-task-tool"
import { CapabilityAuthority } from "../../../src/kilocode/capability/authority"
import { AuthorityStore } from "../../../src/kilocode/capability/authority-store"
import { DelegateEditTool } from "../../../src/kilocode/delegate-edit-tool"
import { DelegatedEdit } from "../../../src/kilocode/delegated-edit"
import { Permission } from "../../../src/permission"
import { Instance } from "../../../src/project/instance"
import { ModelID, ProviderID } from "../../../src/provider/schema"
import { Session } from "../../../src/session"
import { MessageV2 } from "../../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../../src/session/schema"
import { SessionPrompt } from "../../../src/session/prompt"
import { filterResolvedTools } from "../../../src/tool/resolve"
import { TaskTool } from "../../../src/tool/task"
import type { Tool } from "../../../src/tool/tool"
import { resetDatabase } from "../../fixture/db"
import { tmpdir } from "../../fixture/fixture"

const model = { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") }
const root = path.resolve(import.meta.dir, "../../../../..")

async function copy(dir: string, agents: string[]) {
  const dest = path.join(dir, ".kilo", "agent")
  await fs.mkdir(dest, { recursive: true })
  await Promise.all(
    agents.map((agent) =>
      Bun.write(path.join(dest, agent + ".md"), Bun.file(path.join(root, ".kilo", "agent", agent + ".md"))),
    ),
  )
}
const denied = [
  ["read", "src/index.ts"],
  ["glob", "src/**/*.ts"],
  ["edit", "src/index.ts"],
  ["write", "src/index.ts"],
  ["apply_patch", "src/index.ts"],
  ["bash", "git status"],
  ["skill", "testing"],
  ["synthetic_search", "*"],
  ["lsp", "*"],
  ["webfetch", "*"],
  ["websearch", "*"],
  ["codesearch", "*"],
  ["codebase_search", "*"],
  ["external_directory", "C:/outside/*"],
  ["recall", "search"],
  ["remember", "key"],
  ["task", "general"],
  ["background_task", "explore"],
  ["github-triage", "*"],
  ["todowrite", "*"],
  ["question", "*"],
  ["plan_exit", "*"],
] as const

const parent = {
  "*": "allow",
  task: "allow",
  background_task: "allow",
  read: "deny",
  glob: "deny",
  edit: "deny",
  write: "deny",
  apply_patch: "deny",
  bash: "deny",
  skill: "deny",
  synthetic_search: "deny",
  lsp: "deny",
  webfetch: "allow",
  websearch: "deny",
  codesearch: "deny",
  codebase_search: "deny",
  external_directory: "deny",
  recall: "deny",
  remember: "deny",
  "github-triage": "deny",
  todowrite: "deny",
  question: "deny",
  plan_exit: "deny",
} as const

function config() {
  return {
    experimental: { openTelemetry: false, primary_tools: ["bash"] },
    agent: {
      orchestrator: { mode: "primary" as const, permission: parent },
      alpha: { mode: "subagent" as const, permission: { "*": "allow" as const } },
    },
  }
}

async function seed(permission: Permission.Ruleset = []) {
  const session = await Session.create({ permission })
  const user = MessageID.ascending()
  const assistant = MessageID.ascending()
  await Session.updateMessage({
    id: user,
    role: "user",
    sessionID: session.id,
    agent: "orchestrator",
    model,
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
    modelID: model.modelID,
    providerID: model.providerID,
  })
  return { session, assistant }
}

function ctx(sessionID: SessionID, messageID: MessageID, agent = "orchestrator", bypass = false): Tool.Context {
  return {
    sessionID,
    messageID,
    callID: `call-${agent}`,
    agent,
    abort: new AbortController().signal,
    messages: [],
    metadata(_input) {},
    async ask(_input) {},
    extra: bypass ? { bypassAgentCheck: true } : {},
  }
}

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("immutable static ceilings", () => {
  test("session, message, approval, and primary tool allows cannot reopen a deny", async () => {
    const role = [{ permission: "edit", pattern: "*", action: "deny" as const }]
    const agent = [{ permission: "edit", pattern: "*", action: "allow" as const }]
    const session = [{ permission: "edit", pattern: "*", action: "allow" as const }]
    const result = filterResolvedTools({
      tools: { edit: {}, write: {}, apply_patch: {} },
      role,
      agent,
      session,
      user: { edit: true, write: true, apply_patch: true },
    })
    expect(result).toEqual({})
    expect(
      CapabilityAuthority.evaluate({
        permission: "edit",
        pattern: "src/index.ts",
        role,
        agent,
        session,
        approved: [{ permission: "edit", pattern: "*", action: "allow" }],
      }).action,
    ).toBe("deny")

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const current = await Session.create({})
        await Permission.allowEverything({ enable: true, sessionID: current.id })
        await expect(
          Permission.ask(
            {
              sessionID: current.id,
              permission: "edit",
              patterns: ["src/index.ts"],
              always: ["*"],
              metadata: {},
              ruleset: agent,
              narrow: session,
            },
            role,
          ),
        ).rejects.toBeInstanceOf(Permission.DeniedError)
      },
    })
  })

  test("ordinary session rules still narrow authority", () => {
    const tools = filterResolvedTools({
      tools: { read: {}, bash: {} },
      agent: [{ permission: "*", pattern: "*", action: "allow" }],
      session: [{ permission: "bash", pattern: "*", action: "deny" }],
    })
    expect(Object.keys(tools)).toEqual(["read"])
  })

  test("public rules cannot forge internal authority metadata", () => {
    expect(
      Permission.Rule.safeParse({
        permission: "read",
        pattern: "*",
        action: "allow",
        ceiling: "role:forged",
      }).success,
    ).toBe(false)
  })

  test("cfg allows cannot reopen a canonical deny and cfg denies narrow a canonical allow", async () => {
    await using tmp = await tmpdir({ git: true, init: (dir) => copy(dir, ["orchestrator"]) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("orchestrator")
        const role = await Agent.policy("orchestrator")
        expect(agent).toBeDefined()

        const widened = Permission.merge(
          agent!.permission,
          Permission.fromConfig({ background_task: "allow", edit: "allow" }),
        )
        expect(
          CapabilityAuthority.evaluate({
            permission: "background_task",
            pattern: "explore",
            role,
            agent: widened,
          }).action,
        ).toBe("deny")

        const narrowed = Permission.merge(agent!.permission, Permission.fromConfig({ read: "deny" }))
        expect(
          CapabilityAuthority.evaluate({
            permission: "read",
            pattern: "src/index.ts",
            role,
            agent: narrowed,
          }).action,
        ).toBe("deny")
      },
    })
  })

  test("verified lease reopens only its exact mutation tool", () => {
    const edit = filterResolvedTools({
      tools: { edit: {}, populate: {}, write: {}, apply_patch: {}, bash: {} },
      agent: [{ permission: "*", pattern: "*", action: "deny" }],
      delegatedEdit: { operation: "edit", path: "target.ts" },
    })
    const populate = filterResolvedTools({
      tools: { edit: {}, populate: {}, write: {}, apply_patch: {}, bash: {} },
      agent: [{ permission: "*", pattern: "*", action: "deny" }],
      delegatedEdit: { operation: "populate", path: "empty.ts" },
    })
    expect(Object.keys(edit)).toEqual(["edit"])
    expect(Object.keys(populate)).toEqual(["populate"])
  })

  test("direct message routing cannot cross the caller task ceiling", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          caller: { mode: "primary", permission: { "*": "allow", task: "deny" } },
          alpha: { mode: "subagent", permission: { "*": "allow" } },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await seed()
        const create = spyOn(Session, "create")
        try {
          const tool = await TaskTool.init()
          await expect(
            tool.execute(
              { description: "blocked mention", prompt: "inspect only", subagent_type: "alpha" },
              ctx(root.session.id, root.assistant, "caller", true),
            ),
          ).rejects.toBeInstanceOf(Permission.DeniedError)
          expect(create).toHaveBeenCalledTimes(0)
        } finally {
          create.mockRestore()
        }
      },
    })
  })
})

describe("restrictive child intersection", () => {
  test("foreground child and multi-hop descendant retain every parent category", async () => {
    await using tmp = await tmpdir({ git: true, config: config() })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await seed([{ permission: "webfetch", pattern: "*", action: "deny" }])
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(
          fn(SessionPrompt.PromptInput, async (input): Promise<MessageV2.WithParts> => {
            const messageID = MessageID.ascending()
            return {
              info: {
                id: messageID,
                sessionID: input.sessionID,
                role: "assistant",
                parentID: input.messageID ?? MessageID.make("msg_dummy"),
                agent: "alpha",
                modelID: model.modelID,
                providerID: model.providerID,
                time: { created: Date.now() },
                mode: "subagent",
                path: { cwd: Instance.directory, root: Instance.worktree },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              },
              parts: [
                {
                  id: PartID.ascending(),
                  sessionID: input.sessionID,
                  messageID: messageID,
                  type: "text",
                  text: input.sessionID,
                },
              ],
            }
          }),
        )
        try {
          const tool = await TaskTool.init()
          const result = await tool.execute(
            { description: "inherit authority", prompt: "inspect only", subagent_type: "alpha" },
            ctx(root.session.id, root.assistant),
          )
          const child = await Session.get(result.metadata.sessionId)
          const selected = await Agent.get("alpha")
          const role = await Agent.policy("alpha")
          expect(selected).toBeDefined()
          AuthorityStore.clear()
          expect(await AuthorityStore.load(child.id)).toBeDefined()
          for (const [permission, pattern] of denied) {
            expect(
              CapabilityAuthority.evaluate({
                permission,
                pattern,
                role,
                agent: selected!.permission,
                session: child.permission,
                sessionID: child.id,
              }).action,
            ).toBe("deny")
          }

          const grand = await Session.create({ parentID: child.id })
          await AuthorityStore.create({
            childSessionID: grand.id,
            parentSessionID: child.id,
            layers: CapabilityAuthority.inherit({
              role,
              agent: selected!.permission,
              session: child.permission,
              source: child.id,
            }),
          })
          AuthorityStore.clear()
          expect(await AuthorityStore.load(grand.id)).toBeDefined()
          const open = [{ permission: "*", pattern: "*", action: "allow" as const }]
          for (const [permission, pattern] of denied) {
            expect(
              CapabilityAuthority.evaluate({
                permission,
                pattern,
                role: open,
                agent: open,
                session: grand.permission,
                sessionID: grand.id,
              }).action,
            ).toBe("deny")
          }
        } finally {
          prompt.mockRestore()
        }
      },
    })
  })

  test("background child receives the same restrictive categories", async () => {
    await using tmp = await tmpdir({ git: true, config: config() })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await seed([{ permission: "webfetch", pattern: "*", action: "deny" }])
        let child: Session.Info | undefined
        const start = spyOn(BackgroundSubagentControl, "start").mockImplementation(
          async (input): Promise<BackgroundTask.Info> => {
            child = await Session.create({ parentID: input.parentSessionID, permission: input.permission })
            await AuthorityStore.create({
              childSessionID: child.id,
              parentSessionID: input.parentSessionID,
              layers: input.authority
                ? [
                    ...input.authority.layers,
                    { kind: "role", sourceSessionID: child.id, rules: input.authority.role },
                    { kind: "config", sourceSessionID: child.id, rules: input.authority.agent },
                  ]
                : [],
            })
            return {
              taskID: "bg-kernel" as BackgroundTask.TaskID,
              childSessionID: child.id,
              status: "queued",
              parentSessionID: input.parentSessionID,
              childUserMessageID: MessageID.make("msg_dummy"),
              generation: 1,
              createdAt: Date.now(),
              startedAt: undefined,
              completedAt: undefined,
              resultMessageID: undefined,
              error: undefined,
            }
          },
        )
        try {
          const tool = await BackgroundTaskTool.init()
          await tool.execute(
            { action: "start", description: "inherit authority", prompt: "inspect only", subagent_type: "alpha" },
            ctx(root.session.id, root.assistant),
          )
          expect(start).toHaveBeenCalledTimes(1)
          const input = start.mock.calls[0][0]
          const selected = await Agent.get("alpha")
          const role = await Agent.policy("alpha")
          if (!child) throw new Error("Background child was not created")
          AuthorityStore.clear()
          expect(await AuthorityStore.load(child.id)).toBeDefined()
          for (const [permission, pattern] of denied) {
            expect(
              CapabilityAuthority.evaluate({
                permission,
                pattern,
                role,
                agent: selected!.permission,
                session: input.permission,
                sessionID: child.id,
              }).action,
            ).toBe("deny")
          }
        } finally {
          start.mockRestore()
        }
      },
    })
  })
})

test("non-Orchestrator Phase2F issuer fails before reservation or child creation", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      agent: {
        "phase2f-implementer": {
          mode: "subagent",
          permission: { "*": "deny", read: "allow", edit: "allow" },
        },
      },
    },
    init: async (dir) => {
      await Bun.write(path.join(dir, "target.ts"), "export const value = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await seed()
      const reserve = spyOn(DelegatedEdit, "reserve")
      const create = spyOn(Session, "create")
      try {
        const tool = await DelegateEditTool.init()
        await expect(
          tool.execute(
            {
              description: "invalid issuer",
              prompt: "edit target",
              operation: "edit",
              path: "target.ts",
            },
            ctx(root.session.id, root.assistant, "code"),
          ),
        ).rejects.toThrow("only Orchestrator")
        expect(reserve).toHaveBeenCalledTimes(0)
        expect(create).toHaveBeenCalledTimes(0)
      } finally {
        reserve.mockRestore()
        create.mockRestore()
      }
    },
  })
})
