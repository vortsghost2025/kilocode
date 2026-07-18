// kilocode_change - new file
import { afterEach, describe, expect, test } from "bun:test"
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

async function seed(dir: string) {
  const session = await Session.create({})
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

        const catalog = Object.fromEntries(ids.map((id) => [id, { id }]))
        const resolved = filterResolvedTools({
          tools: catalog,
          agent: orchestrator!.permission,
        })

        expect(resolved.task).toBeDefined()
        expect(resolved.background_task).toBeUndefined()
        expect(resolved.edit).toBeUndefined()
        expect(resolved.write).toBeUndefined()

        const withSession = filterResolvedTools({
          tools: catalog,
          agent: orchestrator!.permission,
          session: [{ permission: "background_task", pattern: "*", action: "allow" }],
        })
        expect(withSession.background_task).toBeDefined()

        const withUserFalse = filterResolvedTools({
          tools: catalog,
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
        ).resolves.toBeUndefined()

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

  test("batch-allowed role with background_task-deny blocks nested call before tool.execute", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { experimental: { batch_tool: true, openTelemetry: true } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, msg } = await seed(tmp.path)

        const ruleset: Permission.Ruleset = [
          { permission: "batch", pattern: "*", action: "allow" },
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "background_task", pattern: "*", action: "deny" },
        ]

        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: msg,
          callID: "batch-enforce",
          agent: "test-agent",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          ...ToolAsk.build({
            sessionID: session.id,
            messageID: msg,
            callID: "batch-enforce",
            agent: ruleset,
            session: [],
          }),
        }

        const info = await BatchTool.init()
        const result = await info.execute(
          {
            tool_calls: [{ tool: "background_task", parameters: { action: "status", background_task_id: "ignored" } }],
          },
          ctx,
        )

        expect(result.metadata.failed).toBe(1)
        expect(result.metadata.successful).toBe(0)
        expect(result.metadata.details).toEqual([{ tool: "background_task", success: false }])
        expect(result.title).toContain("0/1")
      },
    })
  })

  test("debug ask fail-closed: deny and ask throw, only explicit allow passes", () => {
    const ruleset: Permission.Ruleset = [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
    ]

    const askRule = Permission.evaluate("bash", "test", ruleset)
    expect(askRule.action).toBe("ask")
    expect(() => {
      if (askRule.action !== "allow") throw new Permission.DeniedError({ ruleset })
    }).toThrow(Permission.DeniedError)

    const denyRule = Permission.evaluate("edit", "test", ruleset)
    expect(denyRule.action).toBe("deny")
    expect(() => {
      if (denyRule.action !== "allow") throw new Permission.DeniedError({ ruleset })
    }).toThrow(Permission.DeniedError)

    const allowRule = Permission.evaluate("read", "test", ruleset)
    expect(allowRule.action).toBe("allow")
    expect(() => {
      if (allowRule.action !== "allow") throw new Permission.DeniedError({ ruleset })
    }).not.toThrow()
  })
})
