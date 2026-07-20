import type { Tool } from "ai"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Wildcard } from "@/util/wildcard"
import type { SessionID } from "@/session/schema"
import { AsyncLocalStorage } from "node:async_hooks"
import { CapabilityAuthority } from "./capability/authority"

export namespace MCPToolResolution {
  type Servers = NonNullable<Config.Info["mcp"]>
  const isolated = new AsyncLocalStorage<Servers>()
  const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_")

  function targets(prefix: string, permission: string) {
    if (!/[*?]/.test(permission)) return permission.startsWith(prefix)
    for (const suffix of ["", "search", "tool", "x", "__kilo_mcp_probe__"]) {
      if (Wildcard.match(prefix + suffix, permission)) return true
    }

    const wildcard = permission.search(/[*?]/)
    const base = permission.slice(0, wildcard)
    if (base && !prefix.startsWith(base) && !base.startsWith(prefix)) return false
    return true
  }

  function explicit(prefix: string, ruleset: Permission.Ruleset) {
    return ruleset
      .map((rule, index) => ({ rule, index }))
      .toReversed()
      .find((item) => {
        if (item.rule.action !== "allow" || item.rule.permission === "*") return false
        if (!targets(prefix, item.rule.permission) || !Wildcard.match("*", item.rule.pattern)) return false
        return !ruleset
          .slice(item.index + 1)
          .some(
            (next) =>
              next.action === "deny" &&
              Wildcard.match(item.rule.permission, next.permission) &&
              Wildcard.match("*", next.pattern),
          )
      })?.rule
  }

  function tool(id: string, ruleset: Permission.Ruleset) {
    const index = ruleset.findLastIndex(
      (rule) => rule.permission !== "*" && Wildcard.match(id, rule.permission) && Wildcard.match("*", rule.pattern),
    )
    if (index === -1 || ruleset[index].action !== "allow") return
    const denied = ruleset
      .slice(index + 1)
      .some((rule) => rule.action === "deny" && Wildcard.match(id, rule.permission))
    return denied ? undefined : ruleset[index]
  }

  export function allowed(
    name: string,
    ruleset: Permission.Ruleset,
    session: Permission.Ruleset = [],
    sessionID?: SessionID,
    role?: Permission.Ruleset,
  ) {
    const prefix = sanitize(name) + "_"
    const grant = explicit(prefix, ruleset)
    if (!grant) return false
    return (
      CapabilityAuthority.evaluate({
        permission: grant.permission,
        pattern: grant.pattern,
        role,
        agent: ruleset,
        session,
        sessionID,
      }).action === "allow"
    )
  }

  export function allowedTool(
    id: string,
    ruleset: Permission.Ruleset,
    session: Permission.Ruleset = [],
    sessionID?: SessionID,
    role?: Permission.Ruleset,
  ) {
    const grant = tool(id, ruleset)
    if (!grant) return false
    return (
      CapabilityAuthority.evaluate({ permission: id, pattern: grant.pattern, role, agent: ruleset, session, sessionID })
        .action === "allow"
    )
  }

  function select(
    config: Servers,
    ruleset: Permission.Ruleset,
    session: Permission.Ruleset = [],
    sessionID?: SessionID,
    role?: Permission.Ruleset,
  ) {
    return Object.entries(config)
      .filter(([, entry]) => typeof entry === "object" && entry !== null && "type" in entry && entry.enabled !== false)
      .map(([name]) => name)
      .filter((name) => allowed(name, ruleset, session, sessionID, role))
  }

  export async function servers(
    ruleset: Permission.Ruleset,
    session: Permission.Ruleset = [],
    sessionID?: SessionID,
    role?: Permission.Ruleset,
  ) {
    const state = isolated.getStore()
    const config = state ?? (await Config.get()).mcp ?? {}
    return select(config, ruleset, session, sessionID, role)
  }

  async function resolveSelected(
    names: string[],
    ruleset: Permission.Ruleset,
    session: Permission.Ruleset,
    sessionID?: SessionID,
    role?: Permission.Ruleset,
  ) {
    if (names.length === 0) return {}
    const tools = await MCP.toolsForServers(names)
    return Object.fromEntries(
      Object.entries(tools).filter(([id]) => allowedTool(id, ruleset, session, sessionID, role)),
    )
  }

  export async function resolve(
    ruleset: Permission.Ruleset,
    session: Permission.Ruleset = [],
    sessionID?: SessionID,
    role?: Permission.Ruleset,
  ): Promise<Record<string, Tool>> {
    const names = await servers(ruleset, session, sessionID, role)
    return resolveSelected(names, ruleset, session, sessionID, role)
  }

  /** @internal Creates an explicit MCP config boundary for isolated production-path tests. */
  export function isolate<T>(config: Servers, fn: () => T) {
    return isolated.run(structuredClone(config), fn)
  }
}
