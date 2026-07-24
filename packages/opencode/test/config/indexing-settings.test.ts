// kilocode_change - new file
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util/filesystem"
import { indexingEnabledPatch, indexingProviderPatch, getProviderOptions } from "../../src/kilocode/indexing-settings"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
  await Config.invalidate()
})

describe("indexing settings patch builders", () => {
  test("enabled patch contains only indexing.enabled", () => {
    const patch = indexingEnabledPatch(true)
    expect(patch).toEqual({ indexing: { enabled: true } })
    expect(Object.keys(patch)).toEqual(["indexing"])
    expect(Object.keys(patch.indexing)).toEqual(["enabled"])
  })

  test("enabled patch false transmits only the boolean", () => {
    const patch = indexingEnabledPatch(false)
    expect(patch).toEqual({ indexing: { enabled: false } })
    expect(Object.keys(patch.indexing)).toEqual(["enabled"])
  })

  test("provider patch contains only indexing.provider", () => {
    const patch = indexingProviderPatch("ollama")
    expect(patch).toEqual({ indexing: { provider: "ollama" } })
    expect(Object.keys(patch)).toEqual(["indexing"])
    expect(Object.keys(patch.indexing)).toEqual(["provider"])
  })

  test("neither patch carries model, username, api keys, or unrelated fields", () => {
    const enabledPatch = indexingEnabledPatch(true) as Record<string, any>
    const providerPatch = indexingProviderPatch("ollama") as Record<string, any>

    for (const patch of [enabledPatch, providerPatch]) {
      expect(patch.model).toBeUndefined()
      expect(patch.username).toBeUndefined()
      expect(patch.permission).toBeUndefined()
      expect(patch.openai).toBeUndefined()
      expect(patch.kilo).toBeUndefined()
      expect(patch.gemini).toBeUndefined()
      expect(patch.mistral).toBeUndefined()
      expect(patch.bedrock).toBeUndefined()
      expect(patch.openrouter).toBeUndefined()
      expect(patch.voyage).toBeUndefined()
      expect(patch.qdrant).toBeUndefined()
      expect(patch.lancedb).toBeUndefined()
      const idx = patch.indexing as Record<string, unknown>
      expect(idx.openai).toBeUndefined()
      expect(idx.kilo).toBeUndefined()
      expect(idx.gemini).toBeUndefined()
      expect(idx.mistral).toBeUndefined()
      expect(idx.bedrock).toBeUndefined()
      expect(idx.openrouter).toBeUndefined()
      expect(idx.voyage).toBeUndefined()
      expect(idx.qdrant).toBeUndefined()
      expect(idx.lancedb).toBeUndefined()
      expect(idx.apiKey).toBeUndefined()
      expect(idx.model).toBeUndefined()
    }
  })

  test("provider option list is derived from the schema and is non-empty", () => {
    const opts = getProviderOptions()
    expect(opts.length).toBeGreaterThan(0)
    expect(opts.map((o) => o.value)).toContain("ollama")
    expect(opts.map((o) => o.value)).toContain("openai")
    expect(opts.map((o) => o.value)).toContain("openai-compatible")
    for (const o of opts) {
      expect(typeof o.title).toBe("string")
      expect(typeof o.value).toBe("string")
    }
  })
})

describe("indexing initial display reads from config", () => {
  test("indexing.enabled and indexing.provider come from Config.get", async () => {
    await using tmp = await tmpdir({
      config: { indexing: { enabled: true, provider: "ollama" } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        expect(cfg.indexing?.enabled).toBe(true)
        expect(cfg.indexing?.provider).toBe("ollama")
      },
    })
  })

  test("absent indexing block yields undefined enabled/provider", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        expect(cfg.indexing).toBeUndefined()
      },
    })
  })
})

describe("Config.update writes minimal patches", () => {
  test("enabled-only patch writes only indexing.enabled into config.json", async () => {
    // Unrelated keys (model, username) live in opencode.json (loaded by the project loader).
    // Provided indexing credentials live in opencode.json too, and stay untouched.
    await using tmp = await tmpdir({
      config: {
        model: "test/model",
        username: "testuser",
        indexing: {
          enabled: false,
          provider: "openai",
          openai: { apiKey: "sk-secret" },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.update(indexingEnabledPatch(true) as any)
      },
    })

    // config.json (written by Config.update) must contain ONLY the enabled patch.
    // Unrelated keys and credentials must remain in opencode.json, untouched.
    const opencodeRaw = await Filesystem.readJson(path.join(tmp.path, "opencode.json"))
    expect((opencodeRaw as any).model).toBe("test/model")
    expect((opencodeRaw as any).username).toBe("testuser")
    expect((opencodeRaw as any).indexing?.provider).toBe("openai")
    expect((opencodeRaw as any).indexing?.openai?.apiKey).toBe("sk-secret")
    expect((opencodeRaw as any).indexing?.enabled).toBe(false)

    const configRaw = await Filesystem.readJson(path.join(tmp.path, "config.json"))
    expect((configRaw as any).indexing?.enabled).toBe(true)
    expect(Object.keys((configRaw as any).indexing ?? {})).toEqual(["enabled"])
    expect((configRaw as any).model).toBeUndefined()
    expect((configRaw as any).username).toBeUndefined()
    expect((configRaw as any).permission).toBeUndefined()
    expect((configRaw as any).openai).toBeUndefined()
    expect((configRaw as any).kilo).toBeUndefined()
    expect((configRaw as any).indexing?.provider).toBeUndefined()
    expect((configRaw as any).indexing?.openai).toBeUndefined()
  })

  test("provider-only patch writes only indexing.provider into config.json", async () => {
    await using tmp = await tmpdir({
      config: {
        model: "test/model",
        indexing: {
          enabled: true,
          provider: "openai",
          openai: { apiKey: "sk-secret" },
          ollama: { baseUrl: "http://localhost:11434" },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.update(indexingProviderPatch("ollama") as any)
      },
    })

    const opencodeRaw = await Filesystem.readJson(path.join(tmp.path, "opencode.json"))
    expect((opencodeRaw as any).model).toBe("test/model")
    expect((opencodeRaw as any).indexing?.enabled).toBe(true)
    expect((opencodeRaw as any).indexing?.provider).toBe("openai")
    expect((opencodeRaw as any).indexing?.openai?.apiKey).toBe("sk-secret")
    expect((opencodeRaw as any).indexing?.ollama?.baseUrl).toBe("http://localhost:11434")

    const configRaw = await Filesystem.readJson(path.join(tmp.path, "config.json"))
    expect((configRaw as any).indexing?.provider).toBe("ollama")
    expect(Object.keys((configRaw as any).indexing ?? {})).toEqual(["provider"])
    expect((configRaw as any).model).toBeUndefined()
    expect((configRaw as any).indexing?.enabled).toBeUndefined()
    expect((configRaw as any).indexing?.openai).toBeUndefined()
    expect((configRaw as any).indexing?.ollama).toBeUndefined()
    expect((configRaw as any).openai).toBeUndefined()
  })
})

describe("indexing settings UI presence", () => {
  test("dialog-indexing.tsx renders the required section title and explanation", async () => {
    const src = await fs.readFile(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/component/dialog-indexing.tsx"),
      "utf-8",
    )
    expect(src).toContain("Codebase Indexing")
    expect(src).toContain("Builds a local semantic index of the current codebase for semantic search.")
  })

  test("app.tsx registers the indexing command under System", async () => {
    const src = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/tui/app.tsx"), "utf-8")
    expect(src).toContain("indexing.settings")
    expect(src).toContain('name: "indexing"')
    expect(src).toContain("DialogIndexing")
  })

  test("dialog uses patch helpers, never spreads config.get into update", async () => {
    const src = await fs.readFile(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/component/dialog-indexing.tsx"),
      "utf-8",
    )
    expect(src).toContain("indexingEnabledPatch")
    expect(src).toContain("indexingProviderPatch")
    expect(src).not.toContain("...current")
    expect(src).not.toContain("...res.data")
  })
})
