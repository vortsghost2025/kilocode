import type { Tool } from "ai"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Wildcard } from "@/util/wildcard"

export namespace MCPToolResolution {
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

  function covers(cover: string, target: string) {
    if (cover === "*" || cover === target) return true
    if (/[*?]/.test(target)) return false
    return Wildcard.match(target, cover)
  }

  function superseded(ruleset: Permission.Ruleset, index: number) {
    const rule = ruleset[index]
    return ruleset
      .slice(index + 1)
      .some(
        (next) =>
          next.action === "deny" && covers(next.permission, rule.permission) && covers(next.pattern, rule.pattern),
      )
  }

  export function allowed(name: string, ruleset: Permission.Ruleset) {
    const prefix = sanitize(name) + "_"
    const probe = prefix + "__kilo_mcp_probe__"
    const index = ruleset.findLastIndex(
      (rule) => Wildcard.match(probe, rule.permission) && Wildcard.match("*", rule.pattern),
    )
    if (index === -1) return true
    if (ruleset[index].action !== "deny") return true

    return ruleset.slice(index + 1).some((rule, offset) => {
      if (rule.action === "deny") return false
      if (!targets(prefix, rule.permission)) return false
      return !superseded(ruleset, index + offset + 1)
    })
  }

  export async function servers(ruleset: Permission.Ruleset) {
    const cfg = await Config.get()
    return Object.entries(cfg.mcp ?? {})
      .filter(([, entry]) => typeof entry === "object" && entry !== null && "type" in entry && entry.enabled !== false)
      .map(([name]) => name)
      .filter((name) => allowed(name, ruleset))
  }

  export async function resolve(ruleset: Permission.Ruleset): Promise<Record<string, Tool>> {
    const names = await servers(ruleset)
    if (names.length === 0) return {}
    return MCP.toolsForServers(names)
  }
}
