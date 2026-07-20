import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { z } from "zod"

const sha = z.string().regex(/^[0-9a-f]{40}$/)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ManifestError"
  }
}

export function normalizePath(input: string) {
  const value = input.trim()
  if (!value || value.includes("\0")) throw new ManifestError("path is empty or contains NUL")
  const slashes = value.replaceAll("\\", "/")
  if (slashes.startsWith("//")) throw new ManifestError(`UNC path is not repository-relative: ${input}`)
  if (/^[A-Za-z]:\//.test(slashes)) throw new ManifestError(`drive path is not repository-relative: ${input}`)
  if (slashes.startsWith("/")) throw new ManifestError(`absolute path is not repository-relative: ${input}`)
  const collapsed = slashes.replace(/\/{2,}/g, "/")
  const relative = collapsed.startsWith("./") ? collapsed.slice(2) : collapsed
  const parts = relative.split("/")
  if (!relative || relative === "." || relative === ".." || parts.includes(".") || parts.includes("..")) {
    throw new ManifestError(`invalid repository-relative path: ${input}`)
  }
  return relative
}

const repoPath = z.string().transform((value, ctx) => {
  try {
    return normalizePath(value)
  } catch (err) {
    ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : String(err) })
    return z.NEVER
  }
})

const formatter = z
  .object({
    name: z.literal("prettier"),
    version: z.literal("3.6.2"),
  })
  .strict()

const typecheck = z
  .object({
    command: z.literal("cd packages/opencode && bun run typecheck"),
    acceptedBaseline: z.array(z.string().min(1)),
  })
  .strict()

const record = z
  .object({
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
  })
  .strict()

const live = z
  .object({
    pass: z.number().int().nonnegative(),
    fail: z.literal(0),
  })
  .strict()

const document = z.object({ sha256: digest }).strict()

export const RootManifestSchema = z
  .object({
    mapVersion: z.number().int().positive(),
    documents: z
      .object({
        "START_HERE.md": document,
        "SYSTEM_INDEX.md": document,
        "SYSTEM_FLOW.md": document,
        "AGENT_REGISTRY.md": document,
        "AUTHORITY_MODEL.md": document,
        "TEST_MATRIX.md": document,
        "CHANGE_PROTOCOL.md": document,
      })
      .strict(),
    scopes: z
      .object({
        "wave-1a": z.literal(".kilo/scopes/wave-1a.json"),
        "system-map-v1": z.literal(".kilo/scopes/system-map-v1.json"),
      })
      .strict(),
    protectedPaths: z.literal(".kilo/protected-paths.json"),
    formatter,
    typecheck,
    advisory: z
      .object({
        modelRouting: z.string().min(1),
        branch: z.string().min(1),
      })
      .strict(),
  })
  .strict()

export const ProtectedPathsSchema = z
  .object({
    exact: z.array(repoPath).superRefine((items, ctx) => {
      if (new Set(items).size === items.length) return
      ctx.addIssue({ code: "custom", message: "protected exact paths contain duplicates" })
    }),
    prefix: z
      .array(
        repoPath.refine((item) => item.endsWith("/"), {
          message: "protected prefix paths must end with /",
        }),
      )
      .superRefine((items, ctx) => {
        if (new Set(items).size === items.length) return
        ctx.addIssue({ code: "custom", message: "protected prefix paths contain duplicates" })
      }),
  })
  .strict()

export const ScopeManifestSchema = z
  .object({
    id,
    modes: z
      .object({
        index: z.literal("diff --cached --name-status -z"),
        commit: z.literal("diff --name-status -z <parent> <commit>"),
      })
      .strict()
      .optional(),
    defaultMode: z.enum(["index", "commit"]),
    commit: sha.optional(),
    parent: sha.optional(),
    badCommitBlocklist: z.array(sha).optional(),
    formatter: formatter.optional(),
    typecheck: typecheck.optional(),
    testMatrix: z.array(repoPath).optional(),
    historicalExpected: record.optional(),
    liveMinimum: live.optional(),
    paths: z.array(repoPath).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.commit === undefined) !== (value.parent === undefined)) {
      ctx.addIssue({ code: "custom", message: "commit and parent must be declared together" })
    }
    if (value.defaultMode === "commit" && (!value.commit || !value.parent)) {
      ctx.addIssue({ code: "custom", message: "commit mode requires commit and parent" })
    }
    if (value.testMatrix?.length && (!value.historicalExpected || !value.liveMinimum)) {
      ctx.addIssue({ code: "custom", message: "test matrices require historicalExpected and liveMinimum" })
    }
    if (new Set(value.paths).size !== value.paths.length) {
      ctx.addIssue({ code: "custom", message: "scope paths contain duplicates" })
    }
    if (value.badCommitBlocklist && new Set(value.badCommitBlocklist).size !== value.badCommitBlocklist.length) {
      ctx.addIssue({ code: "custom", message: "badCommitBlocklist contains duplicates" })
    }
  })

export type RootManifest = z.infer<typeof RootManifestSchema>
export type ProtectedPaths = z.infer<typeof ProtectedPathsSchema>
export type ScopeManifest = z.infer<typeof ScopeManifestSchema>

function read<T>(file: string, schema: z.ZodType<T>) {
  if (!existsSync(file)) throw new ManifestError(`manifest is missing: ${file}`)
  const text = readFileSync(file, "utf8")
  const value = (() => {
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new ManifestError(
        `manifest is not strict JSON: ${file}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })()
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const detail = result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")
  throw new ManifestError(`manifest validation failed: ${file}: ${detail}`)
}

export function sha256File(file: string) {
  if (!existsSync(file)) throw new ManifestError(`file is missing: ${file}`)
  return new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex")
}

export function loadRootManifest(root = process.cwd()) {
  const manifest = read(path.resolve(root, "system-manifest.json"), RootManifestSchema)
  for (const [name, expected] of Object.entries(manifest.documents)) {
    const file = path.resolve(root, name)
    const actual = sha256File(file)
    if (actual !== expected.sha256) {
      throw new ManifestError(`document hash mismatch: ${name}: expected ${expected.sha256}, received ${actual}`)
    }
  }
  return manifest
}

export function loadProtectedPaths(root = process.cwd()) {
  return read(path.resolve(root, ".kilo/protected-paths.json"), ProtectedPathsSchema)
}

function protectedPath(item: string, rules: ProtectedPaths) {
  return rules.exact.includes(item) || rules.prefix.some((prefix) => item.startsWith(prefix))
}

export function loadScopeManifest(scope: string, root = process.cwd()) {
  const parsed = id.safeParse(scope)
  if (!parsed.success) throw new ManifestError(`invalid scope id: ${scope}`)
  const manifest = loadRootManifest(root)
  const ref = manifest.scopes[parsed.data as keyof typeof manifest.scopes]
  if (!ref) throw new ManifestError(`unknown scope id: ${scope}`)
  const result = read(path.resolve(root, ref), ScopeManifestSchema)
  if (result.id !== scope) throw new ManifestError(`scope id mismatch: expected ${scope}, received ${result.id}`)
  const rules = loadProtectedPaths(root)
  const hit = result.paths.find((item) => protectedPath(item, rules))
  if (hit) throw new ManifestError(`scope contains protected path: ${hit}`)
  return result
}

export function resolvePrettier(root = process.cwd()) {
  const local = path.resolve(root, "node_modules/prettier/bin/prettier.cjs")
  const homes = [process.env.HOME, process.env.USERPROFILE]
    .filter((item): item is string => !!item)
    .map((item) => path.resolve(item, ".bun/install/cache"))
  const installs = process.env.BUN_INSTALL ? [path.resolve(process.env.BUN_INSTALL, "install/cache")] : []
  const dirs = [...new Set([...homes, ...installs])]
  const cached = dirs
    .flatMap((dir) => {
      if (!existsSync(dir)) return []
      try {
        return readdirSync(dir)
          .filter((name) => /^prettier@3\.6\.2@@@\d+$/.test(name))
          .map((name) => path.resolve(dir, name, "bin/prettier.cjs"))
      } catch (err) {
        void err
        return []
      }
    })
    .sort()
  const candidates = [local, ...cached].filter((file) => existsSync(file))
  for (const file of candidates) {
    const result = Bun.spawnSync([process.execPath, file, "--version"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    if (result.exitCode !== 0) continue
    if (new TextDecoder().decode(result.stdout).trim() !== "3.6.2") continue
    return { path: file, version: "3.6.2" as const }
  }
  return null
}
