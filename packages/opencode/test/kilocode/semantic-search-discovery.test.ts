import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

const CONFIRMED_TOOLS = ["read", "glob", "grep"]
const root = path.resolve(import.meta.dir, "../..")

afterEach(async () => {
  await Instance.disposeAll()
})

describe("semantic_search discovery", () => {
  test("indexing config absent omits semantic_search while preserving unrelated tools", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).not.toContain("semantic_search")
        for (const id of CONFIRMED_TOOLS) expect(ids).toContain(id)
      },
    })
  })

  test("indexing enabled false omits semantic_search while preserving unrelated tools", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: false } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).not.toContain("semantic_search")
        for (const id of CONFIRMED_TOOLS) expect(ids).toContain(id)
      },
    })
  })

  test("indexing enabled true includes semantic_search while preserving unrelated tools", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "ollama" } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("semantic_search")
        for (const id of CONFIRMED_TOOLS) expect(ids).toContain(id)
      },
    })
  })

  test("indexing module rejection omits only semantic_search", async () => {
    const result = await child("indexing")
    expect(result.code).toBe(0)
    expect(result.data.error).toBeNull()
    expect(result.data.bootstrap).toMatchObject({ replacements: 1 })
    expect(result.data.indexing).toMatchObject({ fired: true })
    expect(result.data.tripwire).toBeNull()
    expect(result.data.ready).toBeNull()
    expect(result.data.search).toBeNull()
    expect(result.data.ids).not.toContain("semantic_search")
    for (const id of CONFIRMED_TOOLS) expect(result.data.ids).toContain(id)
  }, 20_000)

  test("semantic-search module rejection omits only semantic_search", async () => {
    const result = await child("tool")
    expect(result.code).toBe(0)
    expect(result.data.error).toBeNull()
    expect(result.data.tool).toMatchObject({ fired: true })
    expect(result.data.ids).not.toContain("semantic_search")
    for (const id of CONFIRMED_TOOLS) expect(result.data.ids).toContain(id)
  }, 20_000)
})

type ChildResult = {
  code: number
  data: {
    ids: string[]
    error: string | null
    bootstrap: { replacements: number } | null
    indexing: { fired: boolean } | null
    tool: { fired: boolean } | null
    tripwire: { fired: boolean } | null
    ready: string | null
    search: string | null
  }
}

async function child(mode: "indexing" | "tool"): Promise<ChildResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-search-discovery-"))
  const markers = path.join(dir, "markers")
  await fs.mkdir(markers)

  const src = path.join(root, "src").replaceAll("\\", "/")
  const tests = path.join(root, "test").replaceAll("\\", "/")
  const expected = {
    bootstrap: path.resolve(root, "src/project/bootstrap.ts"),
    indexing: path.resolve(root, "src/kilocode/indexing.ts"),
    tool: path.resolve(root, "src/kilocode/tool/semantic-search.ts"),
  }

  const cfg = {
    compilerOptions: {
      baseUrl: root.replaceAll("\\", "/"),
      paths: {
        "@/*": [`${src}/*`],
        "@test/*": [`${tests}/*`],
      },
    },
  }

  const loader = `
import { plugin } from "bun"
import fs from "node:fs"
import path from "node:path"

const mode = process.env.MODE
const markers = process.env.MARKERS
const expected = ${JSON.stringify(expected)}
const same = (left, right) => path.resolve(left) === path.resolve(right)

plugin({
  name: "semantic-search-import-failure",
  setup(build) {
    build.onLoad({ filter: /bootstrap\\.ts$/ }, async (args) => {
      const source = fs.readFileSync(args.path, "utf8")
      if (mode !== "indexing" || !same(args.path, expected.bootstrap)) return { loader: "ts", contents: source }
      const target = 'import { KiloIndexing } from "@/kilocode/indexing"'
      const replacements = source.split(target).length - 1
      const contents = source.replace(target, "const KiloIndexing = { init: async () => {} }")
      fs.writeFileSync(path.join(markers, "bootstrap.json"), JSON.stringify({ fired: true, path: args.path, replacements }))
      return { loader: "ts", contents }
    })

    build.onLoad({ filter: /indexing\\.ts$/ }, async (args) => {
      const source = fs.readFileSync(args.path, "utf8")
      if (mode !== "indexing" || !same(args.path, expected.indexing)) return { loader: "ts", contents: source }
      fs.writeFileSync(path.join(markers, "indexing.json"), JSON.stringify({ fired: true, path: args.path }))
      return {
        loader: "js",
        contents: [
          'import fs from "node:fs"',
          "export const KiloIndexing = {",
          '  ready() { fs.writeFileSync(process.env.READY, "called"); throw new Error("KiloIndexing.ready must not execute") },',
          '  async search() { fs.writeFileSync(process.env.SEARCH, "called"); throw new Error("KiloIndexing.search must not execute") },',
          "}",
          'throw new Error("indexing-import-rejected")',
        ].join("\\n"),
      }
    })

    build.onLoad({ filter: /semantic-search\\.ts$/ }, async (args) => {
      const source = fs.readFileSync(args.path, "utf8")
      if (!same(args.path, expected.tool)) return { loader: "ts", contents: source }
      const name = mode === "indexing" ? "tripwire.json" : "tool.json"
      fs.writeFileSync(path.join(markers, name), JSON.stringify({ fired: true, path: args.path }))
      return { loader: "js", contents: 'throw new Error("semantic-search-module-rejected")' }
    })
  },
})
`

  const script = `
import fs from "node:fs/promises"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "@/tool/registry"
import { tmpdir } from "@test/fixture/fixture"

const readJSON = async (name) => fs.readFile(process.env.MARKERS + "/" + name, "utf8").then(JSON.parse).catch(() => null)
const readText = async (name) => fs.readFile(name, "utf8").catch(() => null)
await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "ollama" } } })
await Instance.provide({
  directory: tmp.path,
  fn: async () => {
    let ids = []
    let error = null
    try { ids = await ToolRegistry.ids() } catch (err) { error = err instanceof Error ? err.message : String(err) }
    console.log(JSON.stringify({
      ids,
      error,
      bootstrap: await readJSON("bootstrap.json"),
      indexing: await readJSON("indexing.json"),
      tool: await readJSON("tool.json"),
      tripwire: await readJSON("tripwire.json"),
      ready: await readText(process.env.READY),
      search: await readText(process.env.SEARCH),
    }))
  },
})
`

  try {
    await Bun.write(path.join(dir, "tsconfig.json"), JSON.stringify(cfg))
    await Bun.write(path.join(dir, "loader.ts"), loader)
    await Bun.write(path.join(dir, "child.ts"), script)
    const proc = Bun.spawn({
      cmd: [process.execPath, "--cwd", dir, "--preload", path.join(dir, "loader.ts"), path.join(dir, "child.ts")],
      cwd: dir,
      env: {
        ...process.env,
        MODE: mode,
        MARKERS: markers,
        READY: path.join(dir, "ready.txt"),
        SEARCH: path.join(dir, "search.txt"),
      },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if (code !== 0) throw new Error(`child failed (${code}): ${stderr}`)
    const line = stdout
      .split("\n")
      .map((item) => item.trim())
      .findLast((item) => item.startsWith("{"))
    if (!line) throw new Error(`child produced no JSON: ${stdout}\n${stderr}`)
    return { code, data: JSON.parse(line) }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
