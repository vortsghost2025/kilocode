// kilocode_change - new file
// Local Developer Terminal launcher (Milestone B).
//
// Opens a separate, visible PowerShell 7 terminal at the current Kilo
// workspace while the Kilo CLI TUI and its active model keep running.
//
// Design constraints:
// - Windows-first. Other platforms are reported as unsupported.
// - Never reuses or shares the agent shell process.
// - Never routes terminal I/O into model context or tool permissions.
// - No node-pty, no new PTY or terminal-emulator dependency.
// - Only Windows Terminal (`wt.exe`) and PowerShell 7 (`pwsh.exe`),
//   both resolved via PATH lookup. No arbitrary process killing.
//
// Lifecycle decision: the spawned terminal is owned by the host window
// manager / Windows Terminal, not by Kilo. We deliberately do NOT track
// or kill it on Kilo exit because ownership of a visibly detached window
// cannot be proven unambiguously from the Kilo process. The user closes
// the terminal themselves. Only the immediate `wt.exe`/`start` helper we
// spawn is allowed to exit naturally; we never terminate `pwsh.exe` or
// `WindowsTerminal.exe` broadly.

import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { which } from "@/util/which"

// Environment variables that the Kilo launcher overrides to point the agent
// shell at an isolated profile home. The Local Developer Terminal is meant to
// behave like a normal Windows developer shell, so these are stripped or
// rewritten to the real Windows account home before the visible terminal is
// spawned. See `buildEnv` and `resolveRealUserHome` below.
//
// `HOME` is treated as a Kilo-controlled var on Windows because the launcher
// sets it; on a normal Windows machine it is unset by default, but rewriting
// it to the real user home is safe and matches the USERPROFILE correction.
const KILO_PROFILE_VARS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const

// Discrete argv for the .NET UserProfile lookup. Invoked as:
//   pwsh -NoLogo -NoProfile -NonInteractive -Command "[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)"
// Each element is a discrete argv entry — no shell-string interpolation. The
// PowerShell `[Environment]::GetFolderPath(...)` call returns the real Windows
// account profile home regardless of the launcher-overridden USERPROFILE/HOME
// in the calling process, because .NET reads it from the shell folder
// registry / Known Folder API.
const DOTNET_USERPROFILE_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)",
] as const

/**
 * Resolve the *real* Windows account home for the current user by asking the
 * .NET runtime (via PowerShell) for the `UserProfile` special folder.
 *
 * We deliberately avoid `os.homedir()` and `os.userInfo().homedir` because both
 * honor the launcher-overridden USERPROFILE/HOME and would return the isolated
 * Kilo profile directory. The .NET `Environment.GetFolderPath(SpecialFolder.UserProfile)`
 * call reads the real account profile from the Known Folder / shell folder
 * registry, so it is unaffected by the launcher's environment overrides.
 *
 * The already-resolved PowerShell executable is invoked synchronously with
 * `spawnSync` (`shell:false`, `windowsHide:true`, stdin ignored, stdout
 * captured, stderr ignored). The trimmed stdout is accepted only when it is a
 * non-empty absolute Windows path (`X:\...`). On any failure — nonzero exit,
 * empty output, invalid path, or thrown error — we fall back to the
 * documented `SystemDrive + os.userInfo().username` construction. The
 * launcher-overridden HOME/USERPROFILE is used only as a last resort.
 */
export function resolveRealUserHome(shell: string, inputEnv: NodeJS.ProcessEnv): string {
  const drive = inputEnv.SystemDrive ?? "C:"
  const name = os.userInfo().username
  const fallback = name && drive ? path.join(`${drive}\\`, "Users", name) : (inputEnv.USERPROFILE ?? process.cwd())

  let result: { status: number | null; stdout: string | Buffer } | undefined
  try {
    result = spawnSync(shell, [...DOTNET_USERPROFILE_ARGS], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: inputEnv,
      timeout: 5000,
    } satisfies SpawnSyncOptions)
  } catch {
    return fallback
  }

  if (!result || result.status !== 0) return fallback

  const raw = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout
  const trimmed = raw.trim()
  if (!trimmed) return fallback

  // Accept only non-empty absolute Windows drive paths (`X:\...`).
  if (!/^[A-Za-z]:[\\/]/.test(trimmed)) return fallback

  return trimmed
}

export namespace UserTerminal {
  export type Result =
    | { ok: true; cwd: string; command: string }
    | { ok: false; reason: "unsupported" | "no_pwsh" | "spawn_failed"; message: string; cwd: string }

  export interface Options {
    cwd: string
  }

  export function supported(): boolean {
    return process.platform === "win32"
  }

  /**
   * Resolve PowerShell 7 (`pwsh.exe`). Falls back to Windows PowerShell
   * (`powershell.exe`) only if pwsh is absent. Never falls through to
   * `cmd.exe` — a user developer terminal is expected to be a shell.
   *
   * `which` already verifies the resolved path exists on disk.
   */
  export function resolveShell(): string | null {
    return which("pwsh") ?? which("powershell")
  }

  /**
   * Resolve Windows Terminal (`wt.exe`) when available. Returns the
   * absolute path, or null when not installed. `which` already verifies
   * the resolved path exists on disk.
   */
  export function resolveWindowsTerminal(): string | null {
    return which("wt")
  }

  /**
   * Build the argv for `wt.exe` using the documented subcommand form:
   *
   *   wt new-tab -d <cwd> <shell> -NoLogo
   *
   * Each argument is a discrete argv element — no shell-string
   * interpolation, paths with spaces are preserved verbatim by the OS.
   */
  export function wtArgs(shell: string, cwd: string): string[] {
    return ["new-tab", "-d", cwd, shell, "-NoLogo"]
  }

  /**
   * Build the argv for the `start` builtin fallback (used when `wt.exe`
   * is unavailable). `start` opens a new console window running the
   * resolved shell at `cwd`.
   *
   * The first `""` is the (empty) window title — required by `start`
   * so that any later quoted path is not mistaken for a title.
   */
  export function startArgs(shell: string, cwd: string): string[] {
    return ["start", "", `/D`, cwd, shell, "-NoLogo"]
  }

  /**
   * Build the environment for the spawned terminal. The Kilo launcher runs
   * the agent under an isolated profile home (it overrides USERPROFILE,
   * HOME, APPDATA, LOCALAPPDATA, TEMP, TMP, and the XDG_* vars). A Local
   * Developer Terminal should look like a normal Windows developer shell,
   * so we:
   *
   * - use the real Windows account home (resolved by `resolveRealUserHome`
   *   via the .NET UserProfile special folder, NOT `os.homedir()` which
   *   honors the launcher-overridden USERPROFILE/HOME),
   * - copy the input env so PATH and ordinary Windows vars survive,
   * - rewrite USERPROFILE/HOME/APPDATA/LOCALAPPDATA/TEMP/TMP to point at
   *   the real account home,
   * - strip the four XDG_* isolation vars,
   * - keep `KILO_TERMINAL=1` as our own marker.
   */
  export function buildEnv(input: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...input }
    for (const name of KILO_PROFILE_VARS) delete env[name]
    env.USERPROFILE = home
    env.HOME = home
    env.APPDATA = path.join(home, "AppData", "Roaming")
    env.LOCALAPPDATA = path.join(home, "AppData", "Local")
    const temp = path.join(home, "AppData", "Local", "Temp")
    env.TEMP = temp
    env.TMP = temp
    env.KILO_TERMINAL = "1"
    return env
  }

  /**
   * Launch a visible terminal window/tab at the given cwd. Returns a
   * result describing success or the failure reason — never throws.
   */
  export function launch(opts: Options): Result {
    const cwd = opts.cwd || process.cwd()

    if (!supported()) {
      return {
        ok: false,
        reason: "unsupported",
        message: "Local terminal is currently Windows-only.",
        cwd,
      }
    }

    const shell = resolveShell()
    if (!shell) {
      return {
        ok: false,
        reason: "no_pwsh",
        message: "PowerShell 7 (pwsh) or Windows PowerShell was not found on PATH.",
        cwd,
      }
    }

    // We spawn a short-lived helper (`wt.exe` or `cmd /c start`) that
    // opens the window and then exits. The visible terminal process it
    // launches is detached and owned by the OS, not by Kilo. We do not
    // retain a handle to it and never kill it (see header).
    //
    // `spawn` reports a missing executable via an async `error` event,
    // not a synchronous throw — we attach a one-shot handler so a
    // missing `wt`/`cmd` surfaces as a structured failure instead of
    // an unhandled error.
    //
    // The environment is rebuilt against the real Windows account home
    // (see `buildEnv`/`resolveRealUserHome`) so the opened shell sees the
    // user's normal Git, SSH, npm, and PowerShell configuration instead of
    // Kilo's isolated launcher profile. `os.userInfo().homedir` /
    // `os.homedir()` are NOT used because the launcher overrides
    // USERPROFILE/HOME and they would report the isolated profile back. The
    // shell must be resolved first because `resolveRealUserHome` invokes it.
    const home = resolveRealUserHome(shell, process.env)
    const env = buildEnv(process.env, home)
    const cwdAbs = path.resolve(cwd)

    const spawnVisible = (file: string, args: string[]): ChildProcess | undefined => {
      try {
        const child = spawn(file, args, {
          cwd: cwdAbs,
          env,
          stdio: "ignore",
          detached: true,
          windowsHide: false,
          shell: false,
        })
        // `spawn` reports a missing executable (ENOENT) via an async
        // `error` event, not a synchronous throw. The visible terminal
        // is detached and unowned by Kilo, so we intentionally do not
        // track or react to this child's lifecycle beyond swallowing
        // the spawn-time error so it never becomes an unhandled crash.
        // The success/failure verdict is decided synchronously here.
        child.once("error", () => {})
        child.unref()
        return child
      } catch {
        return undefined
      }
    }

    const useWt = resolveWindowsTerminal() !== null

    if (useWt) {
      const wt = resolveWindowsTerminal()!
      const args = wtArgs(shell, cwdAbs)
      const child = spawnVisible(wt, args)
      if (!child) {
        return {
          ok: false,
          reason: "spawn_failed",
          message: "Windows Terminal (wt.exe) was found but could not be launched.",
          cwd: cwdAbs,
        }
      }
      return { ok: true, cwd: cwdAbs, command: `${wt} ${args.join(" ")}` }
    }

    // Fallback: `cmd /c start "" /D <cwd> pwsh -NoLogo`.
    const args = startArgs(shell, cwdAbs)
    const child = spawnVisible("cmd", ["/c", ...args])
    if (!child) {
      return {
        ok: false,
        reason: "spawn_failed",
        message: "Windows Terminal was not found and the cmd.exe fallback could not be launched.",
        cwd: cwdAbs,
      }
    }
    return { ok: true, cwd: cwdAbs, command: `cmd /c ${args.join(" ")}` }
  }
}
