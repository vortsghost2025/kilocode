import { normalizePath, type ProtectedPaths } from "./manifest"

export type DiffResult = {
  missing: string[]
  extras: string[]
  protected: string[]
  duplicates: string[]
  pass: boolean
}

export function diffScope(input: { scope: string[]; staged: string[]; protectedPaths: ProtectedPaths }): DiffResult {
  const scope = input.scope.map(normalizePath)
  const staged = input.staged.map(normalizePath)
  const approved = new Set(scope)
  const observed = new Set(staged)
  const counts = staged.reduce((all, item) => all.set(item, (all.get(item) ?? 0) + 1), new Map<string, number>())
  const missing = [...approved].filter((item) => !observed.has(item)).sort()
  const extras = [...observed].filter((item) => !approved.has(item)).sort()
  const protectedPaths = [...observed]
    .filter(
      (item) =>
        input.protectedPaths.exact.includes(item) ||
        input.protectedPaths.prefix.some((prefix) => item.startsWith(prefix)),
    )
    .sort()
  const duplicates = [...counts]
    .filter((entry) => entry[1] > 1)
    .map((entry) => entry[0])
    .sort()
  const pass = missing.length === 0 && extras.length === 0 && protectedPaths.length === 0 && duplicates.length === 0
  return { missing, extras, protected: protectedPaths, duplicates, pass }
}
