// kilocode_change - new file
import { expect, test } from "bun:test"
import { CapabilityDoctor } from "../../../src/kilocode/capability/doctor"
import { manifest } from "./fixture"

function scan(content: unknown) {
  return CapabilityDoctor.inspect({
    manifest: manifest(),
    now: 0,
    sources: [
      {
        path: ".kilo/config.json",
        scope: "project",
        committed: true,
        skills: [],
        mcp: [],
        plugins: [],
        permissions: [],
        content,
      },
    ],
    servers: [
      {
        name: "docs",
        scope: "project",
        enabled: true,
        transport: "http",
        health: "healthy",
        tools: ["search"],
        estimatedTokens: 100,
        orphaned: false,
      },
    ],
    leases: [],
  })
}

test("reports bounded exposure conflicts health leases and redacted secret paths", () => {
  const raw = "sk-" + "example-secret-123"
  const ref = "profile:" + raw
  const cfg = manifest()
  cfg.classification = "write"
  cfg.risk = "class-4"
  cfg.mcp.servers.allow = ["docs"]
  cfg.mcp.tools.docs = { allow: ["search"], deny: ["write"] }
  const report = CapabilityDoctor.inspect({
    manifest: cfg,
    now: 1_000,
    sources: [
      {
        path: "~/.config/kilo/kilo.jsonc",
        scope: "global",
        committed: false,
        skills: ["repo-state-verification"],
        mcp: ["hidden-global"],
        plugins: [],
        permissions: [],
      },
      {
        path: ".kilo/capabilities/example.json",
        scope: "project",
        committed: true,
        skills: ["repo-state-verification"],
        mcp: ["docs"],
        plugins: [],
        permissions: ["read:allow"],
        content: {
          apiKey: raw,
          credentialRef: ref,
        },
      },
    ],
    servers: [
      {
        name: "docs",
        scope: "project",
        enabled: true,
        transport: "http",
        health: "healthy",
        startupMs: 25,
        tools: ["search", "fetch"],
        estimatedTokens: 320,
        orphaned: false,
      },
      {
        name: "orphan",
        scope: "project",
        enabled: false,
        transport: "stdio",
        health: "failed",
        tools: [],
        estimatedTokens: 0,
        pid: 4242,
        orphaned: true,
      },
    ],
    leases: [
      { id: "lease-active", agent: "source-researcher", capability: "mcp:docs", expiresAt: 2_000 },
      { id: "lease-expired", agent: "source-researcher", capability: "mcp:docs", expiresAt: 500 },
    ],
  })

  expect(report.enabledPlugins).toEqual([])
  expect(report.enabledMcpServers).toEqual(["docs"])
  expect(report.exposedMcpTools).toEqual(["docs_search"])
  expect(report.toolCount).toBe(1)
  expect(report.estimatedContextTokens).toBe(320)
  expect(report.activeLeases).toEqual(["lease-active"])
  expect(report.conflicts).toContain("global-bleed:mcp:hidden-global")
  expect(report.conflicts).toContain("skills:repo-state-verification:global->project")
  expect(report.orphanedProcesses).toEqual([{ server: "orphan", pid: 4242 }])
  expect(report.secretPaths).toEqual(["sources[1].content.apiKey", "sources[1].content.credentialRef"])
  expect(JSON.stringify(report)).not.toContain(ref)
  expect(JSON.stringify(report)).not.toContain(raw)
})

test("uses exact default-deny and wildcard MCP tool selection", () => {
  expect(CapabilityDoctor.selectTools(undefined, ["search", "fetch"])).toEqual([])
  expect(CapabilityDoctor.selectTools({ allow: [], deny: [] }, ["search", "fetch"])).toEqual([])
  expect(CapabilityDoctor.selectTools({ allow: ["*"], deny: [] }, ["search", "fetch"])).toEqual(["search", "fetch"])
  expect(CapabilityDoctor.selectTools({ allow: ["*"], deny: ["fetch"] }, ["search", "fetch"])).toEqual(["search"])
})

test("accepts only complete brace-wrapped environment references", () => {
  const value = "{env:SOURCE_RESEARCHER_API_KEY}"
  const report = scan({
    reference: value,
    apiKey: value,
  })

  expect(report.secretPaths).toEqual([])
})

test("reports malformed brace-wrapped environment references by path only", () => {
  const slash = String.fromCharCode(92)
  const bad = [
    "{env:lowercase}",
    "{env:}",
    "{env:1NAME}",
    "{env:NAME/FILE}",
    "{env:NAME" + slash + "FILE}",
    "{env:NAME WITH SPACE}",
    "{env:NAME:EXTRA}",
    "{env:https://example.invalid/key}",
    "{env:" + "A".repeat(65) + "}",
  ]
  const raw = "sk-" + "direct-example-123"
  const report = scan({
    references: bad,
    apiKey: bad[0],
    direct: raw,
  })
  const paths = [
    "sources[0].content.apiKey",
    "sources[0].content.direct",
    ...bad.map((_, index) => "sources[0].content.references[" + index + "]"),
  ].toSorted()
  const json = JSON.stringify(report)

  expect(report.secretPaths).toEqual(paths)
  for (const value of bad) expect(json).not.toContain(value)
  expect(json).not.toContain(raw)
})

test("valid credentialRef is not reported in secret paths", () => {
  const report = CapabilityDoctor.inspect({
    manifest: manifest(),
    now: 0,
    sources: [
      {
        path: ".kilo/config.json",
        scope: "project",
        committed: true,
        skills: [],
        mcp: [],
        plugins: [],
        permissions: [],
        content: {
          credentialRef: "env:SOURCE_RESEARCHER_API_KEY",
          apiKey: "{env:SOURCE_RESEARCHER_API_KEY}",
        },
      },
    ],
    servers: [
      {
        name: "docs",
        scope: "project",
        enabled: true,
        transport: "http",
        health: "healthy",
        tools: ["search"],
        estimatedTokens: 100,
        orphaned: false,
      },
    ],
    leases: [],
  })
  expect(report.secretPaths).toEqual([])
})

test("allowed server absent from servers list produces missing conflict", () => {
  const m = manifest()
  m.classification = "write"
  m.risk = "class-4"
  m.mcp.servers.allow.push("absent-server")
  m.mcp.tools["absent-server"] = { allow: ["*"], deny: [] }
  const report = CapabilityDoctor.inspect({
    manifest: m,
    now: 0,
    sources: [],
    servers: [
      {
        name: "docs",
        scope: "project",
        enabled: true,
        transport: "http",
        health: "healthy",
        tools: ["search"],
        estimatedTokens: 100,
        orphaned: false,
      },
    ],
    leases: [],
  })
  expect(report.conflicts).toContain("missing:mcp:absent-server")
})

test("empty allow lists expose no skills plugins servers or tools", () => {
  const empty = manifest()
  empty.skills.allow = []
  empty.plugins.allow = []
  empty.mcp.servers.allow = []
  empty.mcp.tools = {}
  const report = CapabilityDoctor.inspect({
    manifest: empty,
    sources: [],
    servers: [
      {
        name: "docs",
        scope: "project",
        enabled: true,
        transport: "http",
        health: "healthy",
        tools: ["search"],
        estimatedTokens: 100,
        orphaned: false,
      },
    ],
    leases: [],
    now: 0,
  })

  expect(report.enabledSkills).toEqual([])
  expect(report.enabledPlugins).toEqual([])
  expect(report.enabledMcpServers).toEqual([])
  expect(report.exposedMcpTools).toEqual([])
})
