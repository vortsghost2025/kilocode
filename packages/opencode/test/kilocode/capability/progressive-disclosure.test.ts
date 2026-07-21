import { describe, test, expect, spyOn } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolveForPrompt } from "@/kilocode/capability/bundles"
import { Log } from "@/util/log"

describe("CapabilityBundle Progressive Disclosure", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "kilo-test-"))
    const capDir = join(root, ".kilo", "capability")
    mkdirSync(capDir, { recursive: true })
    return { root, capDir }
  }

  test("Valid agent receives expected skill disclosure", async () => {
    const { root, capDir } = setup()
    try {
      writeFileSync(
        join(capDir, "test-agent.json"),
        JSON.stringify({
          id: "test-agent",
          roles: ["test-role"],
          skills: ["kilo-config"],
        }),
      )

      const result = await resolveForPrompt({
        repoRoot: root,
        role: "test-role",
        knownRoles: ["test-role"],
        discoveredSkills: ["kilo-config"],
        getAvailableSkills: async () => [
          { name: "kilo-config", description: "Test config skill", location: "builtin", content: "" },
        ],
      })

      expect(result.status).toBe("ok")
      expect(result.skills).toHaveLength(1)
      expect(result.skills[0].name).toBe("kilo-config")
      expect(result.matchedBundles).toEqual(["test-agent"])
      expect(result.warnings).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("Unknown role fails closed", async () => {
    const { root, capDir } = setup()
    try {
      // Create a manifest with an unknown role (one not in knownRoles)
      writeFileSync(
        join(capDir, "test-agent.json"),
        JSON.stringify({
          id: "test-agent",
          roles: ["test-role", "unknown-role"],
          skills: ["kilo-config"],
        }),
      )

      const result = await resolveForPrompt({
        repoRoot: root,
        role: "test-role",
        knownRoles: ["test-role"],
        discoveredSkills: ["kilo-config"],
        getAvailableSkills: async () => [
          { name: "kilo-config", description: "Test config skill", location: "builtin", content: "" },
        ],
      })

      expect(result.status).toBe("configuration-error")
      expect(result.skills).toHaveLength(0)
      expect(result.matchedBundles).toHaveLength(0)
      expect(result.warnings.some((w) => w.includes('Unknown role "unknown-role"'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("Unknown skill in manifest produces warning", async () => {
    const { root, capDir } = setup()
    try {
      writeFileSync(
        join(capDir, "test-agent.json"),
        JSON.stringify({
          id: "test-agent",
          roles: ["test-role"],
          skills: ["kilo-config", "nonexistent-skill"],
        }),
      )

      const result = await resolveForPrompt({
        repoRoot: root,
        role: "test-role",
        knownRoles: ["test-role"],
        discoveredSkills: ["kilo-config"],
        getAvailableSkills: async () => [
          { name: "kilo-config", description: "Test config skill", location: "builtin", content: "" },
        ],
      })

      expect(result.status).toBe("ok")
      expect(result.skills).toHaveLength(1)
      expect(result.skills[0].name).toBe("kilo-config")
      expect(result.warnings.some((w) => w.includes('Unknown skill "nonexistent-skill"'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("Malformed manifests fail closed (invalid JSON)", async () => {
    const { root, capDir } = setup()
    const error = spyOn(Log.create({ service: "capability-bundle" }), "error").mockImplementation(() => {})
    try {
      writeFileSync(join(capDir, "bad.json"), "{invalid")

      const result = await resolveForPrompt({
        repoRoot: root,
        role: "test-role",
        knownRoles: ["test-role"],
        discoveredSkills: [],
        getAvailableSkills: async () => [],
      })

      expect(result.status).toBe("configuration-error")
      expect(result.skills).toHaveLength(0)

      expect(error).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith("capability bundle configuration error", {
        role: "test-role",
        category: "malformed-json",
        count: 1,
      })

      const serialized = JSON.stringify(error.mock.calls)
      expect(serialized).not.toContain(root)
      expect(serialized).not.toContain("bad.json")
      expect(serialized).not.toContain("{invalid")
      expect(serialized).not.toContain("Malformed JSON")
      expect(serialized).not.toContain("manifestID")
    } finally {
      error.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("Malformed manifests fail closed (invalid schema)", async () => {
    const { root, capDir } = setup()
    try {
      writeFileSync(
        join(capDir, "bad-schema.json"),
        JSON.stringify({
          id: "ID with SPACES",
          roles: ["test-role"],
          skills: [],
        }),
      )

      const result = await resolveForPrompt({
        repoRoot: root,
        role: "test-role",
        knownRoles: ["test-role"],
        discoveredSkills: [],
        getAvailableSkills: async () => [],
      })

      expect(result.status).toBe("configuration-error")
      expect(result.warnings.some((w) => w.includes("Invalid bundle manifest schema"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("Unrelated agent receives no disclosure", async () => {
    const { root, capDir } = setup()
    try {
      writeFileSync(
        join(capDir, "test-agent.json"),
        JSON.stringify({
          id: "test-agent",
          roles: ["test-role"],
          skills: ["kilo-config"],
        }),
      )

      const result = await resolveForPrompt({
        repoRoot: root,
        role: "other-role",
        knownRoles: ["test-role", "other-role"],
        discoveredSkills: ["kilo-config"],
        getAvailableSkills: async () => [
          { name: "kilo-config", description: "Test config skill", location: "builtin", content: "" },
        ],
      })

      expect(result.status).toBe("no-bundle")
      expect(result.skills).toHaveLength(0)
      expect(result.matchedBundles).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("Multiple manifests for one role union their skills", async () => {
    const { root, capDir } = setup()
    try {
      writeFileSync(
        join(capDir, "manifest-a.json"),
        JSON.stringify({ id: "manifest-a", roles: ["test-role"], skills: ["kilo-config"] }),
      )
      writeFileSync(
        join(capDir, "manifest-b.json"),
        JSON.stringify({ id: "manifest-b", roles: ["test-role"], skills: ["brainstorming"] }),
      )

      const result = await resolveForPrompt({
        repoRoot: root,
        role: "test-role",
        knownRoles: ["test-role"],
        discoveredSkills: ["kilo-config", "brainstorming"],
        getAvailableSkills: async () => [
          { name: "kilo-config", description: "Config", location: "builtin", content: "" },
          { name: "brainstorming", description: "Brainstorm", location: "builtin", content: "" },
        ],
      })

      expect(result.status).toBe("ok")
      expect(result.skills).toHaveLength(2)
      expect(result.skills.map((s) => s.name).sort()).toEqual(["brainstorming", "kilo-config"])
      expect(result.matchedBundles).toContain("manifest-a")
      expect(result.matchedBundles).toContain("manifest-b")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("Empty skills array returns configured-empty", async () => {
    const { root, capDir } = setup()
    try {
      writeFileSync(
        join(capDir, "empty-skills.json"),
        JSON.stringify({ id: "empty-skills", roles: ["test-role"], skills: [] }),
      )

      const result = await resolveForPrompt({
        repoRoot: root,
        role: "test-role",
        knownRoles: ["test-role"],
        discoveredSkills: [],
        getAvailableSkills: async () => [],
      })

      expect(result.status).toBe("configured-empty")
      expect(result.skills).toHaveLength(0)
      expect(result.matchedBundles).toEqual(["empty-skills"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("All unknown skills returns configured-empty with warnings", async () => {
    const { root, capDir } = setup()
    try {
      writeFileSync(
        join(capDir, "all-unknown.json"),
        JSON.stringify({ id: "all-unknown", roles: ["test-role"], skills: ["nonexistent-a", "nonexistent-b"] }),
      )

      const result = await resolveForPrompt({
        repoRoot: root,
        role: "test-role",
        knownRoles: ["test-role"],
        discoveredSkills: [],
        getAvailableSkills: async () => [],
      })

      expect(result.status).toBe("configured-empty")
      expect(result.skills).toHaveLength(0)
      expect(result.matchedBundles).toEqual(["all-unknown"])
      expect(result.warnings.filter((w) => w.includes("nonexistent-a"))).toHaveLength(1)
      expect(result.warnings.filter((w) => w.includes("nonexistent-b"))).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("Duplicate role/skill pair produces warning without duplicate disclosure", async () => {
    const { root, capDir } = setup()
    try {
      writeFileSync(
        join(capDir, "manifest-a.json"),
        JSON.stringify({ id: "manifest-a", roles: ["test-role"], skills: ["kilo-config"] }),
      )
      writeFileSync(
        join(capDir, "manifest-b.json"),
        JSON.stringify({ id: "manifest-b", roles: ["test-role"], skills: ["kilo-config"] }),
      )

      const result = await resolveForPrompt({
        repoRoot: root,
        role: "test-role",
        knownRoles: ["test-role"],
        discoveredSkills: ["kilo-config"],
        getAvailableSkills: async () => [
          { name: "kilo-config", description: "Config", location: "builtin", content: "" },
        ],
      })

      expect(result.status).toBe("ok")
      expect(result.skills).toHaveLength(1)
      expect(result.skills[0].name).toBe("kilo-config")
      expect(result.matchedBundles).toContain("manifest-a")
      expect(result.matchedBundles).toContain("manifest-b")
      expect(result.warnings.some((w) => w.includes("Duplicate"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("Notes field is valid and ignored", async () => {
    const { root, capDir } = setup()
    try {
      writeFileSync(
        join(capDir, "with-notes.json"),
        JSON.stringify({ id: "with-notes", roles: ["test-role"], skills: ["kilo-config"], notes: "Test note content" }),
      )

      const result = await resolveForPrompt({
        repoRoot: root,
        role: "test-role",
        knownRoles: ["test-role"],
        discoveredSkills: ["kilo-config"],
        getAvailableSkills: async () => [
          { name: "kilo-config", description: "Config", location: "builtin", content: "" },
        ],
      })

      expect(result.status).toBe("ok")
      expect(result.skills).toHaveLength(1)
      expect(result.skills[0].name).toBe("kilo-config")
      expect(result.matchedBundles).toEqual(["with-notes"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("Empty capability directory returns no-bundle", async () => {
    const { root } = setup()
    try {
      const result = await resolveForPrompt({
        repoRoot: root,
        role: "test-role",
        knownRoles: ["test-role"],
        discoveredSkills: [],
        getAvailableSkills: async () => [],
      })

      expect(result.status).toBe("no-bundle")
      expect(result.skills).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
