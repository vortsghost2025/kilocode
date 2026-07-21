import { describe, test, expect } from "bun:test"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { CapabilityBundle } from "@/kilocode/capability/bundles"
import { Skill } from "@/skill"

describe("CapabilityBundle", () => {
  describe("loadAll", () => {
    test("empty dir: .kilo/capability/ doesn't exist", async () => {
      await using tmp = await tmpdir()
      const manifests = CapabilityBundle.loadAll({
        repoRoot: tmp.path,
        knownRoles: [],
        discoveredSkills: [],
      })
      expect(manifests).toEqual([])
    })

    test("empty capability dir: .kilo/capability/ exists but empty", async () => {
      await using tmp = await tmpdir()
      await mkdir(join(tmp.path, ".kilo", "capability"), { recursive: true })
      const manifests = CapabilityBundle.loadAll({
        repoRoot: tmp.path,
        knownRoles: [],
        discoveredSkills: [],
      })
      expect(manifests).toEqual([])
    })

    test("single valid bundle", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(
        join(dir, "test.json"),
        JSON.stringify({ id: "test-bundle", roles: ["developer"], skills: ["coding"] }),
      )

      const manifests = CapabilityBundle.loadAll({
        repoRoot: tmp.path,
        knownRoles: ["developer"],
        discoveredSkills: ["coding"],
      })
      expect(manifests).toEqual([{ id: "test-bundle", roles: ["developer"], skills: ["coding"], notes: "" }])
    })

    test("multiple valid bundles", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "b1.json"), JSON.stringify({ id: "b1", roles: ["r1"], skills: ["s1"] }))
      await Bun.write(join(dir, "b2.json"), JSON.stringify({ id: "b2", roles: ["r2"], skills: ["s2"] }))

      const manifests = CapabilityBundle.loadAll({
        repoRoot: tmp.path,
        knownRoles: ["r1", "r2"],
        discoveredSkills: ["s1", "s2"],
      })
      expect(manifests).toEqual([
        { id: "b1", roles: ["r1"], skills: ["s1"], notes: "" },
        { id: "b2", roles: ["r2"], skills: ["s2"], notes: "" },
      ])
    })

    test("malformed JSON", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "bad.json"), "{ invalid json }")

      expect(() =>
        CapabilityBundle.loadAll({
          repoRoot: tmp.path,
          knownRoles: [],
          discoveredSkills: [],
        }),
      ).toThrow(/Malformed JSON/)
    })

    test("schema violation (missing required field)", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "invalid.json"), JSON.stringify({ id: "test" })) // missing roles, skills

      expect(() =>
        CapabilityBundle.loadAll({
          repoRoot: tmp.path,
          knownRoles: [],
          discoveredSkills: [],
        }),
      ).toThrow(/Invalid bundle manifest schema/)
    })

    test("unknown role", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "test.json"), JSON.stringify({ id: "test", roles: ["unknown"], skills: [] }))

      expect(() =>
        CapabilityBundle.loadAll({
          repoRoot: tmp.path,
          knownRoles: ["known"],
          discoveredSkills: [],
        }),
      ).toThrow(/Unknown role "unknown"/)
    })

    test("unknown skill", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "test.json"), JSON.stringify({ id: "test", roles: ["role"], skills: ["unknown"] }))

      const warnings: string[] = []
      const manifests = CapabilityBundle.loadAll(
        {
          repoRoot: tmp.path,
          knownRoles: ["role"],
          discoveredSkills: ["known"],
        },
        warnings,
      )
      expect(manifests).toEqual([{ id: "test", roles: ["role"], skills: [], notes: "" }])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('Unknown skill "unknown"')
    })

    test("duplicate ID across files", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      const m = { id: "same", roles: ["r1"], skills: [] }
      await Bun.write(join(dir, "a.json"), JSON.stringify(m))
      await Bun.write(join(dir, "b.json"), JSON.stringify(m))

      expect(() =>
        CapabilityBundle.loadAll({
          repoRoot: tmp.path,
          knownRoles: ["r1"],
          discoveredSkills: [],
        }),
      ).toThrow(/Duplicate bundle ID: same/)
    })

    test("duplicate role inside one manifest", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "test.json"), JSON.stringify({ id: "test", roles: ["r1", "r1"], skills: [] }))

      expect(() =>
        CapabilityBundle.loadAll({
          repoRoot: tmp.path,
          knownRoles: ["r1"],
          discoveredSkills: [],
        }),
      ).toThrow(/Duplicate roles in manifest/)
    })

    test("duplicate skill inside one manifest", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "test.json"), JSON.stringify({ id: "test", roles: ["r1"], skills: ["s1", "s1"] }))

      expect(() =>
        CapabilityBundle.loadAll({
          repoRoot: tmp.path,
          knownRoles: ["r1"],
          discoveredSkills: ["s1"],
        }),
      ).toThrow(/Duplicate skills in manifest/)
    })

    test("cross-manifest conflict (same role+skill in two bundles)", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "a.json"), JSON.stringify({ id: "a", roles: ["r1"], skills: ["s1"] }))
      await Bun.write(join(dir, "b.json"), JSON.stringify({ id: "b", roles: ["r1"], skills: ["s1"] }))

      const warnings: string[] = []
      const manifests = CapabilityBundle.loadAll(
        {
          repoRoot: tmp.path,
          knownRoles: ["r1"],
          discoveredSkills: ["s1"],
        },
        warnings,
      )

      expect(manifests).toEqual([
        { id: "a", roles: ["r1"], skills: ["s1"], notes: "" },
        { id: "b", roles: ["r1"], skills: ["s1"], notes: "" },
      ])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("Duplicate (role, skill) pair across manifests")
    })

    test("omitted notes normalize to empty string", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "test.json"), JSON.stringify({ id: "test", roles: ["r1"], skills: ["s1"] }))

      const manifests = CapabilityBundle.loadAll({
        repoRoot: tmp.path,
        knownRoles: ["r1"],
        discoveredSkills: ["s1"],
      })
      expect(manifests).toEqual([{ id: "test", roles: ["r1"], skills: ["s1"], notes: "" }])
    })
  })

  describe("disclose", () => {
    test("role not in any manifest", () => {
      const result = CapabilityBundle.disclose({
        role: "admin",
        manifests: [{ id: "b1", roles: ["user"], skills: [], notes: "" }],
        availableSkills: [],
      })
      expect(result.status).toBe("no-bundle")
      expect(result.skills).toEqual([])
    })

    test("role in manifest with zero declared skills", () => {
      const result = CapabilityBundle.disclose({
        role: "user",
        manifests: [{ id: "b1", roles: ["user"], skills: [], notes: "" }],
        availableSkills: [],
      })
      expect(result.status).toBe("configured-empty")
      expect(result.skills).toEqual([])
    })

    test("role in manifest with all skills available", () => {
      const skills: Skill.Info[] = [{ name: "s1", description: "desc1" } as any]
      const result = CapabilityBundle.disclose({
        role: "user",
        manifests: [{ id: "b1", roles: ["user"], skills: ["s1"], notes: "" }],
        availableSkills: skills,
      })
      expect(result.status).toBe("ok")
      expect(result.skills).toEqual(skills)
    })

    test("some skills not in availableSkills", () => {
      const skills: Skill.Info[] = [{ name: "s1", description: "desc1" } as any]
      const result = CapabilityBundle.disclose({
        role: "user",
        manifests: [{ id: "b1", roles: ["user"], skills: ["s1", "s2"], notes: "" }],
        availableSkills: skills,
      })
      expect(result.status).toBe("ok")
      expect(result.skills).toEqual(skills)
    })

    test("all skills excluded by availableSkills", () => {
      const result = CapabilityBundle.disclose({
        role: "user",
        manifests: [{ id: "b1", roles: ["user"], skills: ["s1"], notes: "" }],
        availableSkills: [],
      })
      expect(result.status).toBe("configured-empty")
      expect(result.skills).toEqual([])
    })

    test("context-cost calculation", () => {
      const skills: Skill.Info[] = [
        { name: "s1", description: "1234" } as any,
        { name: "s2", description: "5678" } as any,
      ]
      const result = CapabilityBundle.disclose({
        role: "user",
        manifests: [{ id: "b1", roles: ["user"], skills: ["s1", "s2"], notes: "" }],
        availableSkills: skills,
      })
      expect(result.contentCharacters).toBe(8)
      expect(result.estimatedContextTokens).toBe(2)
    })
  })

  describe("resolveForPrompt", () => {
    test("successful path", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "test.json"), JSON.stringify({ id: "test", roles: ["r1"], skills: ["s1"] }))

      const skills: Skill.Info[] = [{ name: "s1", description: "desc" } as any]
      const result = await CapabilityBundle.resolveForPrompt({
        repoRoot: tmp.path,
        role: "r1",
        knownRoles: ["r1"],
        discoveredSkills: ["s1"],
        getAvailableSkills: async () => skills,
      })

      expect(result.status).toBe("ok")
      expect(result.skills).toEqual(skills)
    })

    test("loadAll throws -> configuration-error", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "bad.json"), "{ invalid }")

      const result = await CapabilityBundle.resolveForPrompt({
        repoRoot: tmp.path,
        role: "r1",
        knownRoles: ["r1"],
        discoveredSkills: ["s1"],
        getAvailableSkills: async () => [],
      })

      expect(result.status).toBe("configuration-error")
    })

    test("no-bundle through resolveForPrompt", async () => {
      await using tmp = await tmpdir()
      const result = await CapabilityBundle.resolveForPrompt({
        repoRoot: tmp.path,
        role: "r1",
        knownRoles: ["r1"],
        discoveredSkills: ["s1"],
        getAvailableSkills: async () => [],
      })

      expect(result.status).toBe("no-bundle")
    })

    test("getAvailableSkills rejection propagates (not configuration-error)", async () => {
      await using tmp = await tmpdir()
      const dir = join(tmp.path, ".kilo", "capability")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "test.json"), JSON.stringify({ id: "test", roles: ["r1"], skills: ["s1"] }))

      await expect(
        CapabilityBundle.resolveForPrompt({
          repoRoot: tmp.path,
          role: "r1",
          knownRoles: ["r1"],
          discoveredSkills: ["s1"],
          getAvailableSkills: async () => {
            throw new Error("authority denied")
          },
        }),
      ).rejects.toThrow("authority denied")
    })
  })
})
