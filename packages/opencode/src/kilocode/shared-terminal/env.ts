// Pure environment builder for the Kilo-only shared-terminal service.
//
// This module NEVER reads or mutates process.env inside the transition logic.
// It does NOT call the shell.env plugin hook. It does NOT restore the real
// developer environment. It does NOT log environment values. All inputs are
// injected: the source environment, the platform, explicit isolated paths,
// and an optional TERM value.
//
// The builder emits ONLY the exact allowlisted variables for the platform,
// rewrites profile/temp paths to the injected isolated paths, and forces three
// markers on every platform: TERM, KILO_TERMINAL=1, KILO_SHARED_TERMINAL=1.
// Every variable outside the exact allowlist is absent, regardless of case on
// Windows. Windows lookup is case-insensitive and emits each canonical
// variable exactly once. The source environment and isolated-path input are
// never mutated.

export type Platform = "win32" | "linux" | "darwin" | "aix" | "sunos" | "freebsd" | "openbsd" | "android"

const WINDOWS_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "WINDIR",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const

const POSIX_ALLOWLIST = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const

// Deterministic default TERM suitable for an interactive terminal. Chosen to
// be broadly compatible with color-capable interactive shells without
// depending on a terminfo database that may be absent in an isolated home.
const DEFAULT_TERM = "xterm-256color"

export interface WindowsIsolatedPaths {
  userprofile: string
  home: string
  appdata: string
  localappdata: string
  temp: string
  tmp: string
  homedrive: string
  homepath: string
}

export interface PosixIsolatedPaths {
  home: string
  tmpdir: string
}

export type IsolatedPaths = WindowsIsolatedPaths | PosixIsolatedPaths

export interface BuildInput {
  platform: Platform
  source: Record<string, string>
  isolated: IsolatedPaths
  term?: string
}

function isWindows(p: Platform): boolean {
  return p === "win32"
}

function isPosix(p: Platform): boolean {
  return (
    p === "linux" ||
    p === "darwin" ||
    p === "aix" ||
    p === "sunos" ||
    p === "freebsd" ||
    p === "openbsd" ||
    p === "android"
  )
}

function safeString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  return v
}

// Case-insensitive lookup for Windows. Returns the value for the first source
// key whose lowercase form matches the canonical lowercase name. Iteration
// order follows the source object's own keys; if multiple case-variants
// exist, the canonical allowlist name is emitted once using the value of the
// first matching key encountered.
function windowsLookup(source: Record<string, string>, canonical: string): string | undefined {
  const lower = canonical.toLowerCase()
  for (const key of Object.keys(source)) {
    if (key.toLowerCase() === lower) return safeString(source[key])
  }
  return undefined
}

function posixLookup(source: Record<string, string>, canonical: string): string | undefined {
  // POSIX env is case-sensitive; only the exact canonical name is retained.
  return safeString(source[canonical])
}

export namespace SharedTerminalEnv {
  // Deterministic default TERM value; mirrors the module-level constant so
  // callers can import it from the namespace surface.
  export const DEFAULT_TERM = "xterm-256color"

  // Build a sanitized environment map for a shared terminal. Pure: no IO, no
  // process.env access, no logging. Returns a fresh object; the source and
  // isolated inputs are never mutated.
  export function build(input: BuildInput): Record<string, string> {
    const term = input.term ?? DEFAULT_TERM
    if (isWindows(input.platform)) {
      return buildWindows(input.source, input.isolated as WindowsIsolatedPaths, term)
    }
    if (isPosix(input.platform)) {
      return buildPosix(input.source, input.isolated as PosixIsolatedPaths, term)
    }
    // Unknown platform: fail closed with only the forced markers.
    return { TERM: term, KILO_TERMINAL: "1", KILO_SHARED_TERMINAL: "1" }
  }

  function buildWindows(
    source: Record<string, string>,
    iso: WindowsIsolatedPaths,
    term: string,
  ): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of WINDOWS_ALLOWLIST) {
      // Isolated path rewrites: do NOT retain real-user source values for the
      // rewritten variables. The canonical name is set to the injected path.
      switch (name) {
        case "USERPROFILE":
          env[name] = iso.userprofile
          continue
        case "HOME":
          env[name] = iso.home
          continue
        case "APPDATA":
          env[name] = iso.appdata
          continue
        case "LOCALAPPDATA":
          env[name] = iso.localappdata
          continue
        case "TEMP":
          env[name] = iso.temp
          continue
        case "TMP":
          env[name] = iso.tmp
          continue
        case "HOMEDRIVE":
          env[name] = iso.homedrive
          continue
        case "HOMEPATH":
          env[name] = iso.homepath
          continue
      }
      const v = windowsLookup(source, name)
      if (v !== undefined) env[name] = v
    }
    // Forced markers on every platform. TERM is always set (injected or
    // default), never inherited from the source uncontrolled.
    env["TERM"] = term
    env["KILO_TERMINAL"] = "1"
    env["KILO_SHARED_TERMINAL"] = "1"
    return env
  }

  function buildPosix(source: Record<string, string>, iso: PosixIsolatedPaths, term: string): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of POSIX_ALLOWLIST) {
      // Isolated path rewrites: do NOT retain real-user source values for the
      // rewritten variables.
      switch (name) {
        case "HOME":
          env[name] = iso.home
          continue
        case "TMPDIR":
          env[name] = iso.tmpdir
          continue
        case "TERM":
          // TERM is forced below to the injected/default value; skip source.
          continue
      }
      const v = posixLookup(source, name)
      if (v !== undefined) env[name] = v
    }
    env["TERM"] = term
    env["KILO_TERMINAL"] = "1"
    env["KILO_SHARED_TERMINAL"] = "1"
    return env
  }
}
