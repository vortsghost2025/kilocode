import z from "zod"

export namespace CapabilityManifest {
  export const Risk = z.enum(["class-0", "class-1", "class-2", "class-3", "class-4", "class-5"])
  export type Risk = z.infer<typeof Risk>

  export const Action = z.enum(["allow", "ask", "deny"])
  export type Action = z.infer<typeof Action>

  export const Classification = z.enum(["read", "write", "admin"])
  export type Classification = z.infer<typeof Classification>

  const Identifier = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "Use an exact capability identifier")

  const names = z
    .object({
      allow: z.array(Identifier),
      deny: z.array(Identifier),
    })
    .strict()
    .superRefine((input, ctx) => {
      for (const [key, list] of Object.entries(input)) {
        if (new Set(list).size === list.length) continue
        ctx.addIssue({ code: "custom", path: [key], message: `Duplicate capability in ${key}` })
      }
      const denied = new Set(input.deny)
      for (const name of input.allow) {
        if (!denied.has(name)) continue
        ctx.addIssue({
          code: "custom",
          path: ["allow"],
          message: `Capability appears in allow and deny: ${name}`,
        })
      }
    })

  export const Names = names
  export type Names = z.infer<typeof Names>

  export const McpTools = z
    .object({
      allow: z.array(z.union([Identifier, z.literal("*")])),
      deny: z.array(Identifier),
    })
    .strict()
    .superRefine((input, ctx) => {
      for (const [key, list] of Object.entries(input)) {
        if (new Set(list).size === list.length) continue
        ctx.addIssue({ code: "custom", path: [key], message: `Duplicate MCP tool in ${key}` })
      }
      if (input.allow.includes("*") && input.allow.length !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["allow"],
          message: "MCP tool wildcard must be the only allow entry",
        })
      }
      const denied = new Set(input.deny)
      for (const name of input.allow) {
        if (name === "*" || !denied.has(name)) continue
        ctx.addIssue({
          code: "custom",
          path: ["allow"],
          message: `MCP tool appears in allow and deny: ${name}`,
        })
      }
    })
  export type McpTools = z.infer<typeof McpTools>

  export const CredentialRef = z.string().superRefine((value, ctx) => {
    const env = /^env:([A-Z_][A-Z0-9_]{0,63})$/.exec(value)
    const named = /^(auth|account|profile):([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)$/.exec(value)
    const name = env?.[1] ?? named?.[2]
    const bounded = env !== null || (named !== null && named[2].length <= 64)
    const blocked =
      /^(?:sk-|gh[oprsu]_|github_pat_|AKIA|AIza|xox[baprs]-|bearer(?:[._-]|$)|authorization(?:[._-]|$)|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.)/i.test(
        name ?? "",
      )
    if (bounded && !blocked) return
    ctx.addIssue({
      code: "custom",
      message: "Use a strict named credential reference without secret material",
    })
  })
  export type CredentialRef = z.infer<typeof CredentialRef>

  const boundary = z
    .object({
      action: Action,
      patterns: z.array(z.string().min(1)),
    })
    .strict()

  const gitRead = new Set(["status", "diff", "log", "show", "rev-parse"])
  const gitLocal = new Set([
    "add",
    "commit",
    "merge",
    "rebase",
    "reset",
    "tag",
    "restore",
    "checkout",
    "switch",
    "cherry-pick",
    "revert",
    "stash",
    "clean",
    "worktree",
    "config",
    "pull",
  ])

  const builtinInstruction = new Set(["invalid", "question"])
  const builtinRead = new Set(["read", "glob", "grep", "skill", "kilo_local_recall", "semantic_search"])
  const builtinRemote = new Set(["webfetch", "websearch", "codesearch"])
  const builtinLocal = new Set([
    "bash",
    "edit",
    "write",
    "apply_patch",
    "todowrite",
    "kilo_local_remember",
    "plan_exit",
    "lsp",
  ])
  const builtinUpload = new Set(["codebase_search"])
  const builtinAdmin = new Set(["task", "background_task", "batch"])
  const builtinKnown = new Set([
    ...builtinInstruction,
    ...builtinRead,
    ...builtinRemote,
    ...builtinLocal,
    ...builtinUpload,
    ...builtinAdmin,
  ])

  export const Lease = z.discriminatedUnion("lifetime", [
    z
      .object({
        lifetime: z.literal("task"),
        revokeOn: z.array(z.enum(["complete", "cancel", "error", "timeout"])).min(1),
      })
      .strict(),
    z
      .object({
        lifetime: z.literal("session"),
        revokeOn: z.array(z.enum(["session-end", "cancel", "error"])).min(1),
      })
      .strict(),
    z
      .object({
        lifetime: z.literal("duration"),
        durationMs: z.number().int().positive(),
        revokeOn: z.array(z.enum(["complete", "cancel", "error", "timeout"])).min(1),
      })
      .strict(),
  ])
  export type Lease = z.infer<typeof Lease>

  export const Schema = z
    .object({
      version: z.literal(1),
      agent: z
        .object({
          id: z.string().min(1),
          role: z.enum(["orchestrator", "subagent"]),
        })
        .strict(),
      identity: z
        .object({
          providerID: z.string().min(1),
          modelID: z.string().min(1),
          credentialRef: CredentialRef,
        })
        .strict(),
      risk: Risk,
      classification: Classification,
      skills: Names,
      mcp: z
        .object({
          servers: Names,
          tools: z.record(Identifier, McpTools),
        })
        .strict(),
      plugins: Names,
      builtins: z.record(z.string(), Action),
      filesystem: z
        .object({
          readRoots: z.array(z.string().min(1)),
          writeRoots: z.array(z.string().min(1)),
        })
        .strict(),
      shell: boundary,
      git: boundary,
      network: boundary,
      context: z
        .object({
          maxTokens: z.number().int().positive(),
          maxTools: z.number().int().nonnegative(),
          maxMcpTools: z.number().int().nonnegative(),
        })
        .strict(),
      timeoutMs: z.number().int().positive(),
      concurrency: z
        .object({
          maxTasks: z.number().int().positive(),
          distinctAgentTypes: z.boolean(),
          allowNested: z.boolean(),
        })
        .strict(),
      inheritance: z
        .object({
          mode: z.enum(["none", "restrictive"]),
          categories: z.array(
            z.enum(["builtins", "skills", "mcp", "plugins", "filesystem", "shell", "git", "network"]),
          ),
        })
        .strict(),
      lease: Lease,
    })
    .strict()
    .superRefine((input, ctx) => {
      for (const [name, rule] of Object.entries({ shell: input.shell, git: input.git, network: input.network })) {
        if (rule.action === "deny" || rule.patterns.length > 0) continue
        ctx.addIssue({
          code: "custom",
          path: [name, "patterns"],
          message: "Non-denied boundary requires at least one pattern",
        })
      }
      for (const server of input.mcp.servers.allow) {
        if (input.mcp.tools[server]) continue
        ctx.addIssue({
          code: "custom",
          path: ["mcp", "tools", server],
          message: `Allowed MCP server requires an explicit tool grant: ${server}`,
        })
      }
      const rank = Number(input.risk.slice(-1))
      const tools = Object.entries(input.builtins)
        .filter(([, action]) => action !== "deny")
        .map(([id]) => id)
      const unknown = tools.some((id) => !builtinKnown.has(id))
      const localTool = tools.some((id) => builtinLocal.has(id))
      const remoteTool = tools.some((id) => builtinRemote.has(id))
      const uploadTool = tools.some((id) => builtinUpload.has(id))
      const adminTool = tools.some((id) => builtinAdmin.has(id))
      const patterns = input.git.action === "deny" ? [] : input.git.patterns
      const gitWrite = patterns.some((pattern) => gitLocal.has(pattern))
      const gitRemote = patterns.some(
        (pattern) => pattern === "push" || (!gitRead.has(pattern) && !gitLocal.has(pattern)),
      )
      const shell = input.shell.action !== "deny"
      const network = input.network.action !== "deny"
      const mcp = input.mcp.servers.allow.length > 0
      const plugins = input.plugins.allow.length > 0
      const admin = plugins || adminTool || unknown
      const remote = mcp || network || gitRemote || uploadTool
      const local = input.filesystem.writeRoots.length > 0 || shell || gitWrite || localTool
      const remoteRead = remoteTool
      const read =
        input.filesystem.readRoots.length > 0 ||
        input.git.action !== "deny" ||
        tools.some((id) => builtinRead.has(id))
      const minimum = (() => {
        if (input.classification === "admin" || admin) return 5
        if (remote) return 4
        if (input.classification === "write" || local) return 3
        if (remoteRead) return 2
        if (read) return 1
        return 0
      })()
      if (input.classification !== "admin" && admin) {
        ctx.addIssue({
          code: "custom",
          path: ["classification"],
          message: "Admin capabilities require admin classification",
        })
      }
      if (input.classification === "read" && (local || remote)) {
        ctx.addIssue({
          code: "custom",
          path: ["classification"],
          message: "Read classification cannot include write capabilities",
        })
      }
      if (rank >= minimum) return
      ctx.addIssue({
        code: "custom",
        path: ["risk"],
        message: `Risk class ${input.risk} is below required class-${minimum}`,
      })
    })

  export type Info = z.infer<typeof Schema>

  export function parse(input: unknown) {
    return Schema.parse(input)
  }
}
