// kilocode_change - new file
import { afterEach, expect, spyOn, test } from "bun:test"
import path from "node:path"
import { LSP } from "../../../src/lsp"
import { LSPServer } from "../../../src/lsp/server"
import { Instance } from "../../../src/project/instance"
import { SessionID, MessageID } from "../../../src/session/schema"
import { LspTool } from "../../../src/tool/lsp"
import { ReadTool } from "../../../src/tool/read"
import { Process } from "../../../src/util/process"
import { resetDatabase } from "../../fixture/db"
import { tmpdir } from "../../fixture/fixture"

function ctx(
  calls: string[] = [],
  rules?: {
    agent: { permission: string; pattern: string; action: "allow" | "ask" | "deny" }[]
    session: { permission: string; pattern: string; action: "allow" | "ask" | "deny" }[]
  },
) {
  return {
    sessionID: SessionID.make("ses_lsp_installed_only"),
    messageID: MessageID.ascending(),
    callID: "lsp-installed-only",
    agent: "synthetic",
    abort: new AbortController().signal,
    messages: [],
    rules,
    metadata() {},
    async ask(input: { permission: string }) {
      calls.push(input.permission)
    },
  }
}

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

test("agent LSP acquisition scope disables every installer branch", async () => {
  const before = LSPServer.canInstall()
  await LSPServer.installedOnly(async () => {
    expect(LSPServer.canInstall()).toBe(false)
    expect(LSPServer.canLaunch("npm.cmd")).toBe(false)
    expect(LSPServer.canLaunch("pnpm")).toBe(false)
    expect(LSPServer.canLaunch("yarn.exe")).toBe(false)
    expect(LSPServer.canLaunch("bun")).toBe(false)
    expect(LSPServer.canLaunch("go", ["install", "example/lsp@latest"])).toBe(false)
    expect(LSPServer.canLaunch("dotnet", ["tool", "install", "example-lsp"])).toBe(false)
    expect(LSPServer.canLaunch("language-server")).toBe(true)
    await Promise.resolve()
    expect(LSPServer.canInstall()).toBe(false)
  })
  expect(LSPServer.canInstall()).toBe(before)
})

test("missing LSP returns unavailable before package managers or downloads", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "missing.vue"), "<template />\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const installed = spyOn(LSP, "installed").mockImplementation(async () => {
        expect(LSPServer.canInstall()).toBe(false)
        return false
      })
      const spawn = spyOn(Process, "spawn")
      const run = spyOn(Process, "run")
      const fetch = spyOn(globalThis, "fetch")
      try {
        const tool = await LspTool.init()
        await expect(
          tool.execute({ operation: "hover", filePath: "missing.vue", line: 1, character: 1 }, ctx() as never),
        ).rejects.toThrow("No installed LSP server")
        expect(spawn).toHaveBeenCalledTimes(0)
        expect(run).toHaveBeenCalledTimes(0)
        expect(fetch).toHaveBeenCalledTimes(0)
      } finally {
        installed.mockRestore()
        spawn.mockRestore()
        run.mockRestore()
        fetch.mockRestore()
      }
    },
  })
})

test("implicit read diagnostics do not cross an effective LSP deny", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "blocked.ts"), "export const blocked = true\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const warm = spyOn(LSP, "installedOnly")
      try {
        const tool = await ReadTool.init()
        await tool.execute(
          { filePath: "blocked.ts" },
          ctx([], {
            agent: [{ permission: "lsp", pattern: "*", action: "deny" }],
            session: [{ permission: "lsp", pattern: "*", action: "allow" }],
          }) as never,
        )
        expect(warm).toHaveBeenCalledTimes(0)
      } finally {
        warm.mockRestore()
      }
    },
  })
})

test("installed and permitted LSP remains usable", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "ready.ts"), "export const ready = true\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const installed = spyOn(LSP, "installed").mockImplementation(async () => {
        expect(LSPServer.canInstall()).toBe(false)
        return true
      })
      const touch = spyOn(LSP, "touchFile").mockImplementation(async () => {
        expect(LSPServer.canInstall()).toBe(false)
      })
      const hover = spyOn(LSP, "hover").mockImplementation(async () => {
        expect(LSPServer.canInstall()).toBe(false)
        return [{ contents: "ready" }]
      })
      try {
        const tool = await LspTool.init()
        const calls: string[] = []
        const result = await tool.execute(
          { operation: "hover", filePath: "ready.ts", line: 1, character: 1 },
          ctx(calls) as never,
        )
        expect(result.output).toContain("ready")
        expect(calls).toEqual(["lsp"])
        expect(installed).toHaveBeenCalledTimes(1)
        expect(touch).toHaveBeenCalledTimes(1)
        expect(hover).toHaveBeenCalledTimes(1)
      } finally {
        installed.mockRestore()
        touch.mockRestore()
        hover.mockRestore()
      }
    },
  })
})
