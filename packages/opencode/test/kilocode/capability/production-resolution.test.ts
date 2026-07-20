// kilocode_change - new file
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../../src/agent/agent"
import { BackgroundSubagentControl } from "../../../src/kilocode/background-subagent-control"
import { BackgroundTaskTool } from "../../../src/kilocode/background-task-tool"
import { Permission } from "../../../src/permission"
import { Instance } from "../../../src/project/instance"
import { ModelID, ProviderID } from "../../../src/provider/schema"
import { Session } from "../../../src/session"
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionPrompt } from "../../../src/session/prompt"
import { MessageID } from "../../../src/session/schema"
import { Skill } from "../../../src/skill"
import { filterResolvedTools } from "../../../src/tool/resolve"
import { SkillTool } from "../../../src/tool/skill"
import type { Tool } from "../../../src/tool/tool"
import { resetDatabase } from "../../fixture/db"
import { tmpdir } from "../../fixture/fixture"

const root = path.resolve(import.meta.dir, "../../../../..")
const names = ["orchestrator", "reviewer", "git-ops", "freeprobe"]
const catalog = [
  "read",
  "grep",
  "glob",
  "bash",
  "edit",
  "write",
  "apply_patch",
  "task",
  "background_task",
  "todowrite",
  "question",
  "skill",
  "webfetch",
  "websearch",
  "codesearch",
  "codebase_search",
  "lsp",
  "github_create_issue",
  "server_issue",
]

async function copy(dir: string, agents = names) {
  const dest = path.join(dir, ".kilo", "agent")
  await fs.mkdir(dest, { recursive: true })
  await Promise.all(
    agents.map(async (name) => {
      const src = path.join(root, ".kilo", "agent", name + ".md")
      await Bun.write(path.join(dest, name + ".md"), await Bun.file(src).text())
    }),
  )
}

function tools(ids = catalog) {
  return Object.fromEntries(ids.map((id) => [id, { id }]))
}

function keys(input: Record<string, unknown>) {
  return Object.keys(input).toSorted()
}

function ctx(input: {
  session: Session.Info
  messageID?: MessageID
  agent: string
  ruleset: Permission.Ruleset
  calls?: Omit<Permission.Request, "id" | "sessionID" | "tool">[]
}): Tool.Context {
  return {
    sessionID: input.session.id,
    messageID: input.messageID ?? MessageID.ascending(),
    callID: "call-production-resolution",
    agent: input.agent,
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask(req) {
      input.calls?.push(req)
      await Permission.ask({
        ...req,
        sessionID: input.session.id,
        ruleset: input.ruleset,
      })
    },
  }
}

async function seed(agent: string) {
  const session = await Session.create({})
  const user = MessageID.ascending()
  const assistant = MessageID.ascending()
  await Session.updateMessage({
    id: user,
    role: "user",
    sessionID: session.id,
    agent,
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    time: { created: Date.now() },
  })
  await Session.updateMessage({
    id: assistant,
    role: "assistant",
    parentID: user,
    sessionID: session.id,
    agent,
    mode: agent,
    path: { cwd: Instance.directory, root: Instance.worktree },
    time: { created: Date.now() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
  })
  return { session, assistant }
}

afterEach(async () => {
  await resetDatabase()
})

describe("production tool resolution", () => {
  test("filters the actual dictionary with tracked real-role policies", async () => {
    await using tmp = await tmpdir({ git: true, init: copy })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const orchestrator = await Agent.get("orchestrator")
        const reviewer = await Agent.get("reviewer")
        const git = await Agent.get("git-ops")
        const freeprobe = await Agent.get("freeprobe")
        expect(orchestrator).toBeDefined()
        expect(reviewer).toBeDefined()
        expect(git).toBeDefined()
        expect(freeprobe).toBeDefined()

        const orchestration = filterResolvedTools({ tools: tools(), agent: orchestrator!.permission })
        expect(orchestration.task).toBeDefined()
        expect(orchestration.background_task).toBeUndefined()
        expect(orchestration.edit).toBeDefined()
        expect(orchestration.write).toBeUndefined()
        expect(orchestration.webfetch).toBeUndefined()
        expect(orchestration.websearch).toBeUndefined()
        expect(orchestration.codesearch).toBeUndefined()
        expect(orchestration.codebase_search).toBeUndefined()
        expect(orchestration.lsp).toBeUndefined()

        const review = filterResolvedTools({ tools: tools(), agent: reviewer!.permission })
        expect(review.edit).toBeUndefined()
        expect(review.write).toBeUndefined()

        const operations = filterResolvedTools({ tools: tools(), agent: git!.permission })
        expect(operations.bash).toBeDefined()
        expect(operations.edit).toBeUndefined()
        expect(operations.write).toBeUndefined()

        const probe = filterResolvedTools({ tools: tools(), agent: freeprobe!.permission })
        expect(probe.github_create_issue).toBeUndefined()
        expect(probe.server_issue).toBeUndefined()
        expect(keys(probe)).toEqual(["glob", "grep", "read", "skill"])
      },
    })
  })

  test("applies session and per-message restrictions without mutating the input", () => {
    const input = tools(["read", "task", "background_task"])
    const filtered = filterResolvedTools({
      tools: input,
      agent: [
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "task", pattern: "*", action: "allow" },
        { permission: "background_task", pattern: "*", action: "deny" },
      ],
      session: [
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "background_task", pattern: "*", action: "allow" },
      ],
      user: { read: false },
    })

    expect(keys(filtered)).toEqual([])
    expect(keys(input)).toEqual(["background_task", "read", "task"])
  })
})

describe("deprecated tools input", () => {
  test("rejects true before mutation and cannot re-enable background_task", async () => {
    await using tmp = await tmpdir({ git: true, init: (dir) => copy(dir, ["orchestrator"]) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const before = [{ permission: "read", pattern: "*", action: "deny" as const }]
        const session = await Session.create({ permission: before })
        await expect(
          SessionPrompt.prompt({
            sessionID: session.id,
            noReply: true,
            tools: { background_task: true },
            parts: [{ type: "text", text: "must fail before persistence" }],
          }),
        ).rejects.toThrow(SessionPrompt.DEPRECATED_TOOLS_ENABLE_ERROR)

        const current = await Session.get(session.id)
        expect(current.permission).toEqual(before)
        expect(await Session.messages({ sessionID: session.id })).toEqual([])

        const orchestrator = await Agent.get("orchestrator")
        expect(orchestrator).toBeDefined()
        const filtered = filterResolvedTools({
          tools: tools(["task", "background_task"]),
          agent: orchestrator!.permission,
          session: current.permission,
          user: { background_task: true },
        })
        expect(filtered.task).toBeDefined()
        expect(filtered.background_task).toBeUndefined()
      },
    })
  })

  test("preserves false as a persisted deny", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          noReply: true,
          tools: { background_task: false },
          parts: [{ type: "text", text: "disable background work" }],
        })
        expect((await Session.get(session.id)).permission).toEqual([
          { permission: "background_task", pattern: "*", action: "deny" },
        ])
      },
    })
  })

  test("malformed values fail schema validation", () => {
    expect(() =>
      SessionPrompt.prompt({
        sessionID: "ses_invalid",
        noReply: true,
        tools: { background_task: "yes" },
        parts: [],
      } as never),
    ).toThrow()
  })
})

describe("skill authorization order", () => {
  async function setup(dir: string) {
    await copy(dir, ["orchestrator"])
    const dest = path.join(dir, ".kilo", "skill", "blocked-skill")
    await fs.mkdir(dest, { recursive: true })
    await Bun.write(
      path.join(dest, "SKILL.md"),
      ["---", "name: blocked-skill", "description: A blocked skill.", "---", "", "blocked-secret-content"].join("\n"),
    )
  }

  test("denied requests call Skill.get zero times", async () => {
    await using tmp = await tmpdir({ git: true, init: setup })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const orchestrator = await Agent.get("orchestrator")
        expect(orchestrator).toBeDefined()
        const session = await Session.create({})
        const tool = await SkillTool.init({ agent: orchestrator! })
        const get = spyOn(Skill, "get")
        try {
          const err = await tool
            .execute(
              { name: "blocked-skill" },
              ctx({ session, agent: orchestrator!.name, ruleset: orchestrator!.permission }),
            )
            .then(
              () => undefined,
              (cause) => cause,
            )
          expect(err).toBeInstanceOf(Permission.DeniedError)
          expect(String(err)).not.toContain("blocked-secret-content")
          expect(get).toHaveBeenCalledTimes(0)
        } finally {
          get.mockRestore()
        }
      },
    })
  })

  test("allowed requests call Skill.get exactly once", async () => {
    await using tmp = await tmpdir({ git: true, init: setup })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const tool = await SkillTool.init()
        const get = spyOn(Skill, "get")
        try {
          const result = await tool.execute(
            { name: "blocked-skill" },
            ctx({
              session,
              agent: "synthetic",
              ruleset: [{ permission: "skill", pattern: "blocked-skill", action: "allow" }],
            }),
          )
          expect(get).toHaveBeenCalledTimes(1)
          expect(result.output).toContain("blocked-secret-content")
        } finally {
          get.mockRestore()
        }
      },
    })
  })

  test("unknown skills return a generic error without leaking names", async () => {
    await using tmp = await tmpdir({ git: true, init: setup })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const tool = await SkillTool.init()
        const get = spyOn(Skill, "get")
        try {
          const err = await tool
            .execute(
              { name: "missing-skill" },
              ctx({
                session,
                agent: "synthetic",
                ruleset: [{ permission: "skill", pattern: "*", action: "allow" }],
              }),
            )
            .then(
              () => undefined,
              (cause) => cause,
            )
          expect(err).toBeInstanceOf(Error)
          expect((err as Error).message).toBe("Skill not found or unavailable")
          expect((err as Error).message).not.toContain("blocked-skill")
          expect(get).toHaveBeenCalledTimes(1)
        } finally {
          get.mockRestore()
        }
      },
    })
  })
})

describe("background_task defense in depth", () => {
  test("real Orchestrator denial stops before task permission and start", async () => {
    await using tmp = await tmpdir({ git: true, init: (dir) => copy(dir, ["orchestrator"]) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const orchestrator = await Agent.get("orchestrator")
        expect(orchestrator).toBeDefined()
        const seeded = await seed(orchestrator!.name)
        const calls: Omit<Permission.Request, "id" | "sessionID" | "tool">[] = []
        const original = BackgroundSubagentControl.start
        const meter = { starts: 0 }
        BackgroundSubagentControl.start = async () => {
          meter.starts++
          throw new Error("background start must not be reached")
        }
        try {
          const tool = await BackgroundTaskTool.init()
          const promise = tool.execute(
            { action: "start", description: "audit", prompt: "read only", subagent_type: "explore" },
            ctx({
              session: seeded.session,
              messageID: seeded.assistant,
              agent: orchestrator!.name,
              ruleset: orchestrator!.permission,
              calls,
            }),
          )
          await expect(promise).rejects.toBeInstanceOf(Permission.DeniedError)
          expect(calls.map((call) => call.permission)).toEqual(["background_task"])
          expect(calls[0]).toEqual({
            permission: "background_task",
            patterns: ["explore"],
            always: ["*"],
            metadata: { description: "audit", action: "start" },
          })
          expect(meter.starts).toBe(0)
        } finally {
          BackgroundSubagentControl.start = original
        }
      },
    })
  })

  test("background allow reaches the subsequent task denial without starting", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const calls: Omit<Permission.Request, "id" | "sessionID" | "tool">[] = []
        const original = BackgroundSubagentControl.start
        const meter = { starts: 0 }
        BackgroundSubagentControl.start = async () => {
          meter.starts++
          throw new Error("background start must not be reached")
        }
        try {
          const tool = await BackgroundTaskTool.init()
          const promise = tool.execute(
            { action: "start", description: "audit", prompt: "read only", subagent_type: "explore" },
            ctx({
              session,
              agent: "synthetic",
              ruleset: [
                { permission: "background_task", pattern: "explore", action: "allow" },
                { permission: "task", pattern: "explore", action: "deny" },
              ],
              calls,
            }),
          )
          await expect(promise).rejects.toBeInstanceOf(Permission.DeniedError)
          expect(calls.map((call) => call.permission)).toEqual(["background_task", "task"])
          expect(meter.starts).toBe(0)
        } finally {
          BackgroundSubagentControl.start = original
        }
      },
    })
  })
})
