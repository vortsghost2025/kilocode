import type { Permission } from "@/permission"
import type { SessionID } from "@/session/schema"
import { Wildcard } from "@/util/wildcard"
import { AuthorityStore } from "./authority-store"

export namespace CapabilityAuthority {
  const EDIT = new Set(["edit", "populate", "write", "apply_patch", "multiedit"])
  const rank = { allow: 0, ask: 1, deny: 2 } as const

  export type Source =
    | { layer: "canonical-role" }
    | { layer: "configured-role" }
    | { layer: "inherited-authority"; kind: "role" | "config" | "session"; sourceSessionID: SessionID }
    | { layer: "control-authority"; sourceSessionID: SessionID }
    | { layer: "session-rule" }
    | { layer: "saved-approval" }
    | { layer: "delegated-lease" }

  export type Decision = Permission.Rule & {
    requestedPermission: string
    winningPattern: string
    source: Source
    correlationID: string
  }

  type Candidate = {
    rule: Permission.Rule
    source: Source
  }

  function match(permission: string, pattern: string, ruleset: Permission.Ruleset) {
    return ruleset.findLast(
      (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
    )
  }

  function tool(id: string) {
    return EDIT.has(id) ? "edit" : id
  }

  function hidden(id: string, ruleset: Permission.Ruleset) {
    const permission = tool(id)
    const mapped = ruleset.findLast((item) => Wildcard.match(permission, item.permission))
    if (mapped?.pattern === "*" && mapped.action === "deny") return true
    if (permission === id) return false
    const direct = ruleset.findLast((item) => Wildcard.match(id, item.permission))
    return direct?.pattern === "*" && direct.action === "deny"
  }

  export function evaluate(input: {
    permission: string
    pattern: string
    role?: Permission.Ruleset
    agent: Permission.Ruleset
    session?: Permission.Ruleset
    sessionID?: SessionID
    approved?: Permission.Ruleset
    correlationID?: string
  }): Decision {
    const role = input.role ?? input.agent
    const base =
      match(input.permission, input.pattern, role) ??
      ({ permission: input.permission, pattern: "*", action: "ask" } satisfies Permission.Rule)
    const actions: Candidate[] = [{ rule: base, source: { layer: "canonical-role" } }]
    const session = input.session ?? []

    const configured = match(input.permission, input.pattern, input.agent)
    if (configured) actions.push({ rule: configured, source: { layer: "configured-role" } })

    if (input.sessionID) {
      for (const layer of AuthorityStore.get(input.sessionID)?.layers ?? []) {
        const rule = match(input.permission, input.pattern, layer.rules)
        if (rule) {
          const source: Source =
            layer.kind === "control"
              ? { layer: "control-authority", sourceSessionID: layer.sourceSessionID }
              : { layer: "inherited-authority", kind: layer.kind, sourceSessionID: layer.sourceSessionID }
          actions.push({ rule, source })
          continue
        }
        if (layer.kind !== "role") continue
        actions.push({
          rule: { permission: input.permission, pattern: "*", action: "ask" },
          source: {
            layer: "inherited-authority",
            kind: layer.kind,
            sourceSessionID: layer.sourceSessionID,
          },
        })
      }
    }

    const local = match(input.permission, input.pattern, session)
    if (local) actions.push({ rule: local, source: { layer: "session-rule" } })

    const strict = actions.reduce((result, item) => (rank[item.rule.action] > rank[result.rule.action] ? item : result))
    const saved = match(input.permission, input.pattern, input.approved ?? [])
    const winner =
      saved?.action === "deny" || (strict.rule.action === "ask" && saved?.action === "allow")
        ? ({ rule: saved, source: { layer: "saved-approval" } } satisfies Candidate)
        : strict
    return {
      ...winner.rule,
      requestedPermission: input.permission,
      winningPattern: winner.rule.pattern,
      source: winner.source,
      correlationID: input.correlationID ?? "none",
    }
  }

  export function delegated(input: { permission: string; pattern: string; correlationID: string }): Decision {
    return {
      permission: input.permission,
      pattern: input.pattern,
      action: "allow",
      requestedPermission: input.permission,
      winningPattern: input.pattern,
      source: { layer: "delegated-lease" },
      correlationID: input.correlationID,
    }
  }

  export function inherit(input: {
    role: Permission.Ruleset
    agent: Permission.Ruleset
    session?: Permission.Ruleset
    source: SessionID
  }) {
    const session = input.session ?? []
    const layers: AuthorityStore.Layer[] = [...(AuthorityStore.get(input.source)?.layers ?? [])]
    if (input.role.length > 0) layers.push({ kind: "role", sourceSessionID: input.source, rules: input.role })
    if (input.agent.length > 0) layers.push({ kind: "config", sourceSessionID: input.source, rules: input.agent })
    if (session.length > 0) layers.push({ kind: "session", sourceSessionID: input.source, rules: session })
    return layers
  }

  export function disabled(input: {
    tools: string[]
    role?: Permission.Ruleset
    agent: Permission.Ruleset
    session?: Permission.Ruleset
    sessionID?: SessionID
  }) {
    const result = new Set<string>()
    const session = input.session ?? []
    const all: Permission.Ruleset[] = [input.role ?? input.agent, input.agent]

    if (input.sessionID) {
      for (const layer of AuthorityStore.get(input.sessionID)?.layers ?? []) {
        all.push(layer.rules)
      }
    }

    all.push(session)

    for (const id of input.tools) {
      if (all.some((ruleset) => hidden(id, ruleset))) result.add(id)
    }
    return result
  }
}
