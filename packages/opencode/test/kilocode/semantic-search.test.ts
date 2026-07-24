import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import path from "node:path"
import { SemanticSearchTool } from "../../src/kilocode/tool/semantic-search"
import { Instance } from "../../src/project/instance"
import type { Permission } from "../../src/permission"
import { tmpdir } from "../fixture/fixture"
import type { VectorStoreSearchResult } from "@kilocode/kilo-indexing/engine"
import { KiloIndexing } from "../../src/kilocode/indexing"

type AskInput = Omit<Permission.Request, "id" | "sessionID" | "tool">

const sampleResult = (over: Partial<VectorStoreSearchResult> = {}): VectorStoreSearchResult =>
  ({
    id: "p1",
    score: 0.875,
    payload: {
      filePath: "src/auth/index.ts",
      codeChunk: "export function login() {}",
      startLine: 10,
      endLine: 14,
    },
    ...over,
  }) as VectorStoreSearchResult

function ctxStub(opts: { ask: (input: AskInput) => Promise<void> }) {
  return {
    sessionID: "s1" as any,
    messageID: "m1" as any,
    agent: "code",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask: opts.ask,
  }
}

describe("SemanticSearchTool", () => {
  afterEach(async () => {
    await Instance.disposeAll()
    mock.restore()
  })

  test("exports canonical id semantic_search", async () => {
    expect(SemanticSearchTool.id).toBe("semantic_search")
  })

  test("rejects empty and whitespace-only query", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ready = spyOn(KiloIndexing, "ready")
        const search = spyOn(KiloIndexing, "search")
        const ask = mock(async () => {})
        const initialized = await SemanticSearchTool.init()
        const ctx = ctxStub({ ask })

        await expect(initialized.execute({ query: "" }, ctx)).rejects.toThrow("query is required")
        await expect(initialized.execute({ query: "   " }, ctx)).rejects.toThrow("query is required")
        expect(ready).not.toHaveBeenCalled()
        expect(ask).not.toHaveBeenCalled()
        expect(search).not.toHaveBeenCalled()
      },
    })
  })

  test("ready false returns safe empty without ctx.ask or search", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ready = spyOn(KiloIndexing, "ready").mockReturnValue(false)
        const search = spyOn(KiloIndexing, "search").mockResolvedValue([])

        const ask = mock(async () => {})
        const initialized = await SemanticSearchTool.init()
        const ctx = ctxStub({ ask })

        const result = await initialized.execute({ query: "auth" }, ctx)

        expect(ready).toHaveBeenCalledTimes(1)
        expect(ask).not.toHaveBeenCalled()
        expect(search).not.toHaveBeenCalled()
        expect(result.metadata.results).toEqual([])
        expect(result.output).toContain("No relevant code found")
      },
    })
  })

  test("ready true calls ctx.ask with always=[] and preserves query in metadata", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ready = spyOn(KiloIndexing, "ready").mockReturnValue(true)
        const search = spyOn(KiloIndexing, "search").mockResolvedValue([])

        let captured: AskInput | undefined
        const ask = mock(async (input: AskInput) => {
          captured = input
        })
        const initialized = await SemanticSearchTool.init()
        const ctx = ctxStub({ ask })

        await initialized.execute({ query: "auth login" }, ctx)

        expect(ready).toHaveBeenCalledTimes(1)
        expect(search).toHaveBeenCalledTimes(1)
        expect(captured).toBeDefined()
        expect(captured!.always).toEqual([])
        expect(captured!.always).not.toContain("*")
        expect(captured!.permission).toBe("semantic_search")
        expect(captured!.patterns).toEqual(["auth login"])
        expect(captured!.metadata).toEqual({ query: "auth login" })
      },
    })
  })

  test("approved call delegates exact query once to search", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ready = spyOn(KiloIndexing, "ready").mockReturnValue(true)
        const search = spyOn(KiloIndexing, "search").mockResolvedValue([])

        const initialized = await SemanticSearchTool.init()
        await initialized.execute({ query: "auth" }, ctxStub({ ask: async () => {} }))

        expect(search).toHaveBeenCalledTimes(1)
        expect(search.mock.calls[0][0]).toBe("auth")
      },
    })
  })

  test("ready lost between discovery and execute returns safe empty without ask or search", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        let available = true
        const ready = spyOn(KiloIndexing, "ready").mockImplementation(() => available)
        const search = spyOn(KiloIndexing, "search").mockResolvedValue([])

        const initialized = await SemanticSearchTool.init()
        expect(KiloIndexing.ready()).toBe(true)
        available = false

        const ask = mock(async () => {})
        const result = await initialized.execute({ query: "late" }, ctxStub({ ask }))

        expect(ask).not.toHaveBeenCalled()
        expect(ready).toHaveBeenCalledTimes(2)
        expect(search).not.toHaveBeenCalled()
        expect(result.metadata.results).toEqual([])
      },
    })
  })

  test("backend search rejection is contained as safe empty after approval", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ready = spyOn(KiloIndexing, "ready").mockReturnValue(true)
        const search = spyOn(KiloIndexing, "search").mockRejectedValue(new Error("vector db timeout"))

        const initialized = await SemanticSearchTool.init()
        const result = await initialized.execute({ query: "fail" }, ctxStub({ ask: async () => {} }))

        expect(ready).toHaveBeenCalledTimes(1)
        expect(search).toHaveBeenCalledTimes(1)
        expect(result.metadata.results).toEqual([])
        expect(result.output).toContain("No relevant code found")
      },
    })
  })

  test("result fields preserved exactly", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = sampleResult({ score: -0.42 })
        spyOn(KiloIndexing, "ready").mockReturnValue(true)
        spyOn(KiloIndexing, "search").mockResolvedValue([result])

        const initialized = await SemanticSearchTool.init()
        const out = await initialized.execute({ query: "q" }, ctxStub({ ask: async () => {} }))

        expect(out.metadata.results).toHaveLength(1)
        const r = out.metadata.results[0]
        expect(r.score).toBe(-0.42)
        expect(r.filePath).toBe("src/auth/index.ts")
        expect(r.startLine).toBe(10)
        expect(r.endLine).toBe(14)
        expect(r.codeChunk).toBe("export function login() {}")
      },
    })
  })

  test("malformed payloads are omitted", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const results: VectorStoreSearchResult[] = [
          sampleResult(),
          { id: "n1", score: 0.5, payload: null } as any,
          { id: "n2", score: 0.5, payload: undefined as any },
          { id: "n3", score: 0.5, payload: { filePath: "", codeChunk: "x", startLine: 1, endLine: 2 } as any },
          { id: "n4", score: NaN, payload: { filePath: "a", codeChunk: "x", startLine: 1, endLine: 2 } } as any,
          { id: "n5", score: Infinity, payload: { filePath: "a", codeChunk: "x", startLine: 1, endLine: 2 } } as any,
          { id: "n6", score: 0.5, payload: { filePath: 1, codeChunk: "x", startLine: 1, endLine: 2 } as any },
          { id: "n7", score: 0.5, payload: { filePath: "a", codeChunk: 2, startLine: 1, endLine: 2 } as any },
          { id: "n8", score: 0.5, payload: { filePath: "a", codeChunk: "x", startLine: 1.5, endLine: 2 } as any },
          { id: "n9", score: 0.5, payload: { filePath: "a", codeChunk: "x", startLine: 5, endLine: 2 } as any },
        ]
        spyOn(KiloIndexing, "ready").mockReturnValue(true)
        spyOn(KiloIndexing, "search").mockResolvedValue(results)

        const initialized = await SemanticSearchTool.init()
        const out = await initialized.execute({ query: "q" }, ctxStub({ ask: async () => {} }))

        expect(out.metadata.results).toHaveLength(1)
      },
    })
  })

  test("in-workspace absolute result path converted to relative forward-slash", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Bun.write(path.join(tmp.path, "src", "auth", "index.ts"), "x")
        const abs = path.join(tmp.path, "src", "auth", "index.ts")
        const result = sampleResult({ payload: { filePath: abs, codeChunk: "x", startLine: 1, endLine: 2 } as any })

        spyOn(KiloIndexing, "ready").mockReturnValue(true)
        spyOn(KiloIndexing, "search").mockResolvedValue([result])

        const initialized = await SemanticSearchTool.init()
        const out = await initialized.execute({ query: "q" }, ctxStub({ ask: async () => {} }))

        expect(out.metadata.results[0].filePath).toBe("src/auth/index.ts")
        expect(out.output).not.toContain(tmp.path.replace(/\\/g, "/"))
      },
    })
  })

  test("outside-workspace result path omitted", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const outside = path.join(path.dirname(tmp.path), "outside.ts")
        const result = sampleResult({ payload: { filePath: outside, codeChunk: "x", startLine: 1, endLine: 2 } as any })

        spyOn(KiloIndexing, "ready").mockReturnValue(true)
        spyOn(KiloIndexing, "search").mockResolvedValue([result])

        const initialized = await SemanticSearchTool.init()
        const out = await initialized.execute({ query: "q" }, ctxStub({ ask: async () => {} }))

        expect(out.metadata.results).toEqual([])
      },
    })
  })

  test("path escape rejected before ready/ask/search", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ready = spyOn(KiloIndexing, "ready").mockReturnValue(true)
        const search = spyOn(KiloIndexing, "search").mockResolvedValue([])

        const ask = mock(async () => {})
        const initialized = await SemanticSearchTool.init()

        await expect(initialized.execute({ query: "q", path: "../outside" }, ctxStub({ ask }))).rejects.toThrow(
          "path must be within the current workspace",
        )

        expect(ready).not.toHaveBeenCalled()
        expect(ask).not.toHaveBeenCalled()
        expect(search).not.toHaveBeenCalled()
      },
    })
  })

  test("optional path normalized and forwarded as relative prefix", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Bun.write(path.join(tmp.path, "src", "tool", "x.ts"), "x")
        spyOn(KiloIndexing, "ready").mockReturnValue(true)
        const search = spyOn(KiloIndexing, "search").mockResolvedValue([])

        let captured: AskInput | undefined
        const ask = mock(async (input: AskInput) => {
          captured = input
        })
        const initialized = await SemanticSearchTool.init()

        await initialized.execute({ query: "q", path: "./src/../src/tool" }, ctxStub({ ask }))

        expect(search.mock.calls[0][1]).toBe(path.normalize("src/tool"))
        expect(captured!.metadata).toEqual({ query: "q", path: path.normalize("src/tool") })
      },
    })
  })

  test("no absolute host path in output or metadata", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const abs = path.join(tmp.path, "src", "auth.ts")
        const result = sampleResult({ payload: { filePath: abs, codeChunk: "x", startLine: 1, endLine: 2 } as any })
        await Bun.write(abs, "x")

        spyOn(KiloIndexing, "ready").mockReturnValue(true)
        spyOn(KiloIndexing, "search").mockResolvedValue([result])

        const initialized = await SemanticSearchTool.init()
        const out = await initialized.execute({ query: "q" }, ctxStub({ ask: async () => {} }))

        const normalizedTmp = tmp.path.replace(/\\/g, "/")
        expect(out.output).not.toContain(normalizedTmp)
        expect(JSON.stringify(out.metadata)).not.toContain(normalizedTmp)
      },
    })
  })
})
