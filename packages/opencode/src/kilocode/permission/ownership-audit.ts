// kilocode_change - new file
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Instance } from "@/project/instance"
import { SessionID } from "@/session/schema"
import { Log } from "@/util/log"
import { NamedError } from "@opencode-ai/util/error"
import { createHash } from "node:crypto"
import z from "zod"

export namespace OwnershipPolicy {
  export function enabled() {
    return ["1", "true"].includes((process.env.KILO_EXPERIMENTAL_OWNERSHIP_ENFORCEMENT ?? "").toLowerCase())
  }

  export type Result =
    | { status: "not_applicable" }
    | { status: "allowed_owner"; operation: "git-mutation"; expectedOwner: "git-ops" }
    | { status: "denied_wrong_owner"; operation: "git-mutation"; expectedOwner: "git-ops" }

  export const DeniedError = NamedError.create(
    "GitOwnershipDeniedError",
    z.object({
      operation: z.literal("git-mutation"),
      expectedOwner: z.literal("git-ops"),
    }),
  )

  function normalize(token: string, lowercase = false) {
    const trimmed = token.trim()
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    const unquoted =
      trimmed.length >= 2 && (first === "'" || first === '"') && first === last ? trimmed.slice(1, -1) : trimmed
    return lowercase ? unquoted.toLowerCase() : unquoted
  }

  export function parse(text: string): string[][] {
    const state = {
      cmds: [] as string[][],
      cur: [] as string[],
      tok: "",
      quote: null as string | null,
      esc: false,
      op: "",
    }

    const flushTok = () => {
      if (state.tok) state.cur.push(state.tok)
      state.tok = ""
    }

    const flushCmd = () => {
      flushTok()
      if (state.cur.length) state.cmds.push(state.cur)
      state.cur = []
    }

    for (const char of text) {
      if (state.esc) {
        state.tok += char
        state.esc = false
        continue
      }
      if (char === "\\") {
        state.esc = true
        continue
      }
      if (state.quote) {
        if (char === state.quote) {
          state.quote = null
          continue
        }
        state.tok += char
        continue
      }
      if (char === "'" || char === '"') {
        state.quote = char
        continue
      }

      if (state.op) {
        if (char === state.op) {
          state.op = ""
          flushCmd()
          continue
        }
        state.op = ""
        flushCmd()
      }

      if (char === "&" || char === "|") {
        state.op = char
        continue
      }

      if (";\n()".includes(char)) {
        flushCmd()
        continue
      }

      if (/\s/.test(char)) {
        flushTok()
        continue
      }

      state.tok += char
    }

    if (state.op) flushCmd()
    flushCmd()
    return state.cmds
  }

  const MUTATING = new Set([
    "add",
    "commit",
    "push",
    "pull",
    "fetch", // Writes FETCH_HEAD, remote refs, and object database
    "merge",
    "rebase",
    "reset",
    "restore",
    "checkout",
    "switch",
    "cherry-pick",
    "revert",
    "clean",
    "rm",
    "mv",
    "update-ref",
    "apply",
    "am",
    "bisect",
    "clone",
    "init",
    "gc",
    "prune",
    "repack",
    "maintenance",
    "replace",
    "filter-branch",
    "fast-import",
    "read-tree",
    "write-tree",
    "update-index",
    "index-pack",
    "unpack-objects",
  ])

  const READONLY = new Set([
    "status",
    "diff",
    "show",
    "log",
    "rev-parse",
    "ls-files",
    "ls-tree",
    "cat-file",
    "ls-remote",
    "grep",
    "blame",
    "shortlog",
    "describe",
    "name-rev",
    "for-each-ref",
    "show-ref",
    "count-objects",
    "help",
    "version",
    "whatchanged",
  ])

  function isGit(token: string) {
    const norm = normalize(token, true)
    const base = norm.replace(/\\/g, "/").split("/").pop() ?? ""
    return base === "git" || base === "git.exe"
  }

  function classifyGit(tokens: string[]): boolean {
    const state = { i: 0 }
    const skip = () => {
      if (state.i >= tokens.length) return
      const t = normalize(tokens[state.i], true)
      if (["call", "command"].includes(t)) {
        state.i++
        skip()
        return
      }
      if (t === "sudo") {
        state.i++
        const skipSudo = () => {
          const opt = tokens[state.i]
          if (!opt || !opt.startsWith("-")) return
          if (["-u", "-g", "-p", "-r", "-t"].includes(opt)) {
            state.i += 2
            skipSudo()
            return
          }
          state.i++
          skipSudo()
        }
        skipSudo()
        skip()
        return
      }
      if (t === "env") {
        state.i++
        const skipEnv = () => {
          const arg = tokens[state.i]
          if (!arg) return
          if (arg.startsWith("-")) {
            if (["-u", "-i", "-S"].includes(arg)) {
              state.i += 2
              skipEnv()
              return
            }
            state.i++
            skipEnv()
            return
          }
          if (arg.includes("=")) {
            state.i++
            skipEnv()
            return
          }
        }
        skipEnv()
        skip()
        return
      }
    }

    skip()
    const start = state.i
    if (start >= tokens.length || !isGit(tokens[start])) return false

    const globals = (i: number): number | boolean => {
      const opt = tokens[i]
      if (!opt || !opt.startsWith("-")) return i
      const norm = normalize(opt, true)
      const query = new Set([
        "--version",
        "--help",
        "--exec-path",
        "--html-path",
        "--man-path",
        "--info-path",
        "--paginate",
        "--no-pager",
        "--no-replace-objects",
        "--literal-pathspecs",
        "--glob-pathspecs",
        "--noglob-pathspecs",
        "--icase-pathspecs",
        "--no-optional-locks",
      ])
      if (query.has(norm)) return globals(i + 1)
      const skipVal = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"])
      const base = norm.split("=")[0]
      if (skipVal.has(base)) {
        if (norm.includes("=")) return globals(i + 1)
        return globals(i + 2)
      }
      return true
    }

    const next = globals(start + 1)
    if (typeof next !== "number") return true
    if (next >= tokens.length) return false

    const sub = normalize(tokens[next], true)
    if (MUTATING.has(sub)) return true
    if (READONLY.has(sub)) return false

    if (sub === "branch") {
      const args = tokens.slice(next + 1)
      if (args.length === 0) return false
      const norm = args.map((a) => normalize(a, true))
      const list = new Set([
        "--show-current",
        "--list",
        "-l",
        "--all",
        "-a",
        "--remotes",
        "-r",
        "--contains",
        "--merged",
        "--no-merged",
        "--points-at",
        "-v",
        "--verbose",
      ])
      const mutation = new Set([
        "--delete",
        "-d",
        "-D",
        "--move",
        "-m",
        "-M",
        "--copy",
        "-c",
        "-C",
        "--set-upstream-to",
        "-u",
        "--unset-upstream",
        "--edit-description",
      ])
      if (norm.some((a) => mutation.has(a))) return true
      const positionals = args.filter((a) => !a.startsWith("-"))
      if (positionals.length > 0) return !norm.some((a) => list.has(a))
      return false
    }
    if (sub === "tag") {
      const args = tokens.slice(next + 1)
      if (args.length === 0) return false
      const norm = args.map((a) => normalize(a, true))
      const list = new Set(["--list", "-l", "--contains", "--points-at", "--merged", "--no-merged", "--verify", "-v"])
      const mutation = new Set([
        "--delete",
        "-d",
        "--annotate",
        "-a",
        "--sign",
        "-s",
        "--local-user",
        "-u",
        "--force",
        "-f",
      ])
      if (norm.some((a) => mutation.has(a))) return true
      const positionals = args.filter((a) => !a.startsWith("-"))
      if (positionals.length > 0) return !norm.some((a) => list.has(a))
      return false
    }
    if (sub === "remote") {
      const args = tokens.slice(next + 1)
      if (args.length === 0) return false
      const subsub = normalize(args[0], true)
      return !["-v", "show", "get-url"].includes(subsub)
    }
    if (sub === "config") {
      const args = tokens.slice(next + 1)
      const norm = args.map((a) => normalize(a, true))
      const read = new Set([
        "--get",
        "--get-all",
        "--get-regexp",
        "--list",
        "-l",
        "--get-color",
        "--get-colorbool",
        "--show-origin",
        "--show-scope",
      ])
      if (norm.some((a) => read.has(a))) return false
      const mutation = new Set([
        "--add",
        "--unset",
        "--unset-all",
        "--rename-section",
        "--remove-section",
        "--edit",
        "-e",
      ])
      if (norm.some((a) => mutation.has(a))) return true
      const positionals = args.filter((a) => !a.startsWith("-"))
      return positionals.length !== 1
    }
    if (sub === "stash") {
      const arg = normalize(tokens[next + 1] ?? "push", true)
      return !["list", "show"].includes(arg)
    }
    if (sub === "worktree") return normalize(tokens[next + 1] ?? "", true) !== "list"
    if (sub === "submodule") return normalize(tokens[next + 1] ?? "", true) !== "status"
    if (sub === "reflog") {
      const arg = normalize(tokens[next + 1] ?? "show", true)
      return !["show", "exists"].includes(arg)
    }
    if (sub === "notes") {
      const arg = normalize(tokens[next + 1] ?? "list", true)
      return !["list", "show"].includes(arg)
    }

    return true
  }

  export function mutates(commands: string[][]): boolean {
    return commands.some(classifyGit)
  }

  export function evaluate(input: { role: string; permission: string; commands: string[][]; strict: boolean }): Result {
    if (!input.strict || input.permission !== "bash") return { status: "not_applicable" }
    if (!mutates(input.commands)) return { status: "not_applicable" }
    if (input.role === "git-ops")
      return { status: "allowed_owner", operation: "git-mutation", expectedOwner: "git-ops" }
    return { status: "denied_wrong_owner", operation: "git-mutation", expectedOwner: "git-ops" }
  }
}

export namespace OwnershipAudit {
  const log = Log.create({ service: "ownership-audit" })
  const INSTALL =
    /^(bun\s+(install|i|add|remove|update)|npm\s+(install|i|uninstall|update)|pnpm\s+(install|i|add|remove|update)|yarn\s+(install|add|remove|upgrade)|pip3?\s+install)\b|^yarn\s*$/i

  export const Operation = z.enum(["source-mutation", "git-mutation", "package-install"])
  export type Operation = z.infer<typeof Operation>

  export const Info = z
    .object({
      operation: Operation,
      role: z.string(),
      expectedOwner: z.enum(["phase2f-implementer", "git-ops", "package-ops"]),
      permission: z.string(),
      sessionCorrelationID: z.string(),
      repositoryRootHash: z.string(),
    })
    .strict()
  export type Info = z.infer<typeof Info>

  export const Event = {
    Observed: BusEvent.define("authority.ownership.audit", Info),
  }

  function hash(value: string) {
    return createHash("sha256").update(value).digest("hex").slice(0, 16)
  }

  function enabled() {
    return ["1", "true"].includes((process.env.KILO_EXPERIMENTAL_OWNERSHIP_AUDIT ?? "").toLowerCase())
  }

  function role(value: string) {
    return /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : "custom"
  }

  export function classify(input: { role: string; permission: string; patterns: string[] }) {
    if (input.permission === "edit" && input.role === "code") {
      return { operation: "source-mutation", expectedOwner: "phase2f-implementer" } as const
    }
    if (input.permission !== "bash") return undefined
    if (input.patterns.some((pattern) => INSTALL.test(pattern.trim()))) {
      return { operation: "package-install", expectedOwner: "package-ops" } as const
    }
    if (input.role === "git-ops") return undefined
    if (input.patterns.some((pattern) => OwnershipPolicy.mutates(OwnershipPolicy.parse(pattern)))) {
      return { operation: "git-mutation", expectedOwner: "git-ops" } as const
    }
    return undefined
  }

  export async function record(input: { role: string; sessionID: SessionID; permission: string; patterns: string[] }) {
    if (!enabled()) return undefined
    return Promise.resolve()
      .then(async () => {
        const match = classify(input)
        if (!match) return undefined
        const info = Info.parse({
          ...match,
          role: role(input.role),
          permission: input.permission,
          sessionCorrelationID: hash(input.sessionID),
          repositoryRootHash: hash(Instance.worktree),
        })
        log.info("observed", info)
        await Bus.publish(Event.Observed, info)
        return info
      })
      .catch(() => undefined)
  }

  export async function recordDenied(input: { role: string; sessionID: SessionID; permission: string }): Promise<void> {
    return Promise.resolve()
      .then(() =>
        Info.parse({
          operation: "git-mutation",
          role: role(input.role),
          expectedOwner: "git-ops",
          permission: input.permission,
          sessionCorrelationID: hash(input.sessionID),
          repositoryRootHash: hash(Instance.worktree),
        }),
      )
      .then(async (info) => {
        log.info("denied", info)
        await Bus.publish(Event.Observed, info)
      })
      .catch(() => undefined)
  }
}
