// kilocode_change - new file
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Instance } from "@/project/instance"
import { SessionID } from "@/session/schema"
import { Log } from "@/util/log"
import { createHash } from "node:crypto"
import z from "zod"

export namespace OwnershipAudit {
  const log = Log.create({ service: "ownership-audit" })
  const GIT = [
    /^git\s+(add|commit|push|reset|clean|checkout|switch|restore|rebase|merge|cherry-pick|revert|fetch|pull|update-ref|gc|prune)\b/i,
    /^git\s+stash\s+(push|pop|apply|drop|clear|branch)\b/i,
    /^git\s+remote\s+(add|remove|rename|set-head|set-branches|set-url|prune|update)\b/i,
    /^git\s+worktree\s+(add|remove|move|prune|repair|lock|unlock)\b/i,
    /^git\s+branch\s+(?!--show-current\b|--list\b|-l\b|-a\b|--all\b|-r\b|--remotes\b|--contains\b|--merged\b|--no-merged\b)/i,
    /^git\s+tag\s+(?!--list\b|-l\b|--contains\b|--points-at\b)/i,
    /^git\s+config\s+(?!--get\b|--get-all\b|--get-regexp\b|--list\b|-l\b|--show-origin\b|--show-scope\b)/i,
  ]
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
    if (input.patterns.some((pattern) => GIT.some((rule) => rule.test(pattern.trim())))) {
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
}
