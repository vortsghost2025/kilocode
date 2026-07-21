import { Ripgrep } from "../file/ripgrep"

import { Global } from "../global" // kilocode_change
import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent" // kilocode_change
import type { Permission } from "@/permission" // kilocode_change
import { Skill } from "@/skill"
import { CapabilityBundle } from "@/kilocode/capability/bundles"

// kilocode_change start
import SOUL from "../kilocode/soul.txt"
import { staticEnvLines, type EditorContext } from "../kilocode/editor-context"
// kilocode_change end

export namespace SystemPrompt {
  // kilocode_change start
  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function soul() {
    return SOUL.trim()
  }
  // kilocode_change end

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gpt")) {
      if (model.api.id.includes("codex")) {
        return [PROMPT_CODEX]
      }
      return [PROMPT_GPT]
    }
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    return [PROMPT_DEFAULT]
  }

  // kilocode_change start
  export async function environment(model: Provider.Model, editorContext?: EditorContext) {
    // kilocode_change end
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Workspace root folder: ${Instance.worktree}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Project config: .kilo/command/*.md, .kilo/agent/*.md, kilo.json, AGENTS.md. Put new commands and agents in .kilo/. Do not use .kilocode/ or .opencode/.`, // kilocode_change
        `  Global config: ${Global.Path.config}/ (same structure)`, // kilocode_change
        ...staticEnvLines(editorContext), // kilocode_change
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }

  // kilocode_change start
  export async function skills(
    agent: Agent.Info,
    permission?: Permission.Ruleset,
    sessionID?: import("./schema").SessionID,
  ) {
    // Inherited ceilings filter skills before their
    // names and descriptions enter model context.
    const { AuthorityStore } = await import("@/kilocode/capability/authority-store")
    if (sessionID) await AuthorityStore.load(sessionID)
    const { CapabilityAuthority } = await import("@/kilocode/capability/authority")
    const policy = await Agent.policy(agent.name) // kilocode_change
    const ruleset = policy.length > 0 ? policy : agent.permission // kilocode_change
    if (
      CapabilityAuthority.disabled({
        tools: ["skill"],
        role: ruleset,
        agent: agent.permission,
        session: permission,
        sessionID,
      }).has("skill")
    )
      return

    const allAgents = await Agent.list()
    const knownRoles = allAgents
      .filter((a) => !a.hidden)
      .filter((a) => !a.deprecated)
      .map((a) => a.name)

    const allSkills = await Skill.all()
    const discoveredSkills = allSkills.map((s) => s.name)

    const disclosed = await CapabilityBundle.resolveForPrompt({
      repoRoot: Instance.worktree,
      role: agent.name, // kilocode_change
      knownRoles,
      discoveredSkills,
      getAvailableSkills: () => Skill.available(agent, permission, ruleset, sessionID),
    })

    if (disclosed.status === "no-bundle") {
      return "No capability bundle is configured for this agent role. Skills disabled."
    }

    if (disclosed.status === "configured-empty") {
      return "Capability bundle configured with zero disclosed skills."
    }

    if (disclosed.status === "configuration-error") {
      return "[CapabilityBundle: configuration error — skill disclosure unavailable]"
    }

    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      // the agents seem to ingest the information about skills a bit better if we present a more verbose
      // version of them here and a less verbose version in tool description, rather than vice versa.
      Skill.fmt(disclosed.skills, { verbose: true }),
      `## Capability Context: ${disclosed.skills.length} skills, ${disclosed.estimatedContextTokens} estimated tokens per turn (${disclosed.contentCharacters} description characters)`,
    ].join("\n")
  }
  // kilocode_change end
}
