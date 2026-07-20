#!/usr/bin/env bun
import { existsSync } from "node:fs"
import path from "node:path"
import { commitEntries, diffCheck, isAncestor, revParse, statusShort } from "./lib/git"
import { loadProtectedPaths, loadRootManifest, loadScopeManifest, normalizePath, resolvePrettier } from "./lib/manifest"
import { Reporter } from "./lib/report"
import { diffScope } from "./lib/scope"

function detail(items: string[]) {
  return items.length ? items.join("\n") : "none"
}

function spawn(command: string[], cwd: string) {
  return Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
}

function text(result: ReturnType<typeof Bun.spawnSync>) {
  const decoder = new TextDecoder()
  return `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

function counts(output: string) {
  const passes = [...output.matchAll(/^\s*(\d+)\s+pass\s*$/gm)]
  const failures = [...output.matchAll(/^\s*(\d+)\s+fail\s*$/gm)]
  if (!passes.length || !failures.length) throw new Error("unable to parse Bun test pass/fail summary")
  return { pass: Number(passes.at(-1)?.[1]), fail: Number(failures.at(-1)?.[1]) }
}

function diagnostic(line: string) {
  const tuple = line.match(/^(.+?)\((\d+),(\d+)\): error TS\d+: .+$/)
  const colon = line.match(/^(.+?):(\d+):(\d+)(?: -)? error TS\d+: .+$/)
  const match = tuple ?? colon
  if (!match) return null
  try {
    return `${normalizePath(match[1])}(${match[2]},${match[3]})`
  } catch (err) {
    void err
    return null
  }
}

function same(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

export function classifyTypecheck(input: { exitCode: number; output: string; expected: string[] }) {
  const lines = input.output.split(/\r?\n/).filter((line) => line.trim())
  const parsed = lines.map((line) => ({ line, diagnostic: diagnostic(line) }))
  const banners = parsed.filter((item) => item.line === "$ tsgo --noEmit")
  const diagnostics = parsed.flatMap((item) => (item.diagnostic ? [item.diagnostic] : [])).sort()
  const expected = [...input.expected].sort()
  const unrelated = parsed
    .filter((item) => item.line !== "$ tsgo --noEmit" && !item.diagnostic)
    .map((item) => item.line)
  const missing = expected.filter((item) => !diagnostics.includes(item))
  const unexpected = diagnostics.filter((item) => !expected.includes(item))
  const pass = input.exitCode !== 0 && banners.length === 1 && unrelated.length === 0 && same(diagnostics, expected)
  return { pass, diagnostics, missing, unexpected, unrelated }
}

export function main(root = process.cwd()) {
  const report = new Reporter()
  const checks: boolean[] = []
  const start = (() => {
    try {
      return statusShort(root)
    } catch (err) {
      report.section("INITIAL STATUS", false, err instanceof Error ? err.message : String(err))
      checks.push(false)
      return null
    }
  })()

  try {
    const manifest = loadRootManifest(root)
    const scope = loadScopeManifest("wave-1a", root)
    const rules = loadProtectedPaths(root)
    if (!scope.commit || !scope.parent || !scope.formatter || !scope.typecheck) {
      throw new Error("Wave 1A scope is missing commit, parent, formatter, or typecheck metadata")
    }
    if (!scope.testMatrix?.length || !scope.historicalExpected || !scope.liveMinimum) {
      throw new Error("Wave 1A scope is missing its test evidence contract")
    }
    const metadata =
      manifest.mapVersion === 1 &&
      manifest.formatter.version === scope.formatter.version &&
      same([...manifest.typecheck.acceptedBaseline].sort(), [...scope.typecheck.acceptedBaseline].sort())
    report.section("MANIFESTS", metadata, `map version ${manifest.mapVersion}; scope ${scope.id}`)
    checks.push(metadata)

    const commit = revParse(scope.commit, root)
    const parent = revParse(`${scope.commit}^`, root)
    const head = revParse("HEAD", root)
    const ancestor = isAncestor(scope.commit, head, root)
    const blocked = (scope.badCommitBlocklist ?? []).filter((item) => isAncestor(item, head, root))
    const ancestry = commit === scope.commit && parent === scope.parent && ancestor && blocked.length === 0
    report.section(
      "ANCESTRY",
      ancestry,
      [
        `commit ${commit}`,
        `parent ${parent}`,
        `head ${head}`,
        `blocked ancestors ${blocked.length ? blocked.join(", ") : "none"}`,
      ].join("\n"),
    )
    checks.push(ancestry)

    const entries = commitEntries(scope.parent, scope.commit, root)
    const paths = entries.flatMap((item) => item.paths)
    const delta = diffScope({ scope: scope.paths, staged: paths, protectedPaths: rules })
    const pathPass = delta.missing.length === 0 && delta.extras.length === 0 && delta.duplicates.length === 0
    report.section(
      "COMMIT PATHS",
      pathPass,
      [
        `missing: ${detail(delta.missing)}`,
        `extra: ${detail(delta.extras)}`,
        `duplicates: ${detail(delta.duplicates)}`,
      ].join("\n"),
    )
    checks.push(pathPass)
    const protectedPass = delta.protected.length === 0
    report.section("PROTECTED PATHS", protectedPass, detail(delta.protected))
    checks.push(protectedPass)

    const historical = scope.historicalExpected.pass === 199 && scope.historicalExpected.fail === 0
    const files = scope.testMatrix.map((file) => path.resolve(root, "packages/opencode", file))
    const missing = files.filter((file) => !existsSync(file))
    if (missing.length) throw new Error(`test matrix files are missing: ${missing.join(", ")}`)
    const tests = spawn(["bun", "test", ...scope.testMatrix], path.resolve(root, "packages/opencode"))
    const result = counts(text(tests))
    const live = tests.exitCode === 0 && result.fail === scope.liveMinimum.fail && result.pass >= scope.liveMinimum.pass
    const testPass = historical && live
    report.section(
      "TEST MATRIX",
      testPass,
      [
        `historical evidence: ${scope.historicalExpected.pass} pass, ${scope.historicalExpected.fail} fail (${historical ? "PASS" : "FAIL"})`,
        `live regression: ${result.pass} pass, ${result.fail} fail (${live ? "PASS" : "FAIL"})`,
      ].join("\n"),
    )
    checks.push(testPass)

    const check = spawn(["bun", "run", "typecheck"], path.resolve(root, "packages/opencode"))
    const typecheck = classifyTypecheck({
      exitCode: check.exitCode,
      output: text(check),
      expected: scope.typecheck.acceptedBaseline,
    })
    report.section(
      "TYPECHECK",
      typecheck.pass,
      [
        `exit code: ${check.exitCode}`,
        `accepted diagnostics: ${typecheck.diagnostics.length}`,
        `missing: ${detail(typecheck.missing)}`,
        `unexpected: ${detail(typecheck.unexpected)}`,
        `unrelated output: ${detail(typecheck.unrelated)}`,
      ].join("\n"),
    )
    checks.push(typecheck.pass)

    const prettier = resolvePrettier(root)
    const formatPaths = scope.paths.filter((file) => /\.(?:ts|jsonc)$/.test(file))
    const format = prettier ? spawn([process.execPath, prettier.path, "--check", ...formatPaths], root) : null
    const formatPass = !!prettier && format?.exitCode === 0
    report.section(
      "FORMATTER",
      formatPass,
      prettier
        ? `${prettier.path}\nversion ${prettier.version}`
        : "Prettier 3.6.2 was not found in approved local locations",
    )
    checks.push(formatPass)

    const whitespace = diffCheck(scope.parent, scope.commit, scope.paths, root)
    report.section(
      "WHITESPACE",
      whitespace,
      whitespace ? "historical delta is clean" : "historical delta has whitespace errors",
    )
    checks.push(whitespace)
  } catch (err) {
    report.section("VERIFICATION ERROR", false, err instanceof Error ? err.message : String(err))
    checks.push(false)
  }

  const end = (() => {
    try {
      return statusShort(root)
    } catch (err) {
      report.section("FINAL STATUS", false, err instanceof Error ? err.message : String(err))
      checks.push(false)
      return null
    }
  })()
  const stable = start !== null && end !== null && start === end
  report.section("STATUS DRIFT", stable, stable ? "git status --short unchanged" : "git status --short changed")
  checks.push(stable)
  const pass = checks.every(Boolean)
  report.summary(pass, "WAVE 1A")
  return pass ? 0 : 1
}

if (import.meta.main) process.exitCode = main()
