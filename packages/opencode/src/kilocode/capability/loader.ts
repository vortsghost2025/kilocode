import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Glob } from "@/util/glob"
import { CapabilityManifest } from "./manifest"

export namespace CapabilityLoader {
  export const Directory = ".kilo/capabilities/manifests"

  export const Issue = z
    .object({
      path: z.string(),
      code: z.string(),
    })
    .strict()
  export type Issue = z.infer<typeof Issue>

  export const Failure = z
    .object({
      source: z.string(),
      kind: z.enum(["json", "schema", "duplicate-agent", "discovery"]),
      issues: z.array(Issue),
    })
    .strict()
  export type Failure = z.infer<typeof Failure>

  export const Entry = z
    .object({
      source: z.string(),
      manifest: CapabilityManifest.Schema,
    })
    .strict()
  export type Entry = z.infer<typeof Entry>

  export const Result = z
    .object({
      root: z.string(),
      directory: z.string(),
      files: z.array(z.string()),
      manifests: z.array(Entry),
      failures: z.array(Failure),
      duplicateAgentIDs: z.array(z.string()),
    })
    .strict()
  export type Result = z.infer<typeof Result>

  const Identity = z.object({ agent: z.object({ id: z.string().min(1) }) })

  function order(a: string, b: string) {
    if (a < b) return -1
    if (a > b) return 1
    return 0
  }

  function empty(root: string, directory: string): Result {
    return Result.parse({ root, directory, files: [], manifests: [], failures: [], duplicateAgentIDs: [] })
  }

  function failed(root: string, directory: string, code: string): Result {
    return Result.parse({
      root,
      directory,
      files: [],
      manifests: [],
      duplicateAgentIDs: [],
      failures: [{ source: directory, kind: "discovery", issues: [{ path: "$", code }] }],
    })
  }

  export async function load(input: { root: string }): Promise<Result> {
    const root = path.resolve(input.root)
    const directory = path.join(root, Directory)
    const dir = await lstat(directory).then(
      (value) => ({ status: "found" as const, value }),
      (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? { status: "missing" as const } : { status: "failed" as const },
    )
    if (dir.status === "missing") return empty(root, directory)
    if (dir.status === "failed") return failed(root, directory, "unreadable_directory")
    if (!dir.value.isDirectory() || dir.value.isSymbolicLink()) return failed(root, directory, "unsafe_directory")

    const canonical = await Promise.all([realpath(root), realpath(directory)]).then(
      ([base, target]) => ({ success: true as const, base, target }),
      () => ({ success: false as const }),
    )
    if (!canonical.success) return failed(root, directory, "unreadable_directory")
    if (path.resolve(canonical.base, Directory) !== canonical.target) return failed(root, directory, "unsafe_directory")

    const discovered = await Glob.scan("**/*.json", { cwd: directory, absolute: true }).then(
      (files) => ({ success: true as const, files: files.toSorted() }),
      () => ({ success: false as const, files: [] as string[] }),
    )
    if (!discovered.success) return failed(root, directory, "unreadable_directory")

    const candidates: Entry[] = []
    const failures: Failure[] = []
    const identities = new Map<string, string[]>()
    for (const source of discovered.files) {
      const stat = await lstat(source).then(
        (value) => ({ success: true as const, value }),
        () => ({ success: false as const }),
      )
      if (!stat.success || !stat.value.isFile() || stat.value.isSymbolicLink()) {
        failures.push({ source, kind: "discovery", issues: [{ path: "$", code: "unsafe_manifest_path" }] })
        continue
      }

      const json = await Bun.file(source).json().then(
        (value: unknown) => ({ success: true as const, value }),
        () => ({ success: false as const }),
      )
      if (!json.success) {
        failures.push({ source, kind: "json", issues: [{ path: "$", code: "invalid_json" }] })
        continue
      }

      const identity = Identity.safeParse(json.value)
      if (identity.success) {
        const sources = identities.get(identity.data.agent.id) ?? []
        sources.push(source)
        identities.set(identity.data.agent.id, sources)
      }

      const parsed = CapabilityManifest.Schema.safeParse(json.value)
      if (!parsed.success) {
        failures.push({
          source,
          kind: "schema",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.length ? issue.path.join(".") : "$",
            code: issue.code,
          })),
        })
        continue
      }
      candidates.push({ source, manifest: parsed.data })
    }

    const duplicateAgentIDs = [...identities.entries()]
      .filter(([, sources]) => sources.length > 1)
      .map(([agent]) => agent)
      .toSorted()
    const duplicates = new Set(duplicateAgentIDs)
    for (const agent of duplicateAgentIDs) {
      for (const source of identities.get(agent) ?? []) {
        failures.push({
          source,
          kind: "duplicate-agent",
          issues: [{ path: "agent.id", code: "duplicate_agent" }],
        })
      }
    }

    return Result.parse({
      root,
      directory,
      files: discovered.files,
      manifests: candidates.filter((entry) => !duplicates.has(entry.manifest.agent.id)),
      failures: failures.toSorted((a, b) => order(a.source, b.source) || order(a.kind, b.kind)),
      duplicateAgentIDs,
    })
  }
}
