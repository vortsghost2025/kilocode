#!/usr/bin/env bun
import { commitEntries, revParse, stagedEntries } from "./lib/git"
import { loadProtectedPaths, loadScopeManifest } from "./lib/manifest"
import { Reporter } from "./lib/report"
import { diffScope } from "./lib/scope"

type Mode = "index" | "commit"

function args(values: string[]) {
  const scope = values.find((value) => !value.startsWith("--"))
  const flags = values.filter((value) => value.startsWith("--"))
  if (!scope) throw new Error("usage: staged-scope <wave-id> [--mode=index|commit]")
  if (flags.length > 1) throw new Error(`unexpected arguments: ${flags.join(" ")}`)
  const mode = flags[0]?.startsWith("--mode=") ? flags[0].slice("--mode=".length) : "index"
  if (mode !== "index" && mode !== "commit") throw new Error(`invalid mode: ${mode}`)
  if (flags[0] && !flags[0].startsWith("--mode=")) throw new Error(`unexpected argument: ${flags[0]}`)
  return { scope, mode: mode as Mode }
}

function detail(items: string[]) {
  return items.length ? items.join("\n") : "none"
}

export function verify(scope: string, mode: Mode, root = process.cwd()) {
  const report = new Reporter()
  try {
    const manifest = loadScopeManifest(scope, root)
    const rules = loadProtectedPaths(root)
    const observed = (() => {
      if (mode === "index") return stagedEntries(root)
      if (!manifest.commit || !manifest.parent) throw new Error(`scope ${scope} does not define a commit delta`)
      const parent = revParse(`${manifest.commit}^`, root)
      if (parent !== manifest.parent) {
        throw new Error(`scope parent mismatch: expected ${manifest.parent}, received ${parent}`)
      }
      return commitEntries(manifest.parent, manifest.commit, root)
    })()
    const paths = observed.flatMap((item) => item.paths)
    const result = diffScope({ scope: manifest.paths, staged: paths, protectedPaths: rules })
    report.section("OBSERVED PATHS", true, detail(observed.map((item) => `${item.status}\t${item.paths.join("\t")}`)))
    report.section("MISSING PATHS", result.missing.length === 0, detail(result.missing))
    report.section("EXTRA PATHS", result.extras.length === 0, detail(result.extras))
    report.section("PROTECTED PATHS", result.protected.length === 0, detail(result.protected))
    report.section("DUPLICATES", result.duplicates.length === 0, detail(result.duplicates))
    report.summary(result.pass, `STAGED SCOPE ${scope}`)
    return result.pass ? 0 : 1
  } catch (err) {
    report.section("VERIFICATION ERROR", false, err instanceof Error ? err.message : String(err))
    report.summary(false, `STAGED SCOPE ${scope}`)
    return 1
  }
}

export function main(values = process.argv.slice(2), root = process.cwd()) {
  try {
    const input = args(values)
    return verify(input.scope, input.mode, root)
  } catch (err) {
    const report = new Reporter()
    report.section("ARGUMENTS", false, err instanceof Error ? err.message : String(err))
    report.summary(false, "STAGED SCOPE UNKNOWN")
    return 1
  }
}

if (import.meta.main) process.exitCode = main()
