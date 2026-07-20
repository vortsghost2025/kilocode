// kilocode_change - new file
import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../../src/agent/agent"
import type { Config } from "../../../src/config/config"
import { MCPToolResolution } from "../../../src/kilocode/mcp-tool-resolution"
import { MCP } from "../../../src/mcp"
import { Permission } from "../../../src/permission"
import { Instance } from "../../../src/project/instance"
import { Provider } from "../../../src/provider/provider"
import { ModelID, ProviderID } from "../../../src/provider/schema"
import { Session } from "../../../src/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { MessageID } from "../../../src/session/schema"
import { resetDatabase } from "../../fixture/db"
import { tmpdir } from "../../fixture/fixture"

const root = path.resolve(import.meta.dir, "../../../../..")
const single = {
  synthetic: { type: "local", command: ["synthetic-never-run"] },
} satisfies NonNullable<Config.Info["mcp"]>
const mixed = {
  ...single,
  blocked: { type: "local", command: ["blocked-never-run"] },
  remote: { type: "remote", url: "https://127.0.0.1:1" },
} satisfies NonNullable<Config.Info["mcp"]>
const blocked = {
  "blocked-local": { type: "local", command: ["blocked-local-never-run"] },
  "blocked-remote": { type: "remote", url: "https://127.0.0.1:1" },
} satisfies NonNullable<Config.Info["mcp"]>

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

function client(list: () => void | Promise<void>, close = () => {}, tool = "search") {
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
      await list()
      return {
        tools: [
          {
            name: tool,
            description: "Synthetic search",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }
    },
    setNotificationHandler() {},
    async close() {
      close()
    },
  } as never
}

function signal() {
  const state: { resolve?: () => void } = {}
  const promise = new Promise<void>((resolve) => {
    state.resolve = resolve
  })
  return {
    promise,
    resolve() {
      state.resolve?.()
    },
  }
}

function model(): Provider.Model {
  return {
    id: ModelID.make("test-model"),
    providerID: ProviderID.make("test-provider"),
    api: { id: "test-model", url: "http://127.0.0.1", npm: "@ai-sdk/anthropic" },
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

function boundaries() {
  const calls = {
    list: 0,
    stdio: [] as string[],
    http: [] as string[],
    sse: [] as string[],
  }
  const all = spyOn(MCP, "tools")
  const scoped = spyOn(MCP, "toolsForServers")
  const clients = spyOn(MCP.Boundary, "client").mockImplementation(() =>
    client(() => {
      calls.list++
    }),
  )
  const stdio = spyOn(MCP.Boundary, "stdio").mockImplementation((options) => {
    calls.stdio.push(options.command)
    return transport()
  })
  const stream = spyOn(MCP.Boundary, "stream").mockImplementation((url) => {
    calls.http.push(url.toString())
    return transport()
  })
  const sse = spyOn(MCP.Boundary, "sse").mockImplementation((url) => {
    calls.sse.push(url.toString())
    return transport()
  })
  return {
    calls,
    all,
    scoped,
    clients,
    stdio,
    stream,
    sse,
    restore() {
      all.mockRestore()
      scoped.mockRestore()
      clients.mockRestore()
      stdio.mockRestore()
      stream.mockRestore()
      sse.mockRestore()
    },
  }
}

function controls(input: { list(index: number): void | Promise<void>; tool?(index: number): string }) {
  const calls = {
    clients: 0,
    list: 0,
    stdio: [] as string[],
    closed: [] as number[],
  }
  const lifecycle = spyOn(MCP.Boundary, "lifecycle")
  const preinstall = spyOn(MCP.Boundary, "preinstall")
  const clients = spyOn(MCP.Boundary, "client").mockImplementation(() => {
    const index = calls.clients++
    calls.closed[index] = 0
    return client(
      async () => {
        calls.list++
        await input.list(index)
      },
      () => {
        calls.closed[index]++
      },
      input.tool?.(index) ?? "search",
    )
  })
  const stdio = spyOn(MCP.Boundary, "stdio").mockImplementation((options) => {
    calls.stdio.push(options.command)
    return transport()
  })
  const stream = spyOn(MCP.Boundary, "stream").mockImplementation(() => transport())
  const sse = spyOn(MCP.Boundary, "sse").mockImplementation(() => transport())
  return {
    calls,
    lifecycle,
    preinstall,
    clients,
    stdio,
    stream,
    sse,
    restore() {
      lifecycle.mockRestore()
      preinstall.mockRestore()
      clients.mockRestore()
      stdio.mockRestore()
      stream.mockRestore()
      sse.mockRestore()
    },
  }
}

afterEach(async () => {
  await resetDatabase()
})

test("missing explicit MCP grant resolves no server or tool", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: single,
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const boundary = boundaries()
      try {
        expect(await MCPToolResolution.isolate(single, () => MCPToolResolution.servers([]))).toEqual([])
        expect(await MCPToolResolution.isolate(single, () => MCPToolResolution.resolve([]))).toEqual({})
        expect(boundary.scoped).toHaveBeenCalledTimes(0)
        expect(boundary.clients).toHaveBeenCalledTimes(0)
        expect(boundary.calls.stdio).toEqual([])
      } finally {
        await Instance.dispose()
        boundary.restore()
      }
    },
  })
})

test("session ask narrows an explicit MCP allow before server construction", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: single,
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset: Permission.Ruleset = [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "synthetic_search", pattern: "*", action: "allow" },
        { permission: "synthetic_write", pattern: "*", action: "deny" },
      ]
      const narrow: Permission.Ruleset = [{ permission: "synthetic_search", pattern: "*", action: "ask" }]
      const boundary = boundaries()
      try {
        expect(await MCPToolResolution.isolate(single, () => MCPToolResolution.resolve(ruleset, narrow))).toEqual({})
        expect(boundary.scoped).toHaveBeenCalledTimes(0)
        expect(boundary.clients).toHaveBeenCalledTimes(0)
        expect(boundary.calls.stdio).toEqual([])
      } finally {
        await Instance.dispose()
        boundary.restore()
      }
    },
  })
})

test("all denied namespaces resolve zero MCP tools without runtime construction", async () => {
  await using tmp = await tmpdir({
    init: copy,
    config: {
      mcp: blocked,
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("freeprobe")
      expect(agent).toBeDefined()

      const boundary = boundaries()
      try {
        const result = await MCPToolResolution.isolate(blocked, () => MCPToolResolution.resolve(agent!.permission))
        expect(result).toEqual({})
        expect(boundary.all).toHaveBeenCalledTimes(0)
        expect(boundary.scoped).toHaveBeenCalledTimes(0)
        expect(boundary.clients).toHaveBeenCalledTimes(0)
        expect(boundary.calls.stdio).toEqual([])
        expect(boundary.calls.http).toEqual([])
        expect(boundary.calls.sse).toEqual([])
        expect(boundary.calls.list).toBe(0)
      } finally {
        await Instance.dispose()
        boundary.restore()
      }
    },
  })
})

test("mixed configuration initializes only the allowed synthetic server", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: mixed,
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset: Permission.Ruleset = [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "synthetic_search", pattern: "*", action: "allow" },
        { permission: "synthetic_write", pattern: "*", action: "deny" },
      ]
      const boundary = boundaries()
      try {
        const result = await MCPToolResolution.isolate(mixed, () => MCPToolResolution.resolve(ruleset))
        expect(Object.keys(result)).toEqual(["synthetic_search"])
        expect(boundary.all).toHaveBeenCalledTimes(0)
        expect(boundary.scoped).toHaveBeenCalledTimes(1)
        expect(boundary.scoped).toHaveBeenCalledWith(["synthetic"])
        expect(boundary.clients).toHaveBeenCalledTimes(1)
        expect(boundary.calls.stdio).toEqual(["synthetic-never-run"])
        expect(boundary.calls.stdio.filter((command) => command === "blocked-never-run")).toHaveLength(0)
        expect(boundary.calls.http).toEqual([])
        expect(boundary.calls.sse).toEqual([])
        expect(boundary.calls.list).toBe(1)
        expect(await MCP.inspect("context7")).toEqual({ client: false, defs: false, ready: false })
        expect(await MCP.inspect("memory")).toEqual({ client: false, defs: false, ready: false })
      } finally {
        await Instance.dispose()
        boundary.restore()
      }
    },
  })
})

test("parameter-specific MCP allowance stays unavailable without argument enforcement", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: mixed,
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset: Permission.Ruleset = [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "synthetic_search", pattern: "safe-query", action: "allow" },
      ]
      const boundary = boundaries()
      try {
        const result = await MCPToolResolution.isolate(mixed, () => MCPToolResolution.resolve(ruleset))
        expect(result).toEqual({})
        expect(boundary.scoped).toHaveBeenCalledTimes(0)
        expect(boundary.clients).toHaveBeenCalledTimes(0)
        expect(boundary.calls.stdio).toEqual([])
        expect(boundary.calls.http).toEqual([])
        expect(boundary.calls.sse).toEqual([])
        expect(boundary.calls.list).toBe(0)
      } finally {
        await Instance.dispose()
        boundary.restore()
      }
    },
  })
})

test("later equivalent deny supersedes an earlier parameter-specific allow", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: single,
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset: Permission.Ruleset = [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "synthetic_search", pattern: "*", action: "allow" },
        { permission: "synthetic_search", pattern: "*", action: "deny" },
      ]
      const boundary = boundaries()
      try {
        expect(await MCPToolResolution.isolate(single, () => MCPToolResolution.servers(ruleset))).toEqual([])
        expect(await MCPToolResolution.isolate(single, () => MCPToolResolution.resolve(ruleset))).toEqual({})
        expect(boundary.scoped).toHaveBeenCalledTimes(0)
        expect(boundary.clients).toHaveBeenCalledTimes(0)
        expect(boundary.calls.stdio).toEqual([])
        expect(boundary.calls.list).toBe(0)
      } finally {
        await Instance.dispose()
        boundary.restore()
      }
    },
  })
})

test("question wildcard permission selects only the overlapping server namespace", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: mixed,
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset: Permission.Ruleset = [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "synthetic?search", pattern: "*", action: "allow" },
      ]
      const boundary = boundaries()
      try {
        expect(await MCPToolResolution.isolate(mixed, () => MCPToolResolution.servers(ruleset))).toEqual(["synthetic"])
        expect(Object.keys(await MCPToolResolution.isolate(mixed, () => MCPToolResolution.resolve(ruleset)))).toEqual([
          "synthetic_search",
        ])
        expect(boundary.scoped).toHaveBeenCalledWith(["synthetic"])
        expect(boundary.calls.stdio).toEqual(["synthetic-never-run"])
        expect(boundary.calls.stdio).not.toContain("blocked-never-run")
        expect(boundary.calls.http).toEqual([])
        expect(boundary.calls.sse).toEqual([])
        expect(boundary.calls.list).toBe(1)
      } finally {
        await Instance.dispose()
        boundary.restore()
      }
    },
  })
})

test("SessionPrompt production path merges agent and session MCP permissions", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: mixed,
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent: Agent.Info = {
        name: "synthetic",
        mode: "primary",
        options: {},
        permission: [
          { permission: "*", pattern: "*", action: "deny" },
          { permission: "synthetic_search", pattern: "*", action: "allow" },
        ],
      }
      const session = await Session.create({
        permission: [{ permission: "blocked_search", pattern: "*", action: "allow" }],
      })
      const boundary = boundaries()
      try {
        const result = await MCPToolResolution.isolate(mixed, () =>
          SessionPrompt.resolveTools({
            agent,
            session,
            model: model(),
            processor: {
              message: { id: MessageID.ascending() },
              partFromToolCall() {},
            } as never,
            bypassAgentCheck: false,
            messages: [],
          }),
        )
        expect(result.synthetic_search).toBeDefined()
        expect(result.blocked_search).toBeUndefined()
        expect(result.remote_search).toBeUndefined()
        expect(boundary.scoped).toHaveBeenCalledWith(["synthetic"])
        expect(boundary.clients).toHaveBeenCalledTimes(1)
        expect(boundary.calls.stdio).toEqual(["synthetic-never-run"])
        expect(boundary.calls.stdio).not.toContain("blocked-never-run")
        expect(boundary.calls.http).toEqual([])
        expect(boundary.calls.sse).toEqual([])
        expect(boundary.calls.list).toBe(1)
      } finally {
        await Instance.dispose()
        boundary.restore()
      }
    },
  })
})

test("SessionPrompt removes session-granted MCP tools behind a static deny before serialization", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: single,
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent: Agent.Info = {
        name: "synthetic",
        mode: "primary",
        options: {},
        permission: [{ permission: "synthetic_search", pattern: "*", action: "deny" }],
      }
      const session = await Session.create({
        permission: [{ permission: "synthetic_search", pattern: "*", action: "allow" }],
      })
      const boundary = boundaries()
      try {
        const result = await MCPToolResolution.isolate(single, () =>
          SessionPrompt.resolveTools({
            agent,
            session,
            model: model(),
            processor: {
              message: { id: MessageID.ascending() },
              partFromToolCall() {},
            } as never,
            bypassAgentCheck: false,
            messages: [],
          }),
        )
        expect(result.synthetic_search).toBeUndefined()
        expect(boundary.scoped).toHaveBeenCalledTimes(0)
        expect(boundary.clients).toHaveBeenCalledTimes(0)
        expect(boundary.calls.stdio).toEqual([])
      } finally {
        await Instance.dispose()
        boundary.restore()
      }
    },
  })
})

test("concurrent scoped resolution initializes one cached client", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: {
        synthetic: { type: "local", command: ["synthetic-never-run"] },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const entered = signal()
      const release = signal()
      const control = controls({
        async list() {
          entered.resolve()
          await release.promise
        },
      })
      const cleanup = { disposed: false }
      try {
        const pending = Array.from({ length: 4 }, () => MCP.toolsForServers(["synthetic"]))
        await entered.promise
        release.resolve()
        const results = await Promise.all(pending)
        expect(results.map((result) => Object.keys(result))).toEqual([
          ["synthetic_search"],
          ["synthetic_search"],
          ["synthetic_search"],
          ["synthetic_search"],
        ])
        expect(control.calls.stdio).toEqual(["synthetic-never-run"])
        expect(control.calls.clients).toBe(1)
        expect(control.calls.list).toBe(1)
        expect(control.calls.closed).toEqual([0])
        await Instance.dispose()
        cleanup.disposed = true
        expect(control.calls.closed).toEqual([1])
      } finally {
        if (!cleanup.disposed) await Instance.dispose()
        control.restore()
      }
    },
  })
})

test("disconnect invoked during initialization wins without leaking the client", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: {
        synthetic: { type: "local", command: ["synthetic-never-run"] },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const entered = signal()
      const release = signal()
      const queued = signal()
      const control = controls({
        async list() {
          entered.resolve()
          await release.promise
        },
      })
      control.lifecycle.mockImplementation((name, operation) => {
        if (name === "synthetic" && operation === "disconnect") queued.resolve()
      })
      try {
        const resolving = MCP.toolsForServers(["synthetic"])
        await entered.promise
        const disconnecting = MCP.disconnect("synthetic")
        await queued.promise
        release.resolve()
        await Promise.all([resolving, disconnecting])

        expect((await MCP.status()).synthetic?.status).toBe("disabled")
        expect((await MCP.clients()).synthetic).toBeUndefined()
        expect(await MCP.toolsForServers(["synthetic"])).toEqual({})
        expect(control.calls.stdio).toEqual(["synthetic-never-run"])
        expect(control.calls.clients).toBe(1)
        expect(control.calls.list).toBe(1)
        expect(control.calls.closed).toEqual([1])
      } finally {
        await Instance.dispose()
        control.restore()
      }
    },
  })
})

test("add invoked during initialization serializes replacement and closes the displaced client", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: {
        synthetic: { type: "local", command: ["synthetic-never-run"] },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const entered = signal()
      const release = signal()
      const queued = signal()
      const control = controls({
        async list(index) {
          if (index !== 0) return
          entered.resolve()
          await release.promise
        },
        tool(index) {
          return index === 0 ? "initial" : "replacement"
        },
      })
      control.lifecycle.mockImplementation((name, operation) => {
        if (name === "synthetic" && operation === "store") queued.resolve()
      })
      const cleanup = { disposed: false }
      try {
        const resolving = MCP.toolsForServers(["synthetic"])
        await entered.promise
        const adding = MCP.add("synthetic", { type: "local", command: ["replacement-never-run"] })
        await queued.promise
        release.resolve()
        await Promise.all([resolving, adding])

        expect(Object.keys(await MCP.toolsForServers(["synthetic"]))).toEqual(["synthetic_replacement"])
        expect(control.calls.stdio).toEqual(["synthetic-never-run", "replacement-never-run"])
        expect(control.calls.clients).toBe(2)
        expect(control.calls.list).toBe(2)
        expect(control.calls.closed).toEqual([1, 0])
        expect(Object.keys(await MCP.clients())).toEqual(["synthetic"])
        expect(control.calls.clients - control.calls.closed.reduce((sum, count) => sum + count, 0)).toBe(1)

        await Instance.dispose()
        cleanup.disposed = true
        expect(control.calls.closed).toEqual([1, 1])
      } finally {
        if (!cleanup.disposed) await Instance.dispose()
        control.restore()
      }
    },
  })
})

test("interruption during listTools closes the uninstalled client and permits retry", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: {
        synthetic: { type: "local", command: ["synthetic-never-run"] },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const entered = signal()
      const release = signal()
      const control = controls({
        async list(index) {
          if (index !== 0) return
          entered.resolve()
          await release.promise
        },
      })
      const abort = new AbortController()
      const cleanup = { disposed: false }
      try {
        const pending = MCP.toolsForServers(["synthetic"], { signal: abort.signal })
        const stopped = pending.then(
          () => false,
          () => true,
        )
        await entered.promise
        abort.abort()
        release.resolve()
        expect(await stopped).toBe(true)
        expect(await MCP.inspect("synthetic")).toEqual({ client: false, defs: false, ready: false })
        expect(control.calls.clients).toBe(1)
        expect(control.calls.closed).toEqual([1])

        expect(Object.keys(await MCP.toolsForServers(["synthetic"]))).toEqual(["synthetic_search"])
        expect(control.calls.clients).toBe(2)
        expect(control.calls.list).toBe(2)
        expect(control.calls.closed).toEqual([1, 0])

        await Instance.dispose()
        cleanup.disposed = true
        expect(control.calls.closed).toEqual([1, 1])
      } finally {
        if (!cleanup.disposed) await Instance.dispose()
        control.restore()
      }
    },
  })
})

test("interruption after definitions closes the pre-install client and permits retry", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: {
        synthetic: { type: "local", command: ["synthetic-never-run"] },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const entered = signal()
      const release = signal()
      const control = controls({ list() {} })
      const visits = { count: 0 }
      control.preinstall.mockImplementation(async () => {
        if (visits.count++ !== 0) return
        entered.resolve()
        await release.promise
      })
      const abort = new AbortController()
      const cleanup = { disposed: false }
      try {
        const pending = MCP.toolsForServers(["synthetic"], { signal: abort.signal })
        const stopped = pending.then(
          () => false,
          () => true,
        )
        await entered.promise
        abort.abort()
        release.resolve()
        expect(await stopped).toBe(true)
        expect(await MCP.inspect("synthetic")).toEqual({ client: false, defs: false, ready: false })
        expect(control.calls.clients).toBe(1)
        expect(control.calls.list).toBe(1)
        expect(control.calls.closed).toEqual([1])

        expect(Object.keys(await MCP.toolsForServers(["synthetic"]))).toEqual(["synthetic_search"])
        expect(control.calls.clients).toBe(2)
        expect(control.calls.list).toBe(2)
        expect(control.calls.closed).toEqual([1, 0])

        await Instance.dispose()
        cleanup.disposed = true
        expect(control.calls.closed).toEqual([1, 1])
      } finally {
        if (!cleanup.disposed) await Instance.dispose()
        control.restore()
      }
    },
  })
})

test("canceling a semaphore waiter does not affect the owner or later callers", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: {
        synthetic: { type: "local", command: ["synthetic-never-run"] },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const entered = signal()
      const release = signal()
      const waiting = signal()
      const control = controls({
        async list() {
          entered.resolve()
          await release.promise
        },
      })
      const visits = { ensure: 0 }
      control.lifecycle.mockImplementation((name, operation) => {
        if (name !== "synthetic" || operation !== "ensure") return
        if (++visits.ensure === 2) waiting.resolve()
      })
      const abort = new AbortController()
      const cleanup = { disposed: false }
      try {
        const owner = MCP.toolsForServers(["synthetic"])
        await entered.promise
        const waiter = MCP.toolsForServers(["synthetic"], { signal: abort.signal })
        const stopped = waiter.then(
          () => false,
          () => true,
        )
        await waiting.promise
        abort.abort()
        expect(await stopped).toBe(true)

        release.resolve()
        expect(Object.keys(await owner)).toEqual(["synthetic_search"])
        expect(Object.keys(await MCP.toolsForServers(["synthetic"]))).toEqual(["synthetic_search"])
        expect(await MCP.inspect("synthetic")).toEqual({ client: true, defs: true, ready: true })
        expect(control.calls.clients).toBe(1)
        expect(control.calls.list).toBe(1)
        expect(control.calls.closed).toEqual([0])

        await Instance.dispose()
        cleanup.disposed = true
        expect(control.calls.closed).toEqual([1])
      } finally {
        if (!cleanup.disposed) await Instance.dispose()
        control.restore()
      }
    },
  })
})
