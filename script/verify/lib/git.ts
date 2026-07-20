import { normalizePath } from "./manifest"

type Args =
  | readonly ["rev-parse", string]
  | readonly ["diff", "--cached", "--name-status", "-z"]
  | readonly ["diff", "--name-status", "-z", string, string]
  | readonly ["merge-base", "--is-ancestor", string, string]
  | readonly ["diff", "--check", string, string, "--", ...string[]]
  | readonly ["status", "--short"]

export type StagedEntry = {
  status: "A" | "C" | "D" | "M" | "R" | "T"
  paths: string[]
}

export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitError"
  }
}

function run(args: Args, root: string) {
  return Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
}

function output(args: Args, root: string) {
  const result = run(args, root)
  if (result.exitCode === 0) return new TextDecoder().decode(result.stdout)
  const detail = new TextDecoder().decode(result.stderr).trim() || `exit ${result.exitCode}`
  throw new GitError(`git ${args[0]} failed: ${detail}`)
}

export function revParse(ref: string, root = process.cwd()) {
  return output(["rev-parse", ref], root).trim()
}

function entries(tokens: string[], index = 0, result: StagedEntry[] = []): StagedEntry[] {
  if (index >= tokens.length) return result
  const token = tokens[index]
  const single = token.match(/^([ADMT])$/)
  const pair = token.match(/^([CR])(\d{1,3})$/)
  const score = pair ? Number(pair[2]) : 0
  if (!single && (!pair || score > 100)) throw new GitError(`unsupported name-status record: ${token || "empty"}`)
  const status = (single?.[1] ?? pair?.[1]) as StagedEntry["status"]
  const count = status === "R" || status === "C" ? 2 : 1
  const names = tokens.slice(index + 1, index + 1 + count)
  if (names.length !== count || names.some((name) => !name)) {
    throw new GitError(`truncated or empty name-status record: ${token}`)
  }
  const paths = names.map((name) => {
    try {
      return normalizePath(name)
    } catch (err) {
      throw new GitError(`malformed name-status path: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  result.push({ status, paths })
  return entries(tokens, index + count + 1, result)
}

export function parseNameStatus(raw: Uint8Array | string) {
  const text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw)
  if (!text) return []
  if (!text.endsWith("\0")) throw new GitError("malformed name-status stream: missing NUL terminator")
  return entries(text.slice(0, -1).split("\0"))
}

export function stagedEntries(root = process.cwd()) {
  const result = run(["diff", "--cached", "--name-status", "-z"], root)
  if (result.exitCode === 0) return parseNameStatus(result.stdout)
  const detail = new TextDecoder().decode(result.stderr).trim() || `exit ${result.exitCode}`
  throw new GitError(`git diff failed: ${detail}`)
}

export function commitEntries(parent: string, commit: string, root = process.cwd()) {
  const result = run(["diff", "--name-status", "-z", parent, commit], root)
  if (result.exitCode === 0) return parseNameStatus(result.stdout)
  const detail = new TextDecoder().decode(result.stderr).trim() || `exit ${result.exitCode}`
  throw new GitError(`git diff failed: ${detail}`)
}

export function isAncestor(ancestor: string, descendant: string, root = process.cwd()) {
  const result = run(["merge-base", "--is-ancestor", ancestor, descendant], root)
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  const detail = new TextDecoder().decode(result.stderr).trim() || `exit ${result.exitCode}`
  throw new GitError(`git merge-base failed: ${detail}`)
}

export function diffCheck(parent: string, commit: string, paths: string[], root = process.cwd()) {
  const result = run(["diff", "--check", parent, commit, "--", ...paths], root)
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  const detail = new TextDecoder().decode(result.stderr).trim() || `exit ${result.exitCode}`
  throw new GitError(`git diff --check failed: ${detail}`)
}

export function statusShort(root = process.cwd()) {
  return output(["status", "--short"], root)
}
