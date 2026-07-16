import z from "zod"
import { CapabilityManifest } from "./manifest"

export namespace CapabilityDoctor {
  export const Source = z
    .object({
      path: z.string().min(1),
      scope: z.enum(["project", "global", "managed", "environment"]),
      committed: z.boolean(),
      skills: z.array(z.string()),
      mcp: z.array(z.string()),
      plugins: z.array(z.string()),
      permissions: z.array(z.string()),
      content: z.unknown().optional(),
    })
    .strict()

  export const Server = z
    .object({
      name: z.string().min(1),
      scope: z.enum(["project", "global", "managed"]),
      enabled: z.boolean(),
      transport: z.enum(["stdio", "http", "sse"]),
      health: z.enum(["disabled", "starting", "healthy", "failed", "stopped"]),
      startupMs: z.number().int().nonnegative().optional(),
      tools: z.array(z.string()),
      estimatedTokens: z.number().int().nonnegative(),
      pid: z.number().int().positive().optional(),
      orphaned: z.boolean(),
    })
    .strict()

  export const Lease = z
    .object({
      id: z.string().min(1),
      agent: z.string().min(1),
      capability: z.string().min(1),
      expiresAt: z.number().int().nonnegative().optional(),
      revokedAt: z.number().int().nonnegative().optional(),
    })
    .strict()

  export const Input = z
    .object({
      manifest: CapabilityManifest.Schema,
      sources: z.array(Source),
      servers: z.array(Server),
      leases: z.array(Lease),
      now: z.number().int().nonnegative(),
    })
    .strict()

  export const Report = z
    .object({
      agent: z.string(),
      providerID: z.string(),
      modelID: z.string(),
      credentialRefs: z.array(z.string()),
      configSources: z.array(
        z.object({ path: z.string(), scope: z.string(), committed: z.boolean() }).strict(),
      ),
      enabledSkills: z.array(z.string()),
      enabledPlugins: z.array(z.string()),
      enabledMcpServers: z.array(z.string()),
      exposedMcpTools: z.array(z.string()),
      permissionRules: z.array(z.string()),
      toolCount: z.number().int().nonnegative(),
      estimatedContextTokens: z.number().int().nonnegative(),
      serverHealth: z.array(
        z
          .object({
            name: z.string(),
            health: z.string(),
            startupMs: z.number().int().nonnegative().optional(),
          })
          .strict(),
      ),
      activeLeases: z.array(z.string()),
      conflicts: z.array(z.string()),
      orphanedProcesses: z.array(z.object({ server: z.string(), pid: z.number().int().positive() }).strict()),
      secretPaths: z.array(z.string()),
    })
    .strict()

  export type Report = z.infer<typeof Report>

  const sensitive = /(api.?key|token|secret|password|authorization|client.?secret|private.?key)/i
  const secret = /^(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|Bearer\s+\S+)/
  const env = /^\{env:[A-Z_][A-Z0-9_]{0,63}\}$/

  function secrets(input: unknown, base: string, output: string[]) {
    if (typeof input === "string") {
      if (env.test(input)) return
      if (input.startsWith("{env:")) {
        output.push(base)
        return
      }
      if (secret.test(input)) output.push(base)
      return
    }
    if (Array.isArray(input)) {
      input.forEach((value, index) => secrets(value, `${base}[${index}]`, output))
      return
    }
    if (!input || typeof input !== "object") return
    for (const [key, value] of Object.entries(input)) {
      const next = base ? `${base}.${key}` : key
      if (key === "credentialRef") {
        if (!CapabilityManifest.CredentialRef.safeParse(value).success) output.push(next)
        continue
      }
      if (sensitive.test(key) && typeof value === "string") {
        if (!env.test(value)) output.push(next)
        continue
      }
      secrets(value, next, output)
    }
  }

  export function selectTools(grant: CapabilityManifest.McpTools | undefined, tools: string[]) {
    if (!grant) return []
    const blocked = new Set(grant.deny)
    const selected = grant.allow.includes("*") ? tools : tools.filter((tool) => grant.allow.includes(tool))
    return selected.filter((tool) => !blocked.has(tool))
  }

  function duplicates(sources: z.infer<typeof Source>[], key: "skills" | "mcp" | "plugins") {
    const seen = new Map<string, string>()
    const output: string[] = []
    for (const source of sources) {
      for (const name of source[key]) {
        const prior = seen.get(name)
        if (prior && prior !== source.scope) output.push(`${key}:${name}:${prior}->${source.scope}`)
        seen.set(name, source.scope)
      }
    }
    return output
  }

  export function inspect(value: unknown): Report {
    const input = Input.parse(value)
    const allowed = new Set(input.manifest.mcp.servers.allow)
    const denied = new Set(input.manifest.mcp.servers.deny)
    const servers = input.servers.filter(
      (server) => server.enabled && allowed.has(server.name) && !denied.has(server.name),
    )
    const tools = servers.flatMap((server) => {
      const grant = input.manifest.mcp.tools[server.name]
      return selectTools(grant, server.tools).map((tool) => `${server.name}_${tool}`)
    })
    const conflicts = [
      ...duplicates(input.sources, "skills"),
      ...duplicates(input.sources, "mcp"),
      ...duplicates(input.sources, "plugins"),
    ]
    for (const source of input.sources.filter((item) => item.scope === "global")) {
      for (const name of source.mcp) {
        if (!allowed.has(name) && !denied.has(name)) conflicts.push(`global-bleed:mcp:${name}`)
      }
    }
    for (const name of allowed) {
      if (!input.servers.some((server) => server.name === name)) conflicts.push(`missing:mcp:${name}`)
    }
    const secretPaths: string[] = []
    input.sources.forEach((source, index) => {
      if (!source.committed || source.content === undefined) return
      secrets(source.content, `sources[${index}].content`, secretPaths)
    })

    return Report.parse({
      agent: input.manifest.agent.id,
      providerID: input.manifest.identity.providerID,
      modelID: input.manifest.identity.modelID,
      credentialRefs: [input.manifest.identity.credentialRef],
      configSources: input.sources.map((source) => ({
        path: source.path,
        scope: source.scope,
        committed: source.committed,
      })),
      enabledSkills: input.manifest.skills.allow.filter((name) => !input.manifest.skills.deny.includes(name)),
      enabledPlugins: input.manifest.plugins.allow.filter((name) => !input.manifest.plugins.deny.includes(name)),
      enabledMcpServers: servers.map((server) => server.name),
      exposedMcpTools: tools,
      permissionRules: Object.entries(input.manifest.builtins).map(([tool, action]) => `${tool}:${action}`),
      toolCount: tools.length,
      estimatedContextTokens: servers.reduce((total, server) => total + server.estimatedTokens, 0),
      serverHealth: input.servers.map((server) => ({
        name: server.name,
        health: server.health,
        startupMs: server.startupMs,
      })),
      activeLeases: input.leases
        .filter(
          (lease) =>
            lease.revokedAt === undefined && (lease.expiresAt === undefined || lease.expiresAt > input.now),
        )
        .map((lease) => lease.id),
      conflicts: [...new Set(conflicts)].toSorted(),
      orphanedProcesses: input.servers.flatMap((server) =>
        server.orphaned && server.pid !== undefined ? [{ server: server.name, pid: server.pid }] : [],
      ),
      secretPaths: [...new Set(secretPaths)].toSorted(),
    })
  }
}
