import z from "zod"
import { readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "@/util/glob"
import { Skill } from "@/skill"

export namespace CapabilityBundle {
  export const ManifestSchema = z
    .object({
      id: z.string().regex(/^[a-z0-9-]+$/),
      roles: z.array(z.string()).min(1),
      skills: z.array(z.string()),
      notes: z.string().optional().default(""),
    })
    .strict()
    .superRefine((data, ctx) => {
      if (new Set(data.roles).size !== data.roles.length) {
        ctx.addIssue({ code: "custom", path: ["roles"], message: "Duplicate roles in manifest" })
      }
      if (new Set(data.skills).size !== data.skills.length) {
        ctx.addIssue({ code: "custom", path: ["skills"], message: "Duplicate skills in manifest" })
      }
    })

  export type Manifest = z.infer<typeof ManifestSchema>

  export type Disclosed = {
    status: "ok" | "no-bundle" | "configured-empty" | "configuration-error"
    skills: Skill.Info[]
    matchedBundles: string[]
    skillCount: number
    contentCharacters: number
    estimatedContextTokens: number
  }

  export function loadAll(opts: { repoRoot: string; knownRoles: string[]; discoveredSkills: string[] }): Manifest[] {
    const dir = join(opts.repoRoot, ".kilo", "capability")
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return []
    }

    const files = Glob.scanSync("*.json", { cwd: dir, absolute: true }).toSorted()
    const manifests: Manifest[] = []
    const ids = new Set<string>()
    const roleSkillPairs = new Set<string>()

    const knownRoles = new Set(opts.knownRoles)
    const discoveredSkills = new Set(opts.discoveredSkills)

    for (const file of files) {
      let raw: any
      try {
        raw = JSON.parse(readFileSync(file, "utf-8"))
      } catch (err) {
        throw new Error(`Malformed JSON in bundle manifest: ${file}`)
      }

      const result = ManifestSchema.safeParse(raw)
      if (!result.success) {
        throw new Error(`Invalid bundle manifest schema in ${file}: ${result.error.message}`)
      }
      const manifest = result.data

      if (ids.has(manifest.id)) {
        throw new Error(`Duplicate bundle ID: ${manifest.id}`)
      }
      ids.add(manifest.id)

      for (const role of manifest.roles) {
        if (!knownRoles.has(role)) {
          throw new Error(`Unknown role "${role}" in bundle manifest: ${manifest.id}`)
        }
      }

      for (const skill of manifest.skills) {
        if (!discoveredSkills.has(skill)) {
          throw new Error(`Unknown skill "${skill}" in bundle manifest: ${manifest.id}`)
        }
      }

      for (const role of manifest.roles) {
        for (const skill of manifest.skills) {
          const pair = `${role}:${skill}`
          if (roleSkillPairs.has(pair)) {
            throw new Error(`Duplicate (role, skill) pair across manifests: ${pair} (found in ${manifest.id})`)
          }
          roleSkillPairs.add(pair)
        }
      }

      manifests.push(manifest)
    }

    return manifests
  }

  export function disclose(opts: { role: string; manifests: Manifest[]; availableSkills: Skill.Info[] }): Disclosed {
    const matched = opts.manifests.filter((m) => m.roles.includes(opts.role))
    const matchedBundles = matched.map((m) => m.id)

    if (matchedBundles.length === 0) {
      return {
        status: "no-bundle",
        skills: [],
        matchedBundles: [],
        skillCount: 0,
        contentCharacters: 0,
        estimatedContextTokens: 0,
      }
    }

    const allowedSkillNames = new Set(matched.flatMap((m) => m.skills))
    const skills = opts.availableSkills.filter((s) => allowedSkillNames.has(s.name))

    if (skills.length === 0) {
      return {
        status: "configured-empty",
        skills: [],
        matchedBundles,
        skillCount: 0,
        contentCharacters: 0,
        estimatedContextTokens: 0,
      }
    }

    const contentCharacters = skills.reduce((sum, s) => sum + Array.from(s.description).length, 0)

    return {
      status: "ok",
      skills,
      matchedBundles,
      skillCount: skills.length,
      contentCharacters,
      estimatedContextTokens: Math.ceil(contentCharacters / 4),
    }
  }

  const safeLoad = (opts: {
    repoRoot: string
    knownRoles: string[]
    discoveredSkills: string[]
  }): Manifest[] | null => {
    try {
      return loadAll(opts)
    } catch {
      return null
    }
  }

  export async function resolveForPrompt(opts: {
    repoRoot: string
    role: string
    knownRoles: string[]
    discoveredSkills: string[]
    getAvailableSkills: () => Promise<Skill.Info[]>
  }): Promise<Disclosed> {
    const manifests = safeLoad({
      repoRoot: opts.repoRoot,
      knownRoles: opts.knownRoles,
      discoveredSkills: opts.discoveredSkills,
    })
    if (manifests === null) {
      return {
        status: "configuration-error",
        skills: [],
        matchedBundles: [],
        skillCount: 0,
        contentCharacters: 0,
        estimatedContextTokens: 0,
      }
    }
    const availableSkills = await opts.getAvailableSkills()
    return disclose({
      role: opts.role,
      manifests,
      availableSkills,
    })
  }
}

export const ManifestSchema = CapabilityBundle.ManifestSchema
export type Manifest = CapabilityBundle.Manifest
export type Disclosed = CapabilityBundle.Disclosed
export const loadAll = CapabilityBundle.loadAll
export const disclose = CapabilityBundle.disclose
export const resolveForPrompt = CapabilityBundle.resolveForPrompt
