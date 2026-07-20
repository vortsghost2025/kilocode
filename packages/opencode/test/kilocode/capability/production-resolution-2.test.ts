// kilocode_change - new file
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../../src/agent/agent"
import { Permission } from "../../../src/permission"
import { Instance } from "../../../src/project/instance"
import { ModelID, ProviderID } from "../../../src/provider/schema"
import { Session } from "../../../src/session"
import { MessageV2 } from "../../../src/session/message-v2"
import { MessageID } from "../../../src/session/schema"
import { ToolRegistry } from "../../../src/tool/registry"
import { filterResolvedTools } from "../../../src/tool/resolve"
import { ToolAsk } from "../../../src/kilocode/permission/tool-ask"
import { BatchTool } from "../../../src/tool/batch"
import { BackgroundSubagentControl } from "../../../src/kilocode/background-subagent-control"
import { CapabilityAuthority } from "../../../src/kilocode/capability/authority"
import { Skill } from "../../../src/skill"
import { debugAsk } from "../../../src/cli/cmd/debug/agent"
import { BashProcess } from "../../../src/tool/bash"
import type { Tool } from "../../../src/tool/tool"
import { resetDatabase } from "../../fixture/db"
import { tmpdir } from "../../fixture/fixture"

const root = path.resolve(import.meta.dir, "../../../../..")
const names = ["orchestrator", "reviewer", "git-ops", "freeprobe"]

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

async function seed(dir: string, permission: Permission.Ruleset = []) {
  const session = await Session.create({ permission })
  const user = MessageID.ascending()
  const assistant = MessageID.ascending()
  await Session.updateMessage({
    id: user,
    role: "user",
    sessionID: session.id,
    agent: "test-agent",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    time: { created: Date.now() },
  })
  await Session.updateMessage({
    id: assistant,
    role: "assistant",
    parentID: user,
    sessionID: session.id,
    agent: "test-agent",
    mode: "test",
    path: { cwd: dir, root: dir },
    time: { created: Date.now() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
  })
  return { session, msg: assistant }
}

async function context(dir: string, ruleset: Permission.Ruleset) {
  const { session, msg } = await seed(dir, ruleset)
  const ctx: Tool.Context = {
    sessionID: session.id,
    messageID: msg,
    callID: "batch-bash",
    agent: "test-agent",
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    ...ToolAsk.build({
      sessionID: session.id,
      messageID: msg,
      callID: "batch-bash",
      agent: ruleset,
      session: [],
    }),
  }
  return { session, ctx }
}

function child() {
  return {
    stdout: { on() {} },
    stderr: { on() {} },
    once(event: string, callback: () => void) {
      if (event === "close") queueMicrotask(callback)
    },
    exitCode: 0,
  } as never
}

afterEach(async () => {
  await resetDatabase()
})

describe("phase 2E-A2 production resolution hardening", () => {
  test("resolves real catalog from ToolRegistry.tools through production filterResolvedTools", async () => {
    await using tmp = await tmpdir({ git: true, init: copy })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const orchestrator = await Agent.get("orchestrator")
        const role = await Agent.policy("orchestrator")
        expect(orchestrator).toBeDefined()

        const tools = await ToolRegistry.tools(
          { modelID: ModelID.make("test"), providerID: ProviderID.make("test") },
          orchestrator,
        )
        const ids = tools.map((t) => t.id)

        expect(ids).toContain("read")
        expect(ids).toContain("grep")
        expect(ids).toContain("glob")
        expect(ids).toContain("bash")
        expect(ids).toContain("edit")
        expect(ids).toContain("write")
        expect(ids).toContain("task")
        expect(ids).toContain("background_task")

        const catalog = Object.fromEntries(tools.map((tool) => [tool.id, tool]))
        const resolved = filterResolvedTools({
          tools: catalog,
          role,
          agent: orchestrator!.permission,
        })

        expect(resolved.task).toBeDefined()
        expect(resolved.background_task).toBeUndefined()
        expect(resolved.edit).toBeDefined()
        expect(resolved.write).toBeUndefined()
        expect(
          CapabilityAuthority.evaluate({
            permission: "edit",
            pattern: ".planning/STATE.md",
            role,
            agent: orchestrator!.permission,
          }).action,
        ).toBe("allow")
        expect(
          CapabilityAuthority.evaluate({
            permission: "edit",
            pattern: "src/index.ts",
            role,
            agent: orchestrator!.permission,
          }).action,
        ).toBe("deny")

        const withSession = filterResolvedTools({
          tools: catalog,
          role,
          agent: orchestrator!.permission,
          session: [{ permission: "background_task", pattern: "*", action: "allow" }],
        })
        expect(withSession.background_task).toBeUndefined()

        const withUserFalse = filterResolvedTools({
          tools: catalog,
          role,
          agent: orchestrator!.permission,
          user: { task: false },
        })
        expect(withUserFalse.task).toBeUndefined()
      },
    })
  })

  test("ToolAsk.build exercises the exact production agent+session merge path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, msg } = await seed(tmp.path)

        const agentRules: Permission.Ruleset = [
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "background_task", pattern: "*", action: "deny" },
          { permission: "task", pattern: "*", action: "allow" },
        ]

        const { ask } = ToolAsk.build({
          sessionID: session.id,
          messageID: msg,
          callID: "merge-test-1",
          agent: agentRules,
          session: [],
        })

        await expect(
          ask({ permission: "background_task", patterns: ["explore"], always: ["*"], metadata: {} }),
        ).rejects.toBeInstanceOf(Permission.DeniedError)

        await expect(ask({ permission: "read", patterns: ["*"], always: ["*"], metadata: {} })).resolves.toBeUndefined()

        const { ask: askOverride } = ToolAsk.build({
          sessionID: session.id,
          messageID: msg,
          callID: "merge-test-2",
          agent: agentRules,
          session: [{ permission: "background_task", pattern: "explore", action: "allow" }],
        })
        await expect(
          askOverride({ permission: "background_task", patterns: ["explore"], always: ["*"], metadata: {} }),
        ).rejects.toBeInstanceOf(Permission.DeniedError)

        const { ask: askDenyOverride } = ToolAsk.build({
          sessionID: session.id,
          messageID: msg,
          callID: "merge-test-3",
          agent: agentRules,
          session: [{ permission: "read", pattern: "*", action: "deny" }],
        })
        await expect(
          askDenyOverride({ permission: "read", patterns: ["*"], always: ["*"], metadata: {} }),
        ).rejects.toBeInstanceOf(Permission.DeniedError)
      },
    })
  })

  async function skillSetup(dir: string) {
    const dest = path.join(dir, ".kilo", "skill", "blocked-skill")
    await fs.mkdir(dest, { recursive: true })
    await Bun.write(
      path.join(dest, "SKILL.md"),
      ["---", "name: blocked-skill", "description: A blocked skill.", "---", "", "blocked-secret-content"].join("\n"),
    )
  }

  test("batch background_task denied at catalog level blocks before tool.execute", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { experimental: { batch_tool: true, openTelemetry: true } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ruleset: Permission.Ruleset = [{ permission: "background_task", pattern: "*", action: "deny" }]
        const session = await Session.create({ permission: ruleset })
        const user = MessageID.ascending()
        const assistant = MessageID.ascending()
        await Session.updateMessage({
          id: user,
          role: "user",
          sessionID: session.id,
          agent: "test-agent",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          time: { created: Date.now() },
        })
        await Session.updateMessage({
          id: assistant,
          role: "assistant",
          parentID: user,
          sessionID: session.id,
          agent: "test-agent",
          mode: "test",
          path: { cwd: tmp.path, root: tmp.path },
          time: { created: Date.now() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
        })

        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: assistant,
          callID: "batch-enforce",
          agent: "test-agent",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          ...ToolAsk.build({
            sessionID: session.id,
            messageID: assistant,
            callID: "batch-enforce",
            agent: ruleset,
            session: [],
          }),
        }

        const status = spyOn(BackgroundSubagentControl, "status")
        try {
          const info = await BatchTool.init()
          const result = await info.execute(
            {
              tool_calls: [
                { tool: "background_task", parameters: { action: "status", background_task_id: "ignored" } },
              ],
            },
            ctx,
          )
          expect(result.metadata.failed).toBe(1)
          expect(result.metadata.successful).toBe(0)
          expect(result.metadata.details).toEqual([{ tool: "background_task", success: false }])
          expect(result.title).toContain("0/1")
          expect(status).toHaveBeenCalledTimes(0)
        } finally {
          status.mockRestore()
        }
      },
    })
  })

  test("batch skill allowed at catalog level reaches Skill.get", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { experimental: { batch_tool: true, openTelemetry: true } },
      init: skillSetup,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ruleset: Permission.Ruleset = [{ permission: "skill", pattern: "*", action: "allow" }]
        const session = await Session.create({ permission: ruleset })
        const user = MessageID.ascending()
        const assistant = MessageID.ascending()
        await Session.updateMessage({
          id: user,
          role: "user",
          sessionID: session.id,
          agent: "test-agent",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          time: { created: Date.now() },
        })
        await Session.updateMessage({
          id: assistant,
          role: "assistant",
          parentID: user,
          sessionID: session.id,
          agent: "test-agent",
          mode: "test",
          path: { cwd: tmp.path, root: tmp.path },
          time: { created: Date.now() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
        })

        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: assistant,
          callID: "batch-enforce",
          agent: "test-agent",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          ...ToolAsk.build({
            sessionID: session.id,
            messageID: assistant,
            callID: "batch-enforce",
            agent: ruleset,
            session: [],
          }),
        }

        const get = spyOn(Skill, "get")
        try {
          const info = await BatchTool.init()
          const result = await info.execute(
            { tool_calls: [{ tool: "skill", parameters: { name: "blocked-skill" } }] },
            ctx,
          )
          expect(result.metadata.successful).toBe(1)
          expect(result.metadata.failed).toBe(0)
          expect(get).toHaveBeenCalledTimes(1)
        } finally {
          get.mockRestore()
        }
      },
    })
  })

  test("batch skill denied at catalog level blocks before Skill.get", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { experimental: { batch_tool: true, openTelemetry: true } },
      init: skillSetup,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ruleset: Permission.Ruleset = [{ permission: "skill", pattern: "*", action: "deny" }]
        const session = await Session.create({ permission: ruleset })
        const user = MessageID.ascending()
        const assistant = MessageID.ascending()
        await Session.updateMessage({
          id: user,
          role: "user",
          sessionID: session.id,
          agent: "test-agent",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          time: { created: Date.now() },
        })
        await Session.updateMessage({
          id: assistant,
          role: "assistant",
          parentID: user,
          sessionID: session.id,
          agent: "test-agent",
          mode: "test",
          path: { cwd: tmp.path, root: tmp.path },
          time: { created: Date.now() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
        })

        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: assistant,
          callID: "batch-enforce",
          agent: "test-agent",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          ...ToolAsk.build({
            sessionID: session.id,
            messageID: assistant,
            callID: "batch-enforce",
            agent: ruleset,
            session: [],
          }),
        }

        const get = spyOn(Skill, "get")
        try {
          const info = await BatchTool.init()
          const result = await info.execute(
            { tool_calls: [{ tool: "skill", parameters: { name: "blocked-skill" } }] },
            ctx,
          )
          expect(result.metadata.failed).toBe(1)
          expect(result.metadata.successful).toBe(0)
          expect(get).toHaveBeenCalledTimes(0)
        } finally {
          get.mockRestore()
        }
      },
    })
  })

  test("batch bash allows git status through the process boundary", async () => {
    await using tmp = await tmpdir({
      config: { experimental: { batch_tool: true, openTelemetry: true } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ruleset: Permission.Ruleset = [
          { permission: "bash", pattern: "*", action: "deny" },
          { permission: "bash", pattern: "git status", action: "allow" },
          { permission: "batch", pattern: "*", action: "allow" },
        ]
        const input = await context(tmp.path, ruleset)
        const spawn = spyOn(BashProcess, "spawn").mockReturnValue(child())
        try {
          const info = await BatchTool.init()
          const result = await info.execute(
            {
              tool_calls: [{ tool: "bash", parameters: { command: "git status", description: "Check git status" } }],
            },
            input.ctx,
          )
          expect(result.metadata.successful).toBe(1)
          expect(result.metadata.failed).toBe(0)
          expect(spawn).toHaveBeenCalledTimes(1)
        } finally {
          spawn.mockRestore()
        }
      },
    })
  })

  test("batch bash denies npm install before the process boundary", async () => {
    await using tmp = await tmpdir({
      config: { experimental: { batch_tool: true, openTelemetry: true } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ruleset: Permission.Ruleset = [
          { permission: "bash", pattern: "*", action: "deny" },
          { permission: "bash", pattern: "git status", action: "allow" },
          { permission: "batch", pattern: "*", action: "allow" },
        ]
        const input = await context(tmp.path, ruleset)
        const spawn = spyOn(BashProcess, "spawn").mockReturnValue(child())
        try {
          const info = await BatchTool.init()
          const result = await info.execute(
            {
              tool_calls: [{ tool: "bash", parameters: { command: "npm install", description: "Install packages" } }],
            },
            input.ctx,
          )
          expect(result.metadata.failed).toBe(1)
          expect(result.metadata.successful).toBe(0)
          expect(spawn).toHaveBeenCalledTimes(0)

          const message = await MessageV2.get({
            sessionID: input.session.id,
            messageID: input.ctx.messageID,
          })
          const part = message.parts.findLast((item) => item.type === "tool" && item.tool === "bash")
          expect(part?.type).toBe("tool")
          if (part?.type !== "tool") throw new Error("Missing nested Bash tool part")
          expect(part.state.status).toBe("error")
          if (part.state.status !== "error") throw new Error("Nested Bash tool did not fail")
          expect(part.state.error).toContain("prevents you from using this specific tool call")
        } finally {
          spawn.mockRestore()
        }
      },
    })
  })

  test("debugAsk fail-closed against production Permission.evaluate", async () => {
    const ruleset: Permission.Ruleset = [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
    ]

    await expect(
      debugAsk({ permission: "bash", patterns: ["test"], always: ["*"], metadata: {} }, ruleset),
    ).rejects.toBeInstanceOf(Permission.DeniedError)

    await expect(
      debugAsk({ permission: "edit", patterns: ["test"], always: ["*"], metadata: {} }, ruleset),
    ).rejects.toBeInstanceOf(Permission.DeniedError)

    await expect(
      debugAsk({ permission: "read", patterns: ["test"], always: ["*"], metadata: {} }, ruleset),
    ).resolves.toBeUndefined()
  })
})
