import type { Permission } from "@/permission"
import type { SessionID } from "@/session/schema"
import { Wildcard } from "@/util/wildcard"
import { AuthorityStore } from "./authority-store"

export namespace CapabilityAuthority {
  const EDIT = new Set(["edit", "write", "apply_patch", "multiedit"])
  const rank = { allow: 0, ask: 1, deny: 2 } as const

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
  }): Permission.Rule {
    const role = input.role ?? input.agent
    const base =
      match(input.permission, input.pattern, role) ??
      ({ permission: input.permission, pattern: "*", action: "ask" } satisfies Permission.Rule)
    const actions: Permission.Rule[] = [base]
    const session = input.session ?? []

    const configured = match(input.permission, input.pattern, input.agent)
    if (configured) actions.push(configured)

    if (input.sessionID) {
      for (const layer of AuthorityStore.get(input.sessionID)?.layers ?? []) {
        const rule = match(input.permission, input.pattern, layer.rules)
        if (rule) actions.push(rule)
        else if (layer.kind === "role") {
          actions.push({ permission: input.permission, pattern: "*", action: "ask" })
        }
      }
    }

    const local = match(input.permission, input.pattern, session)
    if (local) actions.push(local)

    const strict = actions.reduce((result, rule) => (rank[rule.action] > rank[result.action] ? rule : result))
    const saved = match(input.permission, input.pattern, input.approved ?? [])
    if (saved?.action === "deny") return saved
    if (strict.action === "ask" && saved?.action === "allow") return saved
    return strict
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
