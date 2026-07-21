// kilocode_change - new file
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import z from "zod"
import { DelegateEditTool } from "../../src/kilocode/delegate-edit-tool"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageID, type SessionID } from "../../src/session/schema"
import { SessionPrompt } from "../../src/session/prompt"
import { TaskTool } from "../../src/tool/task"
import type { Tool } from "../../src/tool/tool"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const model = { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") }

function config() {
  return {
    experimental: { openTelemetry: false },
    agent: {
      orchestrator: { mode: "primary" as const, permission: { "*": "allow" as const } },
      code: { mode: "primary" as const, permission: { "*": "allow" as const } },
      "command-check": { mode: "subagent" as const, permission: { "*": "allow" as const } },
      "phase2f-implementer": {
        mode: "subagent" as const,
        permission: { "*": "deny" as const, read: "allow" as const, edit: "allow" as const },
      },
    },
  }
}

async function seed(agent = "orchestrator") {
  const session = await Session.create({})
  const user = MessageID.ascending()
  const assistant = MessageID.ascending()
  await Session.updateMessage({
    id: user,
    role: "user",
    sessionID: session.id,
    agent,
    model,
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
    modelID: model.modelID,
    providerID: model.providerID,
  })
  return { session, assistant }
}

function ctx(sessionID: SessionID, messageID: MessageID, agent = "orchestrator", call = agent): Tool.Context {
  return {
    sessionID,
    messageID,
    callID: `task-${call}`,
    agent,
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
    extra: {},
  }
}

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("TaskTool public schema", () => {
  test("parses Command-Check without authorization or optional metadata", async () => {
    await using tmp = await tmpdir({ git: true, config: config() })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TaskTool.init()
        expect(
          tool.parameters.safeParse({
            description: "validate wave",
            prompt: "Run focused validation",
            subagent_type: "command-check",
          }).success,
        ).toBe(true)
      },
    })
  })

  test("generated JSON schema has an authorization-free call variant", async () => {
    await using tmp = await tmpdir({ git: true, config: config() })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TaskTool.init()
        const schema = z.toJSONSchema(tool.parameters)
        const variants = "anyOf" in schema && Array.isArray(schema.anyOf) ? schema.anyOf : []
        const minimal = variants.find((item) => {
          if (typeof item !== "object" || item === null || !("required" in item)) return false
          return JSON.stringify(item.required) === JSON.stringify(["description", "prompt", "subagent_type"])
        })
        expect(schema.type).toBe("object")
        expect(schema.required ?? []).not.toContain("authorization")
        expect(minimal).toBeDefined()
        expect(minimal).not.toHaveProperty("properties.authorization")
        expect(JSON.stringify(schema)).not.toContain("phase2f-implementer")
      },
    })
  })

  test("delegate_edit exposes one flat required contract", async () => {
    const tool = await DelegateEditTool.init()
    const schema = z.toJSONSchema(tool.parameters)
    expect(schema.required).toEqual(["description", "prompt", "operation", "path"])
    expect(schema.properties?.operation).toMatchObject({ enum: ["edit", "populate"] })
    expect(schema.properties?.path).toMatchObject({ type: "string", minLength: 1 })
    expect(schema.properties).not.toHaveProperty("authorization")
    expect(schema.properties).not.toHaveProperty("task_id")
  })
})

describe("TaskTool authorization runtime", () => {
  test("runs a non-Phase2F task without authorization", async () => {
    await using tmp = await tmpdir({ git: true, config: config() })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await seed()
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({
          info: { role: "assistant" },
          parts: [{ type: "text", text: "validated" }],
        } as never)
        try {
          const tool = await TaskTool.init()
          const result = await tool.execute(
            {
              description: "validate wave",
              prompt: "Run focused validation",
              subagent_type: "command-check",
            },
            ctx(root.session.id, root.assistant),
          )
          expect(result.output).toContain("validated")
        } finally {
          prompt.mockRestore()
        }
      },
    })
  })

  test("generic task rejects the retired authorization argument", async () => {
    await using tmp = await tmpdir({ git: true, config: config() })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await seed()
        const tool = await TaskTool.init()
        await expect(
          tool.execute(
            {
              description: "invalid grant",
              prompt: "Run focused validation",
              subagent_type: "command-check",
              authorization: { operation: "edit", path: "target.ts" },
            } as never,
            ctx(root.session.id, root.assistant),
          ),
        ).rejects.toThrow('Unrecognized key: \\"authorization\\"')
      },
    })
  })

  test("rejects Phase2F without authorization", async () => {
    await using tmp = await tmpdir({ git: true, config: config() })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await seed()
        const tool = await TaskTool.init()
        await expect(
          tool.execute(
            {
              description: "missing grant",
              prompt: "Edit the target",
              subagent_type: "phase2f-implementer",
            },
            ctx(root.session.id, root.assistant),
          ),
        ).rejects.toThrow("DELEGATED_EDIT_AUTHORIZATION_INVALID")
      },
    })
  })

  test("delegate_edit requires Orchestrator and an existing exact path", async () => {
    await using tmp = await tmpdir({ git: true, config: config() })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const other = await seed("code")
        const tool = await DelegateEditTool.init()
        const input = {
          description: "edit target",
          prompt: "Edit the target",
          operation: "edit" as const,
          path: "target.ts",
        }
        await expect(tool.execute(input, ctx(other.session.id, other.assistant, "code"))).rejects.toThrow(
          "only Orchestrator may authorize Phase2F implementation tasks",
        )

        const root = await seed()
        await expect(
          tool.execute(input, ctx(root.session.id, root.assistant, "orchestrator", "missing")),
        ).rejects.toThrow("reason: target must already exist")
      },
    })
  })

  test("missing or malformed delegation launches no worker request", async () => {
    await using tmp = await tmpdir({ git: true, config: config() })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await seed()
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({
          info: { role: "assistant" },
          parts: [{ type: "text", text: "unexpected" }],
        } as never)
        try {
          const tool = await DelegateEditTool.init()
          const context = ctx(root.session.id, root.assistant)
          await expect(
            tool.execute({ description: "missing path", prompt: "Edit target", operation: "edit" } as never, context),
          ).rejects.toThrow("DELEGATED_EDIT_AUTHORIZATION_INVALID")
          await expect(
            tool.execute(
              { description: "bad operation", prompt: "Edit target", operation: "write", path: "target.ts" } as never,
              context,
            ),
          ).rejects.toThrow("DELEGATED_EDIT_AUTHORIZATION_INVALID")
          expect(prompt).toHaveBeenCalledTimes(0)
          expect(await Session.children(root.session.id)).toHaveLength(0)
        } finally {
          prompt.mockRestore()
        }
      },
    })
  })
})
