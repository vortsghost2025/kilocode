import { Instance } from "@/project/instance"
import { CapabilityDoctor } from "./doctor"
import { CapabilityLoader } from "./loader"

export namespace CapabilityRegistry {
  export const SummaryEntry = CapabilityDoctor.RegistryManifest
  export type SummaryEntry = CapabilityDoctor.RegistryManifest

  export const Summary = CapabilityDoctor.RegistryInput
  export type Summary = CapabilityDoctor.RegistryInput

  const state = Instance.state(() => CapabilityLoader.load({ root: Instance.worktree }))

  function names(input: { allow: string[]; deny: string[] }) {
    return [...new Set([...input.allow, ...input.deny])].toSorted()
  }

  function order(a: string, b: string) {
    if (a < b) return -1
    if (a > b) return 1
    return 0
  }

  export function summarize(result: CapabilityLoader.Result, selectedAgentID?: string): Summary {
    const entries = result.manifests
      .map((entry) => ({
        source: entry.source,
        agentID: entry.manifest.agent.id,
        risk: entry.manifest.risk,
        classification: entry.manifest.classification,
        providerID: entry.manifest.identity.providerID,
        modelID: entry.manifest.identity.modelID,
        credentialRef: entry.manifest.identity.credentialRef,
        skills: names(entry.manifest.skills),
        mcpServers: [
          ...new Set([
            ...entry.manifest.mcp.servers.allow,
            ...entry.manifest.mcp.servers.deny,
            ...Object.keys(entry.manifest.mcp.tools),
          ]),
        ].toSorted(),
        plugins: names(entry.manifest.plugins),
        builtins: Object.keys(entry.manifest.builtins).toSorted(),
        selected: selectedAgentID === entry.manifest.agent.id,
      }))
      .toSorted((a, b) => order(a.agentID, b.agentID) || order(a.source, b.source))

    return Summary.parse({
      root: result.root,
      directory: result.directory,
      files: result.files,
      validCount: result.manifests.length,
      invalidPaths: [...new Set(result.failures.map((failure) => failure.source))].toSorted(),
      entries,
      duplicateAgentIDs: result.duplicateAgentIDs,
      selected: entries.some((entry) => entry.selected),
    })
  }

  export async function load() {
    return structuredClone(await state())
  }

  export async function list() {
    return (await load()).manifests
  }

  export async function get(agentID: string) {
    return (await load()).manifests.find((entry) => entry.manifest.agent.id === agentID)
  }

  export async function source(agentID: string) {
    return (await get(agentID))?.source
  }

  export async function failures() {
    return (await load()).failures
  }

  export async function duplicates() {
    return (await load()).duplicateAgentIDs
  }

  export async function summary(selectedAgentID?: string) {
    return summarize(await load(), selectedAgentID)
  }
}
