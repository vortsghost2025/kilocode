// kilocode_change - new file
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { Filesystem } from "../../src/util/filesystem"
import { indexingEnabledPatch, indexingProviderPatch, getProviderOptions } from "../../src/kilocode/indexing-settings"

// The test preload (test/preload.ts) sets XDG_CONFIG_HOME to an isolated tmp
// directory, so Global.Path.config already points at <tmp>/config/kilo/ and
// the real user profile is never touched. We additionally clear that isolated
// dir in afterEach so each test starts from a clean global config state.
const globalConfigDir = Global.Path.config

async function clearGlobalConfig() {
  for (const f of ["kilo.jsonc", "kilo.json", "opencode.jsonc", "opencode.json", "config.json"]) {
    await fs.rm(path.join(globalConfigDir, f), { force: true }).catch(() => {})
  }
  await Config.invalidate()
}

afterEach(async () => {
  await Instance.disposeAll()
  await clearGlobalConfig()
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

  test("neither patch carries model, username, permission, credentials, or unrelated fields", () => {
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

  test("provider option list is derived from the IndexingConfig schema and is non-empty", () => {
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

describe("global indexing read", () => {
  test("absent indexing block yields undefined enabled/provider", async () => {
    const cfg = await Config.getGlobal()
    // No indexing key in a fresh global config dir.
    expect(cfg.indexing).toBeUndefined()
  })
})

describe("global indexing persistence survives a fresh reload", () => {
  test("enabled update survives a fresh Config.getGlobal reload", async () => {
    await Config.updateGlobal(indexingEnabledPatch(true) as any)

    const reloaded = await Config.getGlobal()
    expect(reloaded.indexing?.enabled).toBe(true)
  })

  test("provider update survives a fresh Config.getGlobal reload", async () => {
    await Config.updateGlobal(indexingProviderPatch("ollama") as any)

    const reloaded = await Config.getGlobal()
    expect(reloaded.indexing?.provider).toBe("ollama")
  })

  test("second enabled-only update preserves an already-saved provider", async () => {
    await Config.updateGlobal(indexingProviderPatch("ollama") as any)
    await Config.updateGlobal(indexingEnabledPatch(true) as any)

    const reloaded = await Config.getGlobal()
    expect(reloaded.indexing?.provider).toBe("ollama")
    expect(reloaded.indexing?.enabled).toBe(true)
  })

  test("provider-only update preserves an already-saved enabled value", async () => {
    await Config.updateGlobal(indexingEnabledPatch(true) as any)
    await Config.updateGlobal(indexingProviderPatch("gemini") as any)

    const reloaded = await Config.getGlobal()
    expect(reloaded.indexing?.enabled).toBe(true)
    expect(reloaded.indexing?.provider).toBe("gemini")
  })

  test("saved global file contains the indexing patch and no credentials", async () => {
    await Config.updateGlobal(indexingProviderPatch("ollama") as any)

    // The written global config file is the first existing candidate. Since
    // we cleared the dir, Config.updateGlobal creates the default (kilo.jsonc).
    const defs = ["kilo.jsonc", "kilo.json", "opencode.jsonc", "opencode.json", "config.json"]
    let written: any = undefined
    for (const f of defs) {
      const p = path.join(globalConfigDir, f)
      const exists = await fs
        .stat(p)
        .then(() => true)
        .catch(() => false)
      if (exists) {
        const text = await fs.readFile(p, "utf-8")
        written = JSON.parse(text)
        break
      }
    }
    expect(written).toBeDefined()
    expect(written.indexing?.provider).toBe("ollama")
    // No credentials leaked into the written file
    expect(written.openai).toBeUndefined()
    expect(written.kilo).toBeUndefined()
    expect(written.gemini).toBeUndefined()
    expect((written.indexing ?? {}).openai).toBeUndefined()
    expect((written.indexing ?? {}).kilo).toBeUndefined()
    expect((written.indexing ?? {}).gemini).toBeUndefined()
  })
})

describe("global indexing apply preserves unrelated fields already in the file", () => {
  test("enabled update preserves model already in the global file", async () => {
    // Seed an existing global config file with a model key.
    await fs.mkdir(globalConfigDir, { recursive: true })
    await Bun.write(path.join(globalConfigDir, "kilo.jsonc"), JSON.stringify({ model: "anthropic/claude-3" }, null, 2))
    await Config.invalidate()

    await Config.updateGlobal(indexingEnabledPatch(true) as any)
    const reloaded = await Config.getGlobal()
    expect(reloaded.model).toBe("anthropic/claude-3")
    expect(reloaded.indexing?.enabled).toBe(true)
  })

  test("provider update preserves username already in the global file", async () => {
    await fs.mkdir(globalConfigDir, { recursive: true })
    await Bun.write(path.join(globalConfigDir, "kilo.jsonc"), JSON.stringify({ username: "someone" }, null, 2))
    await Config.invalidate()

    await Config.updateGlobal(indexingProviderPatch("ollama") as any)
    const reloaded = await Config.getGlobal()
    expect(reloaded.username).toBe("someone")
    expect(reloaded.indexing?.provider).toBe("ollama")
  })
})

describe("indexing settings UI source presence (secondary checks)", () => {
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

  test("dialog uses global.config endpoints with patch helpers, never spreads config", async () => {
    const src = await fs.readFile(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/component/dialog-indexing.tsx"),
      "utf-8",
    )
    expect(src).toContain("sdk.client.global.config.get")
    expect(src).toContain("sdk.client.global.config.update")
    expect(src).toContain("indexingEnabledPatch")
    expect(src).toContain("indexingProviderPatch")
    // The unsafe pattern of spreading config.get into config.update must be absent
    expect(src).not.toContain("...current")
    expect(src).not.toContain("...res.data")
    // Must NOT use the project config endpoint (which writes to an unread config.json)
    expect(src).not.toContain("sdk.client.config.get")
    expect(src).not.toContain("sdk.client.config.update")
  })
})
