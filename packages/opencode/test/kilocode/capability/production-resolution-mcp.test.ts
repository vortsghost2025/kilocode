// kilocode_change - new file
import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../../src/agent/agent"
import { MCPToolResolution } from "../../../src/kilocode/mcp-tool-resolution"
import { MCP } from "../../../src/mcp"
import { Permission } from "../../../src/permission"
import { Instance } from "../../../src/project/instance"
import { resetDatabase } from "../../fixture/db"
import { tmpdir } from "../../fixture/fixture"

const root = path.resolve(import.meta.dir, "../../../../..")

async function copy(dir: string) {
  const dest = path.join(dir, ".kilo", "agent")
  await fs.mkdir(dest, { recursive: true })
  await Bun.write(
    path.join(dest, "freeprobe.md"),
    await Bun.file(path.join(root, ".kilo", "agent", "freeprobe.md")).text(),
  )
}

function transport() {
  return {
    stderr: null,
    async start() {},
    async close() {},
  } as never
}

function client(list: () => void) {
  const state: { transport?: unknown } = {}
  return {
    get transport() {
      return state.transport
    },
    async connect(value: { start(): Promise<void> }) {
      state.transport = value
      await value.start()
    },
    async listTools() {
      list()
      return {
        tools: [
          {
            name: "search",
            description: "Synthetic search",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }
    },
    setNotificationHandler() {},
    async close() {},
  } as never
}

afterEach(async () => {
  await resetDatabase()
})

test("denied role resolves zero MCP tools without constructing runtime boundaries", async () => {
  await using tmp = await tmpdir({
    init: copy,
    config: {
      mcp: {
        local: { type: "local", command: ["never-run"] },
        remote: { type: "remote", url: "https://127.0.0.1:1" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("freeprobe")
      expect(agent).toBeDefined()

      const tools = spyOn(MCP, "tools")
      const client = spyOn(MCP.Boundary, "client").mockImplementation(() => {
        throw new Error("MCP client boundary must not initialize")
      })
      const stdio = spyOn(MCP.Boundary, "stdio").mockImplementation(() => {
        throw new Error("MCP stdio boundary must not initialize")
      })
      const stream = spyOn(MCP.Boundary, "stream").mockImplementation(() => {
        throw new Error("MCP HTTP boundary must not initialize")
      })
      const sse = spyOn(MCP.Boundary, "sse").mockImplementation(() => {
        throw new Error("MCP SSE boundary must not initialize")
      })
      try {
        const result = await MCPToolResolution.resolve(agent!.permission)
        expect(result).toEqual({})
        expect(tools).toHaveBeenCalledTimes(0)
        expect(client).toHaveBeenCalledTimes(0)
        expect(stdio).toHaveBeenCalledTimes(0)
        expect(stream).toHaveBeenCalledTimes(0)
        expect(sse).toHaveBeenCalledTimes(0)
      } finally {
        await Instance.dispose()
        tools.mockRestore()
        client.mockRestore()
        stdio.mockRestore()
        stream.mockRestore()
        sse.mockRestore()
      }
    },
  })
})

test("allowed synthetic role initializes actual MCP.tools boundary once", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: {
        synthetic: { type: "local", command: ["never-run"] },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset: Permission.Ruleset = [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "synthetic_search", pattern: "*", action: "allow" },
      ]
      const tools = spyOn(MCP, "tools")
      const stdio = spyOn(MCP.Boundary, "stdio").mockReturnValue(transport())
      const stream = spyOn(MCP.Boundary, "stream").mockImplementation(() => {
        throw new Error("Synthetic local server must not construct HTTP transport")
      })
      const sse = spyOn(MCP.Boundary, "sse").mockImplementation(() => {
        throw new Error("Synthetic local server must not construct SSE transport")
      })
      const counts = { list: 0 }
      const clients = spyOn(MCP.Boundary, "client").mockReturnValue(
        client(() => {
          counts.list++
        }),
      )
      try {
        const result = await MCPToolResolution.resolve(ruleset)
        expect(Object.keys(result)).toEqual(["synthetic_search"])
        expect(tools).toHaveBeenCalledTimes(1)
        expect(clients).toHaveBeenCalledTimes(1)
        expect(stdio).toHaveBeenCalledTimes(1)
        expect(stream).toHaveBeenCalledTimes(0)
        expect(sse).toHaveBeenCalledTimes(0)
        expect(counts.list).toBe(1)
      } finally {
        await Instance.dispose()
        tools.mockRestore()
        clients.mockRestore()
        stdio.mockRestore()
        stream.mockRestore()
        sse.mockRestore()
      }
    },
  })
})
