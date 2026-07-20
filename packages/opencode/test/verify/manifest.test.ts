// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  ProtectedPathsSchema,
  RootManifestSchema,
  ScopeManifestSchema,
  loadRootManifest,
  normalizePath,
  sha256File,
} from "../../../../script/verify/lib/manifest"
import { classifyTypecheck } from "../../../../script/verify/wave-1a"
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

function root() {
  const hash = "a".repeat(64)
  return {
    mapVersion: 1,
    documents: Object.fromEntries(names.map((name) => [name, { sha256: hash }])),
    scopes: {
      "wave-1a": ".kilo/scopes/wave-1a.json",
      "system-map-v1": ".kilo/scopes/system-map-v1.json",
    },
    protectedPaths: ".kilo/protected-paths.json",
    formatter: { name: "prettier", version: "3.6.2" },
    typecheck: {
      command: "cd packages/opencode && bun run typecheck",
      acceptedBaseline: ["src/example.ts(1,1)"],
    },
    advisory: { modelRouting: "advisory", branch: "test" },
  }
}

function scope() {
  return { id: "wave-1a", defaultMode: "index", paths: ["a.ts"] }
}

async function writeRoot(dir: string, wrong = false) {
  for (const name of names) await Bun.write(path.join(dir, name), name)
  const manifest = root()
  for (const name of names) manifest.documents[name].sha256 = sha256File(path.join(dir, name))
  if (wrong) manifest.documents["START_HERE.md"].sha256 = "0".repeat(64)
  await Bun.write(path.join(dir, "system-manifest.json"), JSON.stringify(manifest))
}

describe("root manifest", () => {
  test("valid manifest parses", () => {
    expect(RootManifestSchema.safeParse(root()).success).toBe(true)
  })

  test("missing mapVersion fails", () => {
    const manifest = root() as Record<string, unknown>
    delete manifest.mapVersion
    expect(RootManifestSchema.safeParse(manifest).success).toBe(false)
  })

  test("non-64-hex document digest fails", () => {
    const manifest = root()
    manifest.documents["START_HERE.md"].sha256 = "abc"
    expect(RootManifestSchema.safeParse(manifest).success).toBe(false)
  })

  test("missing document fails closed", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "system-manifest.json"), JSON.stringify(root()))
    expect(() => loadRootManifest(tmp.path)).toThrow("file is missing")
  })

  test("wrong document digest fails closed", async () => {
    await using tmp = await tmpdir()
    await writeRoot(tmp.path, true)
    expect(() => loadRootManifest(tmp.path)).toThrow("document hash mismatch")
  })

  test("non-lowercase scope id fails", () => {
    expect(ScopeManifestSchema.safeParse({ ...scope(), id: "Wave-1A" }).success).toBe(false)
  })

  test("missing protectedPaths reference fails", () => {
    const manifest = root() as Record<string, unknown>
    delete manifest.protectedPaths
    expect(RootManifestSchema.safeParse(manifest).success).toBe(false)
  })
})

describe("path normalization", () => {
  test("normalizes backslashes", () => {
    expect(normalizePath("foo\\bar.ts")).toBe("foo/bar.ts")
  })

  test("removes one leading dot segment", () => {
    expect(normalizePath("./foo/bar.ts")).toBe("foo/bar.ts")
  })

  test("rejects drive paths", () => {
    expect(() => normalizePath("C:/x")).toThrow("drive path")
  })

  test("rejects parent traversal", () => {
    expect(() => normalizePath("..")).toThrow()
    expect(() => normalizePath("../x")).toThrow()
  })

  test("preserves literal nul", () => {
    expect(normalizePath("nul")).toBe("nul")
  })

  test("rejects empty input", () => {
    expect(() => normalizePath("  ")).toThrow()
  })

  test("collapses duplicate slashes", () => {
    expect(normalizePath("a//b")).toBe("a/b")
  })
})

describe("scope manifest", () => {
  test("rejects normalized duplicate paths", () => {
    expect(ScopeManifestSchema.safeParse({ ...scope(), paths: ["a//b", "a/b"] }).success).toBe(false)
  })

  test("rejects a 39-character commit", () => {
    expect(ScopeManifestSchema.safeParse({ ...scope(), commit: "a".repeat(39), parent: "b".repeat(40) }).success).toBe(
      false,
    )
  })

  test("rejects uppercase blocklist SHA", () => {
    expect(ScopeManifestSchema.safeParse({ ...scope(), badCommitBlocklist: ["A".repeat(40)] }).success).toBe(false)
  })

  test("rejects protected prefix without trailing slash", () => {
    expect(ProtectedPathsSchema.safeParse({ exact: [], prefix: [".planning"] }).success).toBe(false)
  })

  test("accepts protected directory prefix", () => {
    expect(ProtectedPathsSchema.safeParse({ exact: ["nul"], prefix: [".planning/"] }).success).toBe(true)
  })

  test("accepts canonical commit-mode string", () => {
    const manifest = {
      ...scope(),
      modes: { index: "diff --cached --name-status -z", commit: "diff --name-status -z <parent> <commit>" },
    }
    expect(ScopeManifestSchema.safeParse(manifest).success).toBe(true)
  })

  test("rejects obsolete diff-tree commit-mode string", () => {
    const manifest = {
      ...scope(),
      modes: { index: "diff --cached --name-status -z", commit: "diff-tree --name-only -r <parent>..<commit>" },
    }
    expect(ScopeManifestSchema.safeParse(manifest).success).toBe(false)
  })
})

describe("typecheck classification", () => {
  const expected = ["src/a.ts(1,2)", "test/b.ts(3,4)", "test/b.ts(5,6)"]
  const diagnostics = [
    "src/a.ts(1,2): error TS1000: first",
    "test/b.ts(3,4): error TS2000: second",
    "test/b.ts(5,6): error TS3000: third",
  ]
  const output = ["$ tsgo --noEmit", ...diagnostics].join("\n")

  test("accepts exactly three baseline diagnostics with nonzero exit", () => {
    expect(classifyTypecheck({ exitCode: 1, output, expected }).pass).toBe(true)
  })

  test("rejects one extra TypeScript diagnostic", () => {
    const extra = `${output}\nother.ts(7,8): error TS4000: extra`
    expect(classifyTypecheck({ exitCode: 1, output: extra, expected }).pass).toBe(false)
  })

  test("rejects exact diagnostics plus unrelated fatal text", () => {
    expect(classifyTypecheck({ exitCode: 1, output: `${output}\nfatal: crashed`, expected }).pass).toBe(false)
  })

  test("rejects no diagnostics with zero exit", () => {
    expect(classifyTypecheck({ exitCode: 0, output: "$ tsgo --noEmit", expected }).pass).toBe(false)
  })

  test("rejects command failure without diagnostics", () => {
    expect(classifyTypecheck({ exitCode: 127, output: "command not found", expected }).pass).toBe(false)
  })
})
