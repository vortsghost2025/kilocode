// kilocode_change - new file
// Patch builders for indexing settings. Each returns a minimal config patch
// containing only the indexed indexing field — never a full config snapshot.
// The server's Config.update deep-merges these into config.json, preserving
// all unrelated keys and credentials that live in other config files.

import { IndexingConfig } from "@kilocode/kilo-indexing/config"

export function indexingEnabledPatch(next: boolean): { indexing: { enabled: boolean } } {
  return { indexing: { enabled: next } }
}

export function indexingProviderPatch(next: string): { indexing: { provider: string } } {
  return { indexing: { provider: next } }
}

function providerTitle(v: string): string {
  if (v === "openai-compatible") return "OpenAI Compatible"
  return v.charAt(0).toUpperCase() + v.slice(1)
}

export function getProviderOptions(): Array<{ title: string; value: string }> {
  const field = IndexingConfig.shape.provider as any
  const inner = field._def.innerType ?? field
  const values: string[] = inner.options ?? inner._def.values ?? []
  return values.map((v) => ({ title: providerTitle(v), value: v }))
}
