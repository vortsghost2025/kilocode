// kilocode_change - new file
import { expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { CapabilityDoctor } from "../../../src/kilocode/capability/doctor"
import { CapabilityLoader } from "../../../src/kilocode/capability/loader"
import { CapabilityRegistry } from "../../../src/kilocode/capability/registry"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"
import { manifest } from "./fixture"

function value(agent: string) {
  const input = manifest()
  input.agent.id = agent
  input.identity.credentialRef = "profile:" + agent
  return input
}

async function write(root: string, name: string, input: unknown | string) {
  const file = path.join(root, CapabilityLoader.Directory, name)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, typeof input === "string" ? input : JSON.stringify(input))
  return file
}

async function snapshot(root: string) {
  const files = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: root, absolute: false, onlyFiles: true, dot: true }),
  )
  return Promise.all(
    files.toSorted().map(async (file) => ({ file, text: await Bun.file(path.join(root, file)).text() })),
  )
}

test("loads one valid project manifest with source provenance", async () => {
  await using tmp = await tmpdir()
  const source = await write(tmp.path, "source.json", value("source-researcher"))
  const result = await CapabilityLoader.load({ root: tmp.path })

  expect(result.files).toEqual([source])
  expect(result.manifests).toHaveLength(1)
  expect(result.manifests[0].source).toBe(source)
  expect(result.manifests[0].manifest.agent.id).toBe("source-researcher")
  expect(result.failures).toEqual([])
})

test("loads multiple manifests deterministically and ignores Markdown", async () => {
  await using tmp = await tmpdir()
  const zeta = await write(tmp.path, "zeta.json", value("zeta"))
  const alpha = await write(tmp.path, "nested/alpha.json", value("alpha"))
  await write(tmp.path, "README.md", "# planning only")
  await Bun.write(path.join(tmp.path, ".kilo", "capabilities", "A4A.md"), "# not executable")

  const first = await CapabilityLoader.load({ root: tmp.path })
  const second = await CapabilityLoader.load({ root: tmp.path })

  expect(first.files).toEqual([alpha, zeta].toSorted())
  expect(first.manifests.map((entry) => entry.manifest.agent.id)).toEqual(["alpha", "zeta"])
  expect(second).toEqual(first)
})

test("reports malformed JSON and invalid schema by path without values", async () => {
  await using tmp = await tmpdir()
  const malformed = await write(tmp.path, "broken.json", "{not-json")
  const invalid = value("invalid")
  const invalidSource = await write(tmp.path, "invalid.json", { ...invalid, version: 2 })
  const raw = "sk-" + "example-sensitive-value"
  const credential = value("credential")
  credential.identity.credentialRef = raw
  const credentialSource = await write(tmp.path, "credential.json", credential)

  const result = await CapabilityLoader.load({ root: tmp.path })
  const report = CapabilityDoctor.inspectRegistry(CapabilityRegistry.summarize(result))
  const serialized = JSON.stringify({ result, report })

  expect(result.manifests).toEqual([])
  expect(result.failures.map((failure) => failure.source)).toEqual(
    [malformed, credentialSource, invalidSource].toSorted(),
  )
  expect(result.failures.map((failure) => failure.kind).toSorted()).toEqual(["json", "schema", "schema"])
  expect(report.invalidManifestPaths).toEqual([malformed, credentialSource, invalidSource].toSorted())
  expect(report.selected).toBe(false)
  expect(serialized).not.toContain(raw)
})

test("rejects duplicate agent identities and fails closed on lookup", async () => {
  await using tmp = await tmpdir({ git: true })
  const first = await write(tmp.path, "a.json", value("duplicate"))
  const second = await write(tmp.path, "b.json", value("duplicate"))
  const result = await CapabilityLoader.load({ root: tmp.path })

  expect(result.manifests).toEqual([])
  expect(result.duplicateAgentIDs).toEqual(["duplicate"])
  expect(result.failures.map((failure) => failure.source)).toEqual([first, second])
  expect(CapabilityRegistry.summarize(result, "duplicate").selected).toBe(false)

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await CapabilityRegistry.list()).toEqual([])
      expect(await CapabilityRegistry.get("duplicate")).toBeUndefined()
      expect(await CapabilityRegistry.source("duplicate")).toBeUndefined()
      expect(await CapabilityRegistry.duplicates()).toEqual(["duplicate"])
      await Instance.dispose()
    },
  })
})

test("invalid manifests with duplicate identities reject valid peers", async () => {
  await using tmp = await tmpdir()
  const valid = await write(tmp.path, "valid.json", value("duplicate-invalid"))
  const invalid = value("duplicate-invalid")
  const broken = await write(tmp.path, "invalid.json", { ...invalid, version: 2 })

  const result = await CapabilityLoader.load({ root: tmp.path })

  expect(result.manifests).toEqual([])
  expect(result.duplicateAgentIDs).toEqual(["duplicate-invalid"])
  expect(result.failures.map((failure) => failure.source)).toEqual([broken, broken, valid])
  expect(CapabilityRegistry.summarize(result, "duplicate-invalid").selected).toBe(false)
})

test("unknown built-ins retain the Class 5 admin fallback", async () => {
  await using tmp = await tmpdir()
  const low = value("low")
  low.classification = "admin"
  low.risk = "class-4"
  low.builtins.future_tool = "allow"
  const lowSource = await write(tmp.path, "low.json", low)
  const high = value("high")
  high.classification = "admin"
  high.risk = "class-5"
  high.builtins.future_tool = "allow"
  const highSource = await write(tmp.path, "high.json", high)

  const result = await CapabilityLoader.load({ root: tmp.path })

  expect(result.manifests.map((entry) => entry.source)).toEqual([highSource])
  expect(result.failures.map((failure) => failure.source)).toEqual([lowSource])
})

test("scans only the supplied project root and never parent manifests", async () => {
  await using tmp = await tmpdir()
  const project = path.join(tmp.path, "project")
  await mkdir(project, { recursive: true })
  const global = await write(tmp.path, "global.json", value("global"))
  const local = await write(project, "local.json", value("local"))

  const result = await CapabilityLoader.load({ root: project })

  expect(result.files).toEqual([local])
  expect(result.files).not.toContain(global)
  expect(result.manifests.map((entry) => entry.manifest.agent.id)).toEqual(["local"])
})

test("rejects manifest directories linked outside the project", async () => {
  await using tmp = await tmpdir()
  const project = path.join(tmp.path, "project")
  const outside = path.join(tmp.path, "outside")
  const parent = path.join(project, ".kilo", "capabilities")
  await mkdir(parent, { recursive: true })
  await mkdir(outside, { recursive: true })
  await Bun.write(path.join(outside, "outside.json"), JSON.stringify(value("outside")))
  await symlink(outside, path.join(parent, "manifests"), process.platform === "win32" ? "junction" : "dir")

  const result = await CapabilityLoader.load({ root: project })

  expect(result.files).toEqual([])
  expect(result.manifests).toEqual([])
  expect(result.failures).toEqual([
    {
      source: path.join(project, CapabilityLoader.Directory),
      kind: "discovery",
      issues: [{ path: "$", code: "unsafe_directory" }],
    },
  ])
})

test("summarizes locator and capability names without activating or writing", async () => {
  await using tmp = await tmpdir()
  const configured = value("configured")
  configured.classification = "admin"
  configured.risk = "class-5"
  configured.mcp.servers.allow = ["docs-do-not-start"]
  configured.mcp.tools["docs-do-not-start"] = { allow: ["search"], deny: [] }
  configured.plugins.allow = ["plugin-do-not-load"]
  configured.builtins.task = "allow"
  await write(tmp.path, "configured.json", configured)
  const before = await snapshot(tmp.path)

  const result = await CapabilityLoader.load({ root: tmp.path })
  const summary = CapabilityRegistry.summarize(result, "configured")
  const report = CapabilityDoctor.inspectRegistry(summary)
  const after = await snapshot(tmp.path)
  const item = report.manifests[0]

  expect(after).toEqual(before)
  expect(report.projectRoot).toBe(path.resolve(tmp.path))
  expect(report.validManifestCount).toBe(1)
  expect(report.agentIDs).toEqual(["configured"])
  expect(report.selected).toBe(true)
  expect(item.agentID).toBe("configured")
  expect(item.credentialRef).toBe("profile:configured")
  expect(item.skills).toEqual(["bounded-source-patch", "repo-state-verification"])
  expect(item.mcpServers).toEqual(["docs-do-not-start", "write-api"])
  expect(item.plugins).toEqual(["plugin-do-not-load"])
  expect(item.builtins).toEqual(["bash", "edit", "glob", "grep", "read", "task"])
  expect(item.selected).toBe(true)
  expect(report.discoveredManifestFiles).toHaveLength(1)
})

test("source boundary excludes runtime activation and credential resolution", async () => {
  const root = path.resolve(import.meta.dir, "../../../src/kilocode/capability")
  const files = ["loader.ts", "registry.ts", "doctor.ts"]
  const forbidden = [
    'from "@/auth',
    'from "@/config',
    'from "@/global',
    'from "@/mcp',
    'from "@/plugin',
    'from "@/provider',
    "process.env",
    "Bun.spawn",
    "Bun.write",
  ]

  for (const name of files) {
    const source = await Bun.file(path.join(root, name)).text()
    for (const value of forbidden) expect(source).not.toContain(value)
  }
})
