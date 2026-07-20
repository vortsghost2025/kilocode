// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { commitEntries, parseNameStatus } from "../../../../script/verify/lib/git"
import { loadScopeManifest, sha256File, type ProtectedPaths } from "../../../../script/verify/lib/manifest"
import { diffScope } from "../../../../script/verify/lib/scope"
import { verify } from "../../../../script/verify/staged-scope"
import { tmpdir } from "../fixture/fixture"

const names = [
  "START_HERE.md",
  "SYSTEM_INDEX.md",
  "SYSTEM_FLOW.md",
  "AGENT_REGISTRY.md",
  "AUTHORITY_MODEL.md",
  "TEST_MATRIX.md",
  "CHANGE_PROTOCOL.md",
] as const
const empty: ProtectedPaths = { exact: [], prefix: [] }

function run(dir: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

async function seed(dir: string, scope: Record<string, unknown>, rules: ProtectedPaths = empty) {
  await mkdir(path.join(dir, ".kilo", "scopes"), { recursive: true })
  for (const name of names) await Bun.write(path.join(dir, name), name)
  for (const item of scope.paths as string[]) {
    if (rules.exact.includes(item) || rules.prefix.some((prefix) => item.startsWith(prefix))) continue
    await Bun.write(path.join(dir, item), item)
  }
  const documents = Object.fromEntries(names.map((name) => [name, { sha256: sha256File(path.join(dir, name)) }]))
  await Bun.write(
    path.join(dir, "system-manifest.json"),
    JSON.stringify({
      mapVersion: 1,
      documents,
      scopes: {
        "wave-1a": ".kilo/scopes/wave-1a.json",
        "system-map-v1": ".kilo/scopes/system-map-v1.json",
      },
      protectedPaths: ".kilo/protected-paths.json",
      formatter: { name: "prettier", version: "3.6.2" },
      typecheck: {
        command: "cd packages/opencode && bun run typecheck",
        acceptedBaseline: [],
      },
      advisory: { modelRouting: "advisory", branch: "test" },
    }),
  )
  await Bun.write(path.join(dir, ".kilo", "protected-paths.json"), JSON.stringify(rules))
  await Bun.write(path.join(dir, ".kilo", "scopes", `${scope.id}.json`), JSON.stringify(scope))
}

describe("scope algebra", () => {
  test("exact staged set passes", () => {
    expect(diffScope({ scope: ["a", "b"], staged: ["b", "a"], protectedPaths: empty }).pass).toBe(true)
  })

  test("missing path fails", () => {
    expect(diffScope({ scope: ["a", "b"], staged: ["a"], protectedPaths: empty }).missing).toEqual(["b"])
  })

  test("extra path fails", () => {
    expect(diffScope({ scope: ["a"], staged: ["a", "b"], protectedPaths: empty }).extras).toEqual(["b"])
  })

  test("protected exact path fails", () => {
    const result = diffScope({ scope: ["a"], staged: ["a", "nul"], protectedPaths: { exact: ["nul"], prefix: [] } })
    expect(result.protected).toEqual(["nul"])
    expect(result.pass).toBe(false)
  })

  test("protected prefix path fails", () => {
    const result = diffScope({
      scope: ["a"],
      staged: ["a", ".planning/STATE.md"],
      protectedPaths: { exact: [], prefix: [".planning/"] },
    })
    expect(result.protected).toEqual([".planning/STATE.md"])
    expect(result.pass).toBe(false)
  })

  test("plan artifact path is protected", () => {
    const result = diffScope({
      scope: ["a"],
      staged: ["a", ".kilo/plans/example.md"],
      protectedPaths: { exact: [], prefix: [".kilo/plans/"] },
    })
    expect(result.protected).toEqual([".kilo/plans/example.md"])
    expect(result.pass).toBe(false)
  })

  test("duplicate staged path fails", () => {
    const result = diffScope({ scope: ["a"], staged: ["a", "a"], protectedPaths: empty })
    expect(result.duplicates).toEqual(["a"])
    expect(result.pass).toBe(false)
  })

  test("empty index reports all 42 paths missing", () => {
    const paths = Array.from({ length: 42 }, (_, index) => `path-${index}`)
    const result = diffScope({ scope: paths, staged: [], protectedPaths: empty })
    expect(result.missing).toHaveLength(42)
    expect(result.pass).toBe(false)
  })
})

describe("name-status parser", () => {
  test("parses added paths", () => {
    expect(parseNameStatus("A\0a.txt\0")).toEqual([{ status: "A", paths: ["a.txt"] }])
  })

  test("parses modified paths", () => {
    expect(parseNameStatus("M\0a.txt\0")).toEqual([{ status: "M", paths: ["a.txt"] }])
  })

  test("parses deleted paths", () => {
    expect(parseNameStatus("D\0a.txt\0")).toEqual([{ status: "D", paths: ["a.txt"] }])
  })

  test("parses type-changed paths", () => {
    expect(parseNameStatus("T\0a.txt\0")).toEqual([{ status: "T", paths: ["a.txt"] }])
  })

  test("parses rename old and new paths", () => {
    expect(parseNameStatus("R100\0old.txt\0new.txt\0")).toEqual([{ status: "R", paths: ["old.txt", "new.txt"] }])
  })

  test("parses copy old and new paths", () => {
    expect(parseNameStatus("C075\0old.txt\0new.txt\0")).toEqual([{ status: "C", paths: ["old.txt", "new.txt"] }])
  })

  test("rejects malformed status", () => {
    expect(() => parseNameStatus("X\0a.txt\0")).toThrow("unsupported name-status record")
  })

  test("rejects truncated rename", () => {
    expect(() => parseNameStatus("R100\0old.txt\0")).toThrow("truncated")
  })

  test("rejects empty paths and unterminated streams", () => {
    expect(() => parseNameStatus("A\0\0")).toThrow("empty")
    expect(() => parseNameStatus("A\0a.txt")).toThrow("missing NUL terminator")
  })

  test("normalization exposes duplicate paths", () => {
    const entries = parseNameStatus("A\0a//b.txt\0M\0a/b.txt\0")
    const result = diffScope({
      scope: ["a/b.txt"],
      staged: entries.flatMap((item) => item.paths),
      protectedPaths: empty,
    })
    expect(result.duplicates).toEqual(["a/b.txt"])
    expect(result.pass).toBe(false)
  })
})

describe("temporary repository verification", () => {
  test("index mode accepts an exact staged set", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path, { id: "system-map-v1", defaultMode: "index", paths: ["a.txt"] })
    run(tmp.path, ["add", "a.txt"])
    expect(verify("system-map-v1", "index", tmp.path)).toBe(0)
  })

  test("index mode rejects an empty index", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path, { id: "system-map-v1", defaultMode: "index", paths: ["a.txt"] })
    expect(verify("system-map-v1", "index", tmp.path)).toBe(1)
  })

  test("scope cannot list a protected path", async () => {
    await using tmp = await tmpdir({ git: true })
    const rules = { exact: ["secret.txt"], prefix: [] }
    await seed(tmp.path, { id: "system-map-v1", defaultMode: "index", paths: ["secret.txt"] }, rules)
    expect(() => loadScopeManifest("system-map-v1", tmp.path)).toThrow("scope contains protected path")
  })

  test("scope containing a plan artifact fails closed", async () => {
    await using tmp = await tmpdir({ git: true })
    const rules = { exact: [], prefix: [".kilo/plans/"] }
    await seed(tmp.path, { id: "system-map-v1", defaultMode: "index", paths: [".kilo/plans/example.md"] }, rules)
    expect(() => loadScopeManifest("system-map-v1", tmp.path)).toThrow("scope contains protected path")
  })

  test("index mode accepts an exact staged deletion", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "delete.txt"), "delete.txt")
    run(tmp.path, ["add", "delete.txt"])
    run(tmp.path, ["commit", "-m", "add deletion target"])
    await seed(tmp.path, { id: "system-map-v1", defaultMode: "index", paths: ["delete.txt"] })
    await rm(path.join(tmp.path, "delete.txt"))
    run(tmp.path, ["add", "delete.txt"])
    expect(verify("system-map-v1", "index", tmp.path)).toBe(0)
  })

  test("index mode rejects a protected staged deletion", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "secret.txt"), "secret.txt")
    run(tmp.path, ["add", "secret.txt"])
    run(tmp.path, ["commit", "-m", "add protected deletion target"])
    const rules = { exact: ["secret.txt"], prefix: [] }
    await seed(tmp.path, { id: "system-map-v1", defaultMode: "index", paths: ["secret.txt"] }, rules)
    await rm(path.join(tmp.path, "secret.txt"))
    run(tmp.path, ["add", "secret.txt"])
    expect(verify("system-map-v1", "index", tmp.path)).toBe(1)
  })

  test("commit mode accepts an exact historical delta", async () => {
    await using tmp = await tmpdir({ git: true })
    const parent = run(tmp.path, ["rev-parse", "HEAD"])
    await Bun.write(path.join(tmp.path, "a.txt"), "a.txt")
    run(tmp.path, ["add", "a.txt"])
    run(tmp.path, ["commit", "-m", "add a"])
    const commit = run(tmp.path, ["rev-parse", "HEAD"])
    await seed(tmp.path, { id: "wave-1a", defaultMode: "commit", commit, parent, paths: ["a.txt"] })
    expect(verify("wave-1a", "commit", tmp.path)).toBe(0)
  })

  test("commit mode rejects a missing scoped path", async () => {
    await using tmp = await tmpdir({ git: true })
    const parent = run(tmp.path, ["rev-parse", "HEAD"])
    await Bun.write(path.join(tmp.path, "a.txt"), "a.txt")
    run(tmp.path, ["add", "a.txt"])
    run(tmp.path, ["commit", "-m", "add a"])
    const commit = run(tmp.path, ["rev-parse", "HEAD"])
    await seed(tmp.path, { id: "wave-1a", defaultMode: "commit", commit, parent, paths: ["a.txt", "b.txt"] })
    expect(verify("wave-1a", "commit", tmp.path)).toBe(1)
  })

  test("commit mode rejects a protected observed path", async () => {
    await using tmp = await tmpdir({ git: true })
    const parent = run(tmp.path, ["rev-parse", "HEAD"])
    await Bun.write(path.join(tmp.path, "a.txt"), "a.txt")
    await Bun.write(path.join(tmp.path, "secret.txt"), "secret.txt")
    run(tmp.path, ["add", "a.txt", "secret.txt"])
    run(tmp.path, ["commit", "-m", "add protected"])
    const commit = run(tmp.path, ["rev-parse", "HEAD"])
    await seed(
      tmp.path,
      { id: "wave-1a", defaultMode: "commit", commit, parent, paths: ["a.txt"] },
      { exact: ["secret.txt"], prefix: [] },
    )
    expect(verify("wave-1a", "commit", tmp.path)).toBe(1)
  })

  test("commit collection uses the declared parent-to-commit delta", async () => {
    await using tmp = await tmpdir({ git: true })
    const parent = run(tmp.path, ["rev-parse", "HEAD"])
    await Bun.write(path.join(tmp.path, "a.txt"), "a.txt")
    run(tmp.path, ["add", "a.txt"])
    run(tmp.path, ["commit", "-m", "add a"])
    await Bun.write(path.join(tmp.path, "b.txt"), "b.txt")
    run(tmp.path, ["add", "b.txt"])
    run(tmp.path, ["commit", "-m", "add b"])
    const commit = run(tmp.path, ["rev-parse", "HEAD"])
    const paths = commitEntries(parent, commit, tmp.path).flatMap((item) => item.paths)
    expect(paths.sort()).toEqual(["a.txt", "b.txt"])
  })

  test("missing manifest fails closed", async () => {
    await using tmp = await tmpdir({ git: true })
    expect(verify("system-map-v1", "index", tmp.path)).toBe(1)
  })

  test("unknown scope id fails closed", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path, { id: "system-map-v1", defaultMode: "index", paths: ["a.txt"] })
    expect(verify("unknown", "index", tmp.path)).toBe(1)
  })
})
