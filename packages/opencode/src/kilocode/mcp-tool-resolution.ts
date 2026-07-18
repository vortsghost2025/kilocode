import type { Tool } from "ai"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Wildcard } from "@/util/wildcard"

export namespace MCPToolResolution {
  const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_")

  function targets(prefix: string, permission: string) {
    if (!permission.includes("*")) return permission.startsWith(prefix)
    const base = permission.slice(0, permission.indexOf("*"))
    return base.length === 0 || prefix.startsWith(base) || base.startsWith(prefix)
  }

  export function allowed(name: string, ruleset: Permission.Ruleset) {
    const prefix = sanitize(name) + "_"
    const probe = prefix + "__kilo_mcp_probe__"
    const index = ruleset.findLastIndex(
      (rule) => Wildcard.match(probe, rule.permission) && Wildcard.match("*", rule.pattern),
    )
    if (index === -1) return true
    if (ruleset[index].action !== "deny") return true

    return ruleset.slice(index + 1).some((rule) => {
      if (rule.action === "deny") return false
      return targets(prefix, rule.permission)
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
