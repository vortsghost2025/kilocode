import { afterEach, describe, expect, test, mock } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { KiloIndexing } from "../../src/kilocode/indexing"
import { IndexingWorker } from "../../src/kilocode/indexing-worker-client"
import { tmpdir } from "../fixture/fixture"
import { IndexingConfig } from "@kilocode/kilo-indexing/config"

afterEach(async () => {
  await Instance.disposeAll()
  await Config.invalidate()
})

describe("indexing config schema", () => {
  test("indexing field absent: Config.get() returns undefined indexing", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        expect(cfg).toBeDefined()
        expect(cfg.indexing).toBeUndefined()
      },
    })
  })

  test("enabled false: indexing block with enabled false", async () => {
    const cfg = IndexingConfig.parse({ enabled: false })
    expect(cfg.enabled).toBe(false)
  })

  test("valid provider + vectorStore accepted", async () => {
    const cfg = IndexingConfig.parse({
      enabled: true,
      provider: "ollama",
      vectorStore: "lancedb",
      ollama: { baseUrl: "http://127.0.0.1:11434" },
    })
    expect(cfg.enabled).toBe(true)
    expect(cfg.provider).toBe("ollama")
    expect(cfg.vectorStore).toBe("lancedb")
  })

  test("malformed provider rejected", async () => {
    expect(() => IndexingConfig.parse({ provider: "nonexistent-provider" })).toThrow()
  })

  test("negative dimension rejected", async () => {
    expect(() => IndexingConfig.parse({ dimension: -1 })).toThrow()
  })

  test("invalid vector store rejected", async () => {
    expect(() => IndexingConfig.parse({ vectorStore: "pinecone" })).toThrow()
  })

  test("unrelated configuration preserved", async () => {
    await using tmp = await tmpdir({
      config: {
        model: "test/model",
        indexing: { enabled: true, provider: "openai" },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        expect(cfg.model).toBe("test/model")
        expect(cfg.indexing?.enabled).toBe(true)
        expect(cfg.indexing?.provider).toBe("openai")
      },
    })
  })

  test("schema import does not eagerly load Worker or LanceDB", async () => {
    const workerBefore = Object.keys(require.cache ?? {}).filter(
      (k) => k.includes("indexing-worker") || k.includes("lancedb"),
    ).length
    const { IndexingConfig: Imported } = await import("@kilocode/kilo-indexing/config")
    const workerAfter = Object.keys(require.cache ?? {}).filter(
      (k) => k.includes("indexing-worker") || k.includes("lancedb"),
    ).length
    expect(Imported).toBeDefined()
    expect(workerAfter).toBe(workerBefore)
  })

  test("deep merges config from multiple sources preserving nested fields", async () => {
    await using tmp = await tmpdir({ git: true })

    await fs.writeFile(
      path.join(tmp.path, "kilo.jsonc"),
      JSON.stringify({
        indexing: {
          enabled: true,
          provider: "ollama",
          vectorStore: "lancedb",
          ollama: { baseUrl: "http://127.0.0.1:11434" },
          lancedb: { directory: "C:\\index-root" },
          searchMinScore: 0.35,
        },
      }),
    )

    await fs.mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, ".kilo", "kilo.jsonc"),
      JSON.stringify({
        indexing: {
          model: "nomic-embed-text",
          dimension: 768,
          searchMaxResults: 25,
        },
      }),
    )

    const initArg: any[] = []
    IndexingWorker.override((_dir, _root, _hooks) => ({
      ping: mock(async () => ({
        key: "test",
        engineLoaded: true,
        statusLoaded: true,
        lancedbPath: undefined,
        lancedbLoaded: true,
        connectType: undefined,
      })),
      init: mock(async (cfg, baseline) => {
        initArg.push({ cfg, baseline })
        return { state: "Standby" as const, message: "", processedFiles: 0, totalFiles: 0, percent: 100 }
      }),
      search: mock(async () => []),
      dispose: mock(async () => {}),
    }))

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await KiloIndexing.init()
        },
      })

      expect(initArg).toHaveLength(1)
      const { cfg, baseline } = initArg[0]

      expect(cfg.enabled).toBe(true)
      expect(cfg.embedderProvider).toBe("ollama")
      expect(cfg.vectorStoreProvider).toBe("lancedb")
      expect(cfg.ollamaBaseUrl).toBe("http://127.0.0.1:11434")
      expect(cfg.lancedbVectorStoreDirectory).toBe("C:\\index-root")
      expect(cfg.searchMinScore).toBe(0.35)
      expect(cfg.modelId).toBe("nomic-embed-text")
      expect(cfg.modelDimension).toBe(768)
      expect(cfg.searchMaxResults).toBe(25)
      expect(baseline).toBeDefined()
    } finally {
      IndexingWorker.override()
    }
  })
})
