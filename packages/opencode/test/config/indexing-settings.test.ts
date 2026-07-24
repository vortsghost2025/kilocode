// kilocode_change - new file
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
  await Config.invalidate()
})

describe("indexing settings UI", () => {
  test("indexing.enabled defaults to undefined when not configured", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        expect(cfg.indexing).toBeUndefined()
      },
    })
  })

  test("indexing.enabled reads from config", async () => {
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

  test("changing toggle persists indexing.enabled", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        expect(cfg.indexing).toBeUndefined()

        await Config.update({ ...cfg, indexing: { enabled: true } } as any)

        const written = await Filesystem.readJson(path.join(tmp.path, "config.json"))
        expect(written.indexing?.enabled).toBe(true)

        await Config.update({ ...cfg, indexing: { enabled: false } } as any)

        const written2 = await Filesystem.readJson(path.join(tmp.path, "config.json"))
        expect(written2.indexing?.enabled).toBe(false)
      },
    })
  })

  test("changing provider persists indexing.provider", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()

        await Config.update({ ...cfg, indexing: { enabled: true, provider: "ollama" } } as any)

        const written = await Filesystem.readJson(path.join(tmp.path, "config.json"))
        expect(written.indexing?.provider).toBe("ollama")

        await Config.update({
          ...cfg,
          indexing: { ...(cfg.indexing ?? {}), provider: "openai" },
        } as any)

        const written2 = await Filesystem.readJson(path.join(tmp.path, "config.json"))
        expect(written2.indexing?.provider).toBe("openai")
      },
    })
  })

  test("unrelated config fields remain unchanged after indexing update", async () => {
    await using tmp = await tmpdir({
      config: {
        model: "test/model",
        username: "testuser",
        indexing: { enabled: false },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const before = await Config.get()
        expect(before.model).toBe("test/model")
        expect(before.username).toBe("testuser")

        await Config.update({
          ...before,
          indexing: { enabled: true, provider: "gemini" },
        } as any)

        const written = await Filesystem.readJson(path.join(tmp.path, "config.json"))
        expect(written.model).toBe("test/model")
        expect(written.username).toBe("testuser")
        expect(written.indexing?.enabled).toBe(true)
        expect(written.indexing?.provider).toBe("gemini")
      },
    })
  })

  test("DialogIndexing component is imported in app.tsx", async () => {
    const src = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/tui/app.tsx"), "utf-8")
    expect(src).toContain("DialogIndexing")
  })

  test("app.tsx registers indexing slash command", async () => {
    const src = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/tui/app.tsx"), "utf-8")
    expect(src).toContain("indexing.settings")
    expect(src).toContain('name: "indexing"')
  })

  test("DialogIndexing component file exists with section title", async () => {
    const src = await fs.readFile(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/component/dialog-indexing.tsx"),
      "utf-8",
    )
    expect(src).toContain("Codebase Indexing")
    expect(src).toContain("Builds a local semantic index of the current codebase for semantic search.")
    expect(src).toContain("indexing")
    expect(src).toContain("provider")
  })
})
