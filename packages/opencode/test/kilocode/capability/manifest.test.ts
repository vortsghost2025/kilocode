// kilocode_change - new file
import { expect, test } from "bun:test"
import { CapabilityManifest } from "../../../src/kilocode/capability/manifest"
import { manifest } from "./fixture"

const read = ["status", "diff", "log", "show", "rev-parse"]
const local = [
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
]
const ambiguous = [
  "*",
  "push*",
  "push origin main",
  "git push",
  "status && push",
  "status;push",
  "status|push",
  "unknown-command",
  "status --short",
  "git status",
  "show HEAD",
]

const instructionTools = ["invalid", "question"]
const readTools = ["read", "glob", "grep", "skill", "kilo_local_recall"]
const remoteTools = ["webfetch", "websearch", "codesearch"]
const writeTools = ["bash", "edit", "write", "apply_patch", "todowrite", "kilo_local_remember", "plan_exit", "lsp"]
const uploadTools = ["codebase_search"]
const adminTools = ["task", "background_task", "batch"]

function blank() {
  const input = manifest()
  input.risk = "class-0"
  input.classification = "read"
  input.mcp.servers.allow = []
  input.mcp.tools = {}
  input.plugins.allow = []
  input.builtins = {}
  input.filesystem = { readRoots: [], writeRoots: [] }
  input.shell = { action: "deny", patterns: [] }
  input.git = { action: "deny", patterns: [] }
  input.network = { action: "deny", patterns: [] }
  return input
}

test("accepts deterministic credential reference locators", () => {
  const refs = [
    "env:SOURCE_RESEARCHER_API_KEY",
    "env:" + "A".repeat(64),
    "auth:source-researcher",
    "account:source_researcher.1",
    "profile:source-researcher_v2",
    "profile:production-source-researcher-read-only-credential-reference-v2",
    "auth:" + "deadbeef".repeat(8),
  ]

  for (const ref of refs) {
    const input = manifest()
    input.identity.credentialRef = ref
    expect(CapabilityManifest.parse(input).identity.credentialRef).toBe(ref)
  }
})

test("rejects structurally invalid credential references", () => {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "signature"].join(".")
  const refs = [
    "not-a-reference",
    "profile:" + "sk-" + "example-token",
    "auth:" + "ghp_" + "exampletoken",
    "env:AKIA" + "A".repeat(16),
    "auth:https://example.invalid/token",
    "profile:Bearer token",
    "profile:bearer-token",
    "auth:authorization-header",
    "profile:" + jwt,
    "profile:" + "-----BEGIN " + "PRIVATE KEY-----",
    "env: NAME",
    "auth:name/with/slash",
    "auth:name" + String.fromCharCode(92) + "with" + String.fromCharCode(92) + "backslash",
    "account:name:extra",
    "env:lowercase",
    "profile:MixedCase",
  ]

  for (const ref of refs) {
    const input = manifest()
    input.identity.credentialRef = ref
    expect(() => CapabilityManifest.parse(input)).toThrow("strict named credential reference")
  }
})

test("rejects credential references beyond their grammar bounds", () => {
  const env = manifest()
  env.identity.credentialRef = "env:" + "A".repeat(65)
  expect(() => CapabilityManifest.parse(env)).toThrow("strict named credential reference")

  const named = manifest()
  named.identity.credentialRef = "profile:" + "a".repeat(65)
  expect(() => CapabilityManifest.parse(named)).toThrow("strict named credential reference")
})

test("classifies reviewed instruction built-ins at Class 0", () => {
  for (const id of instructionTools) {
    const input = blank()
    input.builtins[id] = "allow"
    expect(CapabilityManifest.parse(input).risk).toBe("class-0")
  }
})

test("requires Class 1 for reviewed local read-only built-ins", () => {
  for (const id of readTools) {
    const input = blank()
    input.builtins[id] = "allow"
    expect(() => CapabilityManifest.parse(input)).toThrow("below required class-1")

    input.risk = "class-1"
    expect(CapabilityManifest.parse(input).risk).toBe("class-1")
  }
})

test("requires Class 2 for reviewed remote-read built-ins", () => {
  for (const id of remoteTools) {
    const input = blank()
    input.risk = "class-1"
    input.builtins[id] = "allow"
    expect(() => CapabilityManifest.parse(input)).toThrow("below required class-2")

    input.risk = "class-2"
    expect(CapabilityManifest.parse(input).risk).toBe("class-2")
  }
})

test("requires Class 3 write classification for reviewed local-write built-ins", () => {
  for (const id of writeTools) {
    const input = blank()
    input.classification = "write"
    input.risk = "class-2"
    input.builtins[id] = "allow"
    expect(() => CapabilityManifest.parse(input)).toThrow("below required class-3")

    input.risk = "class-3"
    expect(CapabilityManifest.parse(input).risk).toBe("class-3")
  }
})

test("requires Class 4 write classification for reviewed remote-upload built-ins", () => {
  for (const id of uploadTools) {
    const input = blank()
    input.classification = "write"
    input.risk = "class-3"
    input.builtins[id] = "allow"
    expect(() => CapabilityManifest.parse(input)).toThrow("below required class-4")

    input.risk = "class-4"
    expect(CapabilityManifest.parse(input).risk).toBe("class-4")
  }
})

test("requires Class 5 admin classification for delegation and privileged built-ins", () => {
  for (const id of adminTools) {
    const input = blank()
    input.classification = "admin"
    input.risk = "class-4"
    input.builtins[id] = "allow"
    expect(() => CapabilityManifest.parse(input)).toThrow("below required class-5")

    input.risk = "class-5"
    expect(CapabilityManifest.parse(input).risk).toBe("class-5")
  }
})

test("fails closed at Class 5 admin for unknown non-denied built-ins", () => {
  const input = blank()
  input.classification = "admin"
  input.risk = "class-4"
  input.builtins.future_tool = "ask"
  expect(() => CapabilityManifest.parse(input)).toThrow("below required class-5")

  input.risk = "class-5"
  expect(CapabilityManifest.parse(input).risk).toBe("class-5")
})

test("unknown denied built-ins grant no authority", () => {
  const input = blank()
  input.builtins.future_tool = "deny"

  expect(CapabilityManifest.parse(input).risk).toBe("class-0")
})

test("read classification rejects every non-read built-in even at Class 5", () => {
  for (const id of [...writeTools, ...uploadTools]) {
    const input = blank()
    input.risk = "class-5"
    input.builtins[id] = "allow"
    expect(() => CapabilityManifest.parse(input)).toThrow("Read classification cannot include write capabilities")
  }

  for (const id of [...adminTools, "future_tool"]) {
    const input = blank()
    input.risk = "class-5"
    input.builtins[id] = "allow"
    expect(() => CapabilityManifest.parse(input)).toThrow("Admin capabilities require admin classification")
  }
})

test("accepts the default read-only orchestrator manifest", () => {
  const input = manifest()
  input.agent = { id: "orchestrator", role: "orchestrator" }
  input.identity = {
    providerID: "orchestrator-provider",
    modelID: "orchestrator-model",
    credentialRef: "profile:orchestrator",
  }
  input.risk = "class-2"
  input.classification = "read"
  input.shell = { action: "deny", patterns: [] }
  input.git = { action: "allow", patterns: read }
  input.filesystem.writeRoots = []

  expect(CapabilityManifest.parse(input).git.patterns).toEqual(read)
})

test("keeps empty MCP allow valid under read classification", () => {
  const input = manifest()

  expect(CapabilityManifest.parse(input).classification).toBe("read")
})

test("requires Class 4 write classification for every untyped MCP grant", () => {
  const input = blank()
  input.classification = "write"
  input.risk = "class-3"
  input.mcp.servers.allow = ["docs"]
  input.mcp.tools.docs = { allow: ["search"], deny: [] }
  expect(() => CapabilityManifest.parse(input)).toThrow("below required class-4")

  input.risk = "class-4"
  expect(CapabilityManifest.parse(input).risk).toBe("class-4")
})

test("rejects MCP grants under read classification even at Class 5", () => {
  const input = blank()
  input.risk = "class-5"
  input.mcp.servers.allow = ["docs"]
  input.mcp.tools.docs = { allow: ["search"], deny: [] }

  expect(() => CapabilityManifest.parse(input)).toThrow("Read classification cannot include write capabilities")
})

test("MCP deny-only configuration grants no authority", () => {
  const input = blank()
  input.mcp.servers.deny.push("docs")

  expect(CapabilityManifest.parse(input).risk).toBe("class-0")
})

test("requires Class 4 write classification for unstructured network grants", () => {
  for (const action of ["allow", "ask"] as const) {
    for (const pattern of ["*", "https://docs.example.invalid"]) {
      const input = blank()
      input.classification = "write"
      input.risk = "class-3"
      input.network = { action, patterns: [pattern] }
      expect(() => CapabilityManifest.parse(input)).toThrow("below required class-4")

      input.risk = "class-4"
      expect(CapabilityManifest.parse(input).risk).toBe("class-4")
    }
  }
})

test("rejects network authority under read classification even at Class 5", () => {
  const input = blank()
  input.risk = "class-5"
  input.network = { action: "allow", patterns: ["*"] }

  expect(() => CapabilityManifest.parse(input)).toThrow("Read classification cannot include write capabilities")
})

test("network deny grants no authority", () => {
  const input = blank()
  input.network = { action: "deny", patterns: ["*"] }

  expect(CapabilityManifest.parse(input).risk).toBe("class-0")
})

test("rejects non-denied empty shell Git and network grants", () => {
  for (const name of ["shell", "git", "network"] as const) {
    for (const action of ["allow", "ask"] as const) {
      const input = blank()
      input[name] = { action, patterns: [] }
      expect(() => CapabilityManifest.parse(input)).toThrow("Non-denied boundary requires at least one pattern")
    }
  }
})

test("requires Class 5 admin classification for runtime plugins", () => {
  const input = blank()
  input.classification = "admin"
  input.risk = "class-4"
  input.plugins.allow = ["sample-plugin"]
  expect(() => CapabilityManifest.parse(input)).toThrow("below required class-5")

  input.risk = "class-5"
  expect(CapabilityManifest.parse(input).risk).toBe("class-5")
})

test("rejects runtime plugins under read or write classification", () => {
  for (const classification of ["read", "write"] as const) {
    const input = blank()
    input.classification = classification
    input.risk = "class-5"
    input.plugins.allow = ["sample-plugin"]
    expect(() => CapabilityManifest.parse(input)).toThrow("Admin capabilities require admin classification")
  }
})

test("empty and deny-only plugin grants add no authority", () => {
  const input = blank()
  input.plugins.deny.push("sample-plugin")

  expect(CapabilityManifest.parse(input).risk).toBe("class-0")
})

test("requires Class 3 for every exact local Git mutation", () => {
  for (const pattern of local) {
    const input = manifest()
    input.classification = "write"
    input.risk = "class-2"
    input.git = { action: "allow", patterns: [pattern] }
    input.network = { action: "deny", patterns: [] }
    expect(() => CapabilityManifest.parse(input)).toThrow("below required class-3")

    input.risk = "class-3"
    expect(CapabilityManifest.parse(input).risk).toBe("class-3")
  }
})

test("requires Class 4 for exact Git push", () => {
  const input = manifest()
  input.classification = "write"
  input.risk = "class-3"
  input.git = { action: "allow", patterns: ["push"] }
  input.network = { action: "deny", patterns: [] }
  expect(() => CapabilityManifest.parse(input)).toThrow("below required class-4")

  input.risk = "class-4"
  expect(CapabilityManifest.parse(input).risk).toBe("class-4")
})

test("requires Class 3 for exact local Git ask", () => {
  for (const pattern of ["checkout", "commit"]) {
    const input = manifest()
    input.classification = "write"
    input.risk = "class-2"
    input.git = { action: "ask", patterns: [pattern] }
    input.network = { action: "deny", patterns: [] }
    expect(() => CapabilityManifest.parse(input)).toThrow("below required class-3")

    input.risk = "class-3"
    expect(CapabilityManifest.parse(input).risk).toBe("class-3")
  }
})

test("requires Class 4 for exact Git push ask", () => {
  const input = manifest()
  input.classification = "write"
  input.risk = "class-3"
  input.git = { action: "ask", patterns: ["push"] }
  input.network = { action: "deny", patterns: [] }
  expect(() => CapabilityManifest.parse(input)).toThrow("below required class-4")

  input.risk = "class-4"
  expect(CapabilityManifest.parse(input).risk).toBe("class-4")
})

test("fails closed at Class 4 for every ambiguous Git pattern", () => {
  for (const action of ["allow", "ask"] as const) {
    for (const pattern of ambiguous) {
      const input = manifest()
      input.classification = "write"
      input.risk = "class-3"
      input.git = { action, patterns: [pattern] }
      input.network = { action: "deny", patterns: [] }
      expect(() => CapabilityManifest.parse(input)).toThrow("below required class-4")

      input.risk = "class-4"
      expect(CapabilityManifest.parse(input).risk).toBe("class-4")
    }
  }
})

test("rejects every non-read-only Git pattern under read classification at any risk", () => {
  for (const pattern of [...local, "push", ...ambiguous]) {
    const input = manifest()
    input.risk = "class-5"
    input.git = { action: "allow", patterns: [pattern] }
    expect(() => CapabilityManifest.parse(input)).toThrow("Read classification cannot include write capabilities")
  }
})

test("keeps Git ask read-only for the exact allowlist", () => {
  const input = manifest()
  input.git = { action: "ask", patterns: read }

  expect(CapabilityManifest.parse(input).git).toEqual({ action: "ask", patterns: read })
})

test("Git deny grants no authority regardless of patterns", () => {
  const input = manifest()
  input.git = { action: "deny", patterns: ["*", "push", "unknown-command"] }

  expect(CapabilityManifest.parse(input).classification).toBe("read")
})

test("rejects shell ask under read classification", () => {
  const input = manifest()
  input.risk = "class-3"
  input.shell = { action: "ask", patterns: ["*"] }

  expect(() => CapabilityManifest.parse(input)).toThrow("Read classification cannot include write capabilities")
})

test("rejects contradictory grants and general wildcards", () => {
  const overlap = manifest()
  overlap.skills.deny.push("repo-state-verification")
  expect(() => CapabilityManifest.parse(overlap)).toThrow("Capability appears in allow and deny")

  for (const field of ["skills", "plugins", "servers"] as const) {
    for (const side of ["allow", "deny"] as const) {
      const input = manifest()
      if (field === "servers") input.mcp.servers[side] = ["*"]
      else input[field][side] = ["*"]
      expect(() => CapabilityManifest.parse(input)).toThrow("Use an exact capability identifier")
    }
  }
})

test("rejects a risk class below the declared authority", () => {
  const input = manifest()
  input.classification = "write"
  input.risk = "class-1"
  input.filesystem.writeRoots = ["${WORKTREE}"]

  expect(() => CapabilityManifest.parse(input)).toThrow("below required class-3")
})

test("rejects read classification with a writable root", () => {
  const input = manifest()
  input.filesystem.writeRoots = ["${WORKTREE}"]

  expect(() => CapabilityManifest.parse(input)).toThrow("Read classification cannot include write capabilities")
})

test("makes the MCP tool wildcard exclusive", () => {
  const wildcard: CapabilityManifest.McpTools = { allow: ["*"], deny: [] }
  expect(CapabilityManifest.McpTools.parse(wildcard)).toEqual(wildcard)

  for (const allow of [
    ["*", "search"],
    ["search", "*"],
  ]) {
    expect(() => CapabilityManifest.McpTools.parse({ allow, deny: [] })).toThrow(
      "MCP tool wildcard must be the only allow entry",
    )
  }
})

test("requires explicit MCP tool grants and rejects deny wildcard", () => {
  const missing = blank()
  missing.classification = "write"
  missing.risk = "class-4"
  missing.mcp.servers.allow = ["docs"]
  expect(() => CapabilityManifest.parse(missing)).toThrow("Allowed MCP server requires an explicit tool grant")

  expect(() => CapabilityManifest.McpTools.parse({ allow: ["search"], deny: ["*"] })).toThrow(
    "Use an exact capability identifier",
  )
})

test("accepts shell ask under write classification with class-3 risk", () => {
  const input = manifest()
  input.classification = "write"
  input.risk = "class-3"
  input.shell = { action: "ask", patterns: ["*"] }
  input.filesystem.writeRoots = ["${WORKTREE}"]
  input.git = { action: "deny", patterns: [] }
  input.network = { action: "deny", patterns: [] }

  expect(CapabilityManifest.parse(input).shell.action).toBe("ask")
})

test("accepts wildcard MCP tool allow with an exact deny", () => {
  const grant: CapabilityManifest.McpTools = { allow: ["*"], deny: ["fetch"] }
  expect(CapabilityManifest.McpTools.parse(grant)).toEqual(grant)
})

test("empty skill plugin and server allow lists expose nothing", () => {
  const input = manifest()
  input.skills.allow = []
  input.plugins.allow = []
  input.mcp.servers.allow = []
  input.mcp.tools = {}
  const parsed = CapabilityManifest.parse(input)
  expect(parsed.skills.allow).toEqual([])
  expect(parsed.plugins.allow).toEqual([])
  expect(parsed.mcp.servers.allow).toEqual([])
})
