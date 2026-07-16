// kilocode_change - new file
import type { CapabilityManifest } from "../../../src/kilocode/capability/manifest"

export function manifest(): CapabilityManifest.Info {
  return {
    version: 1,
    agent: { id: "source-researcher", role: "subagent" },
    identity: {
      providerID: "example-provider",
      modelID: "example-model",
      credentialRef: "env:SOURCE_RESEARCHER_API_KEY",
    },
    risk: "class-1",
    classification: "read",
    skills: { allow: ["repo-state-verification"], deny: ["bounded-source-patch"] },
    mcp: {
      servers: { allow: [], deny: ["write-api"] },
      tools: {},
    },
    plugins: { allow: [], deny: [] },
    builtins: { read: "allow", grep: "allow", glob: "allow", bash: "deny", edit: "deny" },
    filesystem: { readRoots: ["${WORKTREE}"], writeRoots: [] },
    shell: { action: "deny", patterns: [] },
    git: { action: "allow", patterns: ["status", "diff", "log"] },
    network: { action: "deny", patterns: [] },
    context: { maxTokens: 32_000, maxTools: 12, maxMcpTools: 3 },
    timeoutMs: 60_000,
    concurrency: { maxTasks: 1, distinctAgentTypes: true, allowNested: false },
    inheritance: { mode: "restrictive", categories: ["filesystem", "git", "network", "mcp"] },
    lease: { lifetime: "task", revokeOn: ["complete", "cancel", "error", "timeout"] },
  }
}
