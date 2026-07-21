import z from "zod"
import { readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "@/util/glob"
import { Skill } from "@/skill"
import { Log } from "@/util/log"

export namespace CapabilityBundle {
  const log = Log.create({ service: "capability-bundle" })

  type Category =
    | "unknown-role"
    | "unknown-skill"
    | "duplicate-pair"
    | "malformed-json"
    | "invalid-schema"
    | "duplicate-id"
    | "configuration-error"

  type Diagnostic = { category: Category; manifestID?: string; roles: string[] }

  class BundleError extends Error {
    constructor(
      message: string,
      readonly diagnostic: Diagnostic,
    ) {
      super(message)
    }
  }

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
    warnings: string[]
  }

  function loadInternal(
    opts: { repoRoot: string; knownRoles: string[]; discoveredSkills: string[] },
    warnings: string[],
    diagnostics: Diagnostic[],
  ): Manifest[] {
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
        throw new BundleError(`Malformed JSON in bundle manifest: ${file}`, {
          category: "malformed-json",
          roles: [],
        })
      }

      const result = ManifestSchema.safeParse(raw)
      if (!result.success) {
        throw new BundleError(`Invalid bundle manifest schema in ${file}: ${result.error.message}`, {
          category: "invalid-schema",
          roles: [],
        })
      }
      const data = result.data

      const roles = data.roles.filter((role) => knownRoles.has(role))
      if (roles.length !== data.roles.length) {
        const firstUnknown = data.roles.find((role) => !knownRoles.has(role))
        throw new BundleError(`Unknown role "${firstUnknown}" in bundle manifest: ${data.id} (${file})`, {
          category: "unknown-role",
          manifestID: data.id,
          roles,
        })
      }

      if (ids.has(data.id)) {
        throw new BundleError(`Duplicate bundle ID: ${data.id}`, {
          category: "duplicate-id",
          manifestID: data.id,
          roles,
        })
      }
      ids.add(data.id)

      const skills: string[] = []
      let hasUnknownSkill = false
      for (const skill of data.skills) {
        if (!discoveredSkills.has(skill)) {
          warnings.push(`Unknown skill "${skill}" in bundle manifest: ${data.id} (${file})`)
          hasUnknownSkill = true
          continue
        }
        skills.push(skill)
      }
      if (hasUnknownSkill) {
        diagnostics.push({ category: "unknown-skill", manifestID: data.id, roles })
      }

      const manifest: Manifest = {
        ...data,
        roles,
        skills,
      }

      for (const role of manifest.roles) {
        for (const skill of manifest.skills) {
          const pair = `${role}:${skill}`
          if (roleSkillPairs.has(pair)) {
            warnings.push(`Duplicate (role, skill) pair across manifests: ${pair} (found in ${manifest.id})`)
            diagnostics.push({ category: "duplicate-pair", manifestID: manifest.id, roles: [role] })
          }
          roleSkillPairs.add(pair)
        }
      }

      manifests.push(manifest)
    }

    return manifests
  }

  export function loadAll(
    opts: { repoRoot: string; knownRoles: string[]; discoveredSkills: string[] },
    warnings: string[] = [],
  ): Manifest[] {
    return loadInternal(opts, warnings, [])
  }

  export function disclose(opts: {
    role: string
    manifests: Manifest[]
    availableSkills: Skill.Info[]
    warnings?: string[]
  }): Disclosed {
    const matched = opts.manifests.filter((m) => m.roles.includes(opts.role))
    const matchedBundles = matched.map((m) => m.id)
    const warnings = opts.warnings ?? []

    if (matchedBundles.length === 0) {
      return {
        status: "no-bundle",
        skills: [],
        matchedBundles: [],
        skillCount: 0,
        contentCharacters: 0,
        estimatedContextTokens: 0,
        warnings,
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
        warnings,
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
      warnings,
    }
  }

  const safeLoad = (opts: {
    repoRoot: string
    knownRoles: string[]
    discoveredSkills: string[]
  }): { manifests: Manifest[] | null; warnings: string[]; diagnostics: Diagnostic[] } => {
    const warnings: string[] = []
    const diagnostics: Diagnostic[] = []
    try {
      const manifests = loadInternal(opts, warnings, diagnostics)
      return { manifests, warnings, diagnostics }
    } catch (err) {
      if (err instanceof BundleError) {
        return { manifests: null, warnings: [err.message], diagnostics: [err.diagnostic] }
      }
      return {
        manifests: null,
        warnings: [err instanceof Error ? err.message : String(err)],
        diagnostics: [{ category: "configuration-error", roles: [] }],
      }
    }
  }

  export async function resolveForPrompt(opts: {
    repoRoot: string
    role: string
    knownRoles: string[]
    discoveredSkills: string[]
    getAvailableSkills: () => Promise<Skill.Info[]>
  }): Promise<Disclosed> {
    const { manifests, warnings, diagnostics } = safeLoad({
      repoRoot: opts.repoRoot,
      knownRoles: opts.knownRoles,
      discoveredSkills: opts.discoveredSkills,
    })
    if (manifests === null) {
      const diag = diagnostics[0]
      const extra: Record<string, string | number> = {
        role: opts.role,
        category: diag.category,
        count: warnings.length,
      }
      if (diag.manifestID && diag.roles.includes(opts.role)) {
        extra.manifestID = diag.manifestID
      }
      log.error("capability bundle configuration error", extra)
      return {
        status: "configuration-error",
        skills: [],
        matchedBundles: [],
        skillCount: 0,
        contentCharacters: 0,
        estimatedContextTokens: 0,
        warnings,
      }
    }
    const availableSkills = await opts.getAvailableSkills()
    const result = disclose({
      role: opts.role,
      manifests,
      availableSkills,
      warnings,
    })
    for (const diag of diagnostics) {
      if (diag.roles.includes(opts.role)) {
        log.warn("capability bundle issue", {
          role: opts.role,
          category: diag.category,
          manifestID: diag.manifestID,
        })
      }
    }
    return result
  }
}

export const ManifestSchema = CapabilityBundle.ManifestSchema
export type Manifest = CapabilityBundle.Manifest
export type Disclosed = CapabilityBundle.Disclosed
export const loadAll = CapabilityBundle.loadAll
export const disclose = CapabilityBundle.disclose
export const resolveForPrompt = CapabilityBundle.resolveForPrompt
