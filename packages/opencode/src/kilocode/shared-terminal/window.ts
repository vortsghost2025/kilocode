// kilocode_change - new file
// Windows Terminal launcher for the shared-terminal visible window. Resolves
// the wt.exe binary, builds an argv that re-enters THIS source-build of the
// Kilo CLI via `bun run --conditions=browser <entry> shared-terminal ...`,
// restricts the spawned environment to the shared-terminal allowlist plus
// KILO_SHARED_TERMINAL_TICKET, and surfaces spawn-time failures as a Promise
// so the caller can revoke the ticket and dispose the just-created PTY.

import { spawn } from "node:child_process"
import path from "node:path"
import { which } from "../../util/which"

export type LaunchFailureReason = "no_wt" | "spawn_failed" | "no_attach" | "bad_argv"

export type LaunchResult = { ok: true } | { ok: false; reason: LaunchFailureReason; message: string }

export interface LaunchOpts {
  file: string
  args: string[]
  env: Record<string, string>
  cols: number
  rows: number
}

// Build the environment passed to the Windows Terminal child.
//
// Allowlist matches the exact set of variables a source-build Kilo CLI needs
// to discover its profile, config, XDG paths, and runtime. Variables outside
// the allowlist are deliberately discarded so no process.env leak (provider
// keys, Git credentials, SSH agent vars, npm tokens) reaches the spawned
// window.
//
// Profile paths are rooted at S:\KILO-CLEAN-SOURCE\profile — Sean's local
// source-build profile — so the visible shared terminal inherits the same
// developer identity and config the parent Kilo process uses.
export function buildChildEnv(opts: LaunchOpts): Record<string, string> {
  const profile = "S:\\KILO-CLEAN-SOURCE\\profile"

  const ALLOWLIST = [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "KILO_CONFIG",
    "KILO_CONFIG_CONTENT",
    "KILO_BIN_PATH",
    "KILO_EXPERIMENTAL_SHARED_TERMINAL",
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TERM",
  ]

  const env: Record<string, string> = {}
  const src = process.env as Record<string, string>

  for (const name of ALLOWLIST) {
    // Profile-path rewrites: these use the fixed source-build profile dir so
    // the spawned window inherits Sean's developer identity.
    switch (name) {
      case "USERPROFILE":
      case "HOME":
        env[name] = profile
        continue
      case "APPDATA":
        env[name] = path.join(profile, "AppData", "Roaming")
        continue
      case "LOCALAPPDATA":
        env[name] = path.join(profile, "AppData", "Local")
        continue
      case "HOMEDRIVE":
        env[name] = "S:"
        continue
      case "HOMEPATH":
        env[name] = "\\KILO-CLEAN-SOURCE\\profile"
        continue
      case "XDG_CONFIG_HOME":
        env[name] = path.join(profile, "config")
        continue
      case "XDG_DATA_HOME":
        env[name] = path.join(profile, "data")
        continue
      case "XDG_STATE_HOME":
        env[name] = path.join(profile, "state")
        continue
      case "XDG_CACHE_HOME":
        env[name] = path.join(profile, "cache")
        continue
      case "KILO_CONFIG":
      case "KILO_CONFIG_CONTENT":
      case "KILO_BIN_PATH":
      case "KILO_EXPERIMENTAL_SHARED_TERMINAL": {
        const v = src[name]
        if (v !== undefined) env[name] = v
        continue
      }
    }
    // PATH, SystemRoot, ComSpec, PATHEXT, TEMP, TMP, TERM — copy from parent
    const v = src[name]
    if (v !== undefined) env[name] = v
  }

  env["TERM"] = "xterm-256color"
  env["KILO_TERMINAL"] = "1"
  env["KILO_SHARED_TERMINAL"] = "1"

  if (typeof opts.env.KILO_SHARED_TERMINAL_TICKET === "string") {
    env["KILO_SHARED_TERMINAL_TICKET"] = opts.env.KILO_SHARED_TERMINAL_TICKET
  }

  return env
}

// Validate that args supplied for the Windows-Tab child includes the expected
// source-build re-entry shape:
//   run --conditions=browser <entry> shared-terminal <url> <id> [--cols N --rows N]
function validateAttachArgs(args: string[]): LaunchResult | undefined {
  if (args.length < 6) return { ok: false, reason: "bad_argv", message: "args too short" }
  if (args[0] !== "run")
    return { ok: false, reason: "bad_argv", message: `expected 'run' as first arg, got '${args[0]}'` }
  const cmd = args[3]
  if (cmd !== "shared-terminal")
    return { ok: false, reason: "no_attach", message: `expected 'shared-terminal' command, got '${cmd}'` }
  const url = args[4]
  const id = args[5]
  if (!url || !id || !url.startsWith("http") || id.length < 1)
    return { ok: false, reason: "bad_argv", message: "missing url or terminal-id" }
  return undefined
}

// Build a source-attach invocation that re-enters THIS source build of the
// Kilo CLI via bun + the browser conditions flag. The returned {file, args}
// pair is consumed by launchWindow which passes them to `wt new-tab
// <file> <args...>`.
export function buildSourceAttachInvocation(input: {
  scriptPath: string
  url: string
  terminalID: string
  cols: number
  rows: number
}): { file: string; args: string[] } {
  return {
    file: process.execPath,
    args: [
      "run",
      "--conditions=browser",
      input.scriptPath,
      "shared-terminal",
      input.url,
      input.terminalID,
      "--cols",
      String(input.cols),
      "--rows",
      String(input.rows),
    ],
  }
}

// Launch a visible Windows Terminal tab running the shared-terminal attach
// client. Returns a Promise that resolves once the spawn succeeds (or fails).
// The caller must handle non-ok results by revoking the issued ticket and
// disposing the PTY.
export async function launchWindow(opts: LaunchOpts): Promise<LaunchResult> {
  const validation = validateAttachArgs(opts.args)
  if (validation) return validation

  const wt = which("wt")
  if (!wt) {
    return { ok: false, reason: "no_wt", message: "Windows Terminal (wt.exe) not found on PATH" }
  }

  const wtArgs = ["new-tab", opts.file, ...opts.args]
  const childEnv = buildChildEnv(opts)

  return new Promise<LaunchResult>((resolve) => {
    try {
      const child = spawn(wt, wtArgs, {
        env: childEnv,
        stdio: "ignore",
        detached: true,
        windowsHide: false,
        shell: false,
      })
      child.once("error", (err) => {
        resolve({ ok: false, reason: "spawn_failed", message: err.message })
      })
      child.once("spawn", () => {
        child.unref()
        resolve({ ok: true })
      })
    } catch (err) {
      resolve({ ok: false, reason: "spawn_failed", message: String(err) })
    }
  })
}
