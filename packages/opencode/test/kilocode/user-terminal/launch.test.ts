// kilocode_change - new file
import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"

// ---------------------------------------------------------------------------
// Stubs registered at file scope, BEFORE launch.ts is imported.
// `@/util/which`, `node:child_process.spawn`, and `node:os.userInfo` are
// pulled in by launch.ts at module load; registering the mocks at top level
// ensures the stubs are in place before launch.ts evaluates its imports.
// ---------------------------------------------------------------------------

const whichMap = new Map<string, string>()
const spawnCalls: { file: string; args: string[]; opts: Record<string, unknown> | undefined }[] = []
const spawnSyncCalls: { file: string; args: string[]; opts: Record<string, unknown> | undefined }[] = []
let spawnSyncResult: {
  status: number | null
  stdout: string | Buffer
  stderr: string | Buffer
  error?: Error
} = {
  status: 0,
  stdout: "C:\\Users\\kilo-real",
  stderr: "",
}

mock.module("@/util/which", () => ({
  which: (cmd: string) => whichMap.get(cmd) ?? null,
}))

mock.module("node:child_process", () => ({
  spawn: (file: string, args: string[], opts?: Record<string, unknown>) => {
    spawnCalls.push({ file, args, opts })
    return { unref: () => {}, once: () => {} }
  },
  spawnSync: (file: string, args: string[], opts?: Record<string, unknown>) => {
    spawnSyncCalls.push({ file, args, opts })
    if (spawnSyncResult.error) throw spawnSyncResult.error
    return spawnSyncResult
  },
}))

const { UserTerminal, resolveRealUserHome } = await import("../../../src/kilocode/user-terminal/launch")

const setWhich = (entries: Record<string, string>) => {
  whichMap.clear()
  for (const [k, v] of Object.entries(entries)) whichMap.set(k, v)
}

const setPlatform = (value: NodeJS.Platform) => {
  Object.defineProperty(process, "platform", { value, configurable: true })
}

const originalPlatform = process.platform
const originalEnv = { ...process.env }

const setEnv = (entries: NodeJS.ProcessEnv) => {
  for (const k of Object.keys(process.env)) delete process.env[k]
  for (const [k, v] of Object.entries(entries)) if (v !== undefined) process.env[k] = v
}

const mockIsolatedEnv = (real: string) => {
  // The .NET UserProfile lookup returns `real`; the launch path then builds
  // the corrected env from it. We set the isolated USERPROFILE/HOME/etc. in
  // `process.env` to prove they are overwritten by `buildEnv`.
  spawnSyncResult = { status: 0, stdout: real, stderr: "" }
  setEnv({
    USERPROFILE: "S:\\KILO-TERMINAL-A6D1\\profile\\home",
    HOME: "S:\\KILO-TERMINAL-A6D1\\profile\\home",
    APPDATA: "S:\\KILO-TERMINAL-A6D1\\profile\\roaming",
    LOCALAPPDATA: "S:\\KILO-TERMINAL-A6D1\\profile\\local",
    TEMP: "S:\\KILO-TERMINAL-A6D1\\profile\\temp",
    TMP: "S:\\KILO-TERMINAL-A6D1\\profile\\temp",
    XDG_CONFIG_HOME: "S:\\KILO-TERMINAL-A6D1\\profile\\config",
    XDG_DATA_HOME: "S:\\KILO-TERMINAL-A6D1\\profile\\data",
    XDG_STATE_HOME: "S:\\KILO-TERMINAL-A6D1\\profile\\state",
    XDG_CACHE_HOME: "S:\\KILO-TERMINAL-A6D1\\profile\\cache",
    SystemDrive: "C:",
    PATH: "C:\\Windows\\System32;C:\\Windows",
    SystemRoot: "C:\\Windows",
  })
}

describe("UserTerminal", () => {
  afterEach(() => {
    setWhich({})
    spawnCalls.length = 0
    spawnSyncCalls.length = 0
    spawnSyncResult = { status: 0, stdout: "C:\\Users\\kilo-real", stderr: "" }
    setPlatform(originalPlatform)
    setEnv(originalEnv)
  })

  test("supported() is true only on win32", () => {
    setPlatform("win32")
    expect(UserTerminal.supported()).toBe(true)
    setPlatform("darwin")
    expect(UserTerminal.supported()).toBe(false)
    setPlatform("linux")
    expect(UserTerminal.supported()).toBe(false)
  })

  test("wtArgs uses the documented `new-tab` subcommand form with discrete argv elements (no quoting, no interpolation)", () => {
    const shell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
    const cwd = "C:\\Users\\sean has spaces\\kilo workspace"
    const args = UserTerminal.wtArgs(shell, cwd)

    expect(args).toEqual(["new-tab", "-d", cwd, shell, "-NoLogo"])
    // Spaced paths stay as single elements — never re-quoted.
    expect(args.some((a) => a.includes('"'))).toBe(false)
    // `new-tab` subcommand is the first element; no `--` separator.
    expect(args[0]).toBe("new-tab")
    expect(args).not.toContain("--")
  })

  test("startArgs uses an empty window title and /D with the path untouched", () => {
    const shell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
    const cwd = "C:\\my dir\\repo"
    const args = UserTerminal.startArgs(shell, cwd)

    expect(args).toEqual(["start", "", "/D", cwd, shell, "-NoLogo"])
    expect(args[1]).toBe("")
  })

  test("resolveShell prefers pwsh over powershell", () => {
    setWhich({
      pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    })
    expect(UserTerminal.resolveShell()).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
  })

  test("resolveShell falls back to powershell when pwsh is missing", () => {
    setWhich({ powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" })
    expect(UserTerminal.resolveShell()).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  })

  test("resolveShell returns null when neither shell is present", () => {
    setWhich({})
    expect(UserTerminal.resolveShell()).toBeNull()
  })

  test("resolveWindowsTerminal returns the wt path when present, null when absent", () => {
    const wt = "C:\\Program Files\\WindowsTerminal\\wt.exe"
    setWhich({ wt })
    expect(UserTerminal.resolveWindowsTerminal()).toBe(wt)
    setWhich({})
    expect(UserTerminal.resolveWindowsTerminal()).toBeNull()
  })

  test("launch reports unsupported on non-win32 platforms", () => {
    setPlatform("darwin")
    setWhich({})
    const result = UserTerminal.launch({ cwd: "/tmp" })
    if (!result.ok) {
      expect(result.reason).toBe("unsupported")
    } else {
      throw new Error("expected failure")
    }
    expect(spawnCalls).toHaveLength(0)
  })

  test("launch reports no_pwsh on win32 when no shell resolves", () => {
    setPlatform("win32")
    setWhich({})
    const cwd = path.join(process.cwd(), "kilo-test-workspace")
    const result = UserTerminal.launch({ cwd })
    if (!result.ok) {
      expect(result.reason).toBe("no_pwsh")
      expect(result.cwd).toBe(cwd)
    } else {
      throw new Error("expected failure")
    }
    expect(spawnCalls).toHaveLength(0)
  })

  test("launch on win32 with wt present spawns wt.exe with new-tab subcommand and verbatim spaced path", () => {
    setPlatform("win32")
    setWhich({
      pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      wt: "C:\\Program Files\\WindowsTerminal\\wt.exe",
    })
    const cwd = "D:\\repo with spaces"
    const result = UserTerminal.launch({ cwd })

    expect(result.ok).toBe(true)
    expect(spawnCalls).toHaveLength(1)
    const call = spawnCalls[0]
    expect(call.file).toBe("C:\\Program Files\\WindowsTerminal\\wt.exe")
    expect(call.args).toEqual([
      "new-tab",
      "-d",
      "D:\\repo with spaces",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "-NoLogo",
    ])
    // Spawned env carries KILO_TERMINAL=1 and visible (not hidden).
    expect((call.opts?.env as NodeJS.ProcessEnv)?.KILO_TERMINAL).toBe("1")
    expect(call.opts?.windowsHide).toBe(false)
    expect(call.opts?.shell).toBe(false)
    if (result.ok) {
      expect(result.cwd).toBe(cwd)
      expect(result.command).toContain("wt.exe")
      expect(result.command).toContain("new-tab")
      expect(result.command).toContain("-d")
    }
  })

  test("launch on win32 without wt uses the cmd /c start fallback with an empty title", () => {
    setPlatform("win32")
    setWhich({ pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" })
    const cwd = "D:\\repo with spaces"
    const result = UserTerminal.launch({ cwd })

    expect(result.ok).toBe(true)
    expect(spawnCalls).toHaveLength(1)
    const call = spawnCalls[0]
    expect(call.file).toBe("cmd")
    expect(call.args[0]).toBe("/c")
    expect(call.args[1]).toBe("start")
    expect(call.args[2]).toBe("")
    expect(call.args[3]).toBe("/D")
    expect(call.args[4]).toBe("D:\\repo with spaces")
    expect(call.args[5]).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
    expect(call.args[6]).toBe("-NoLogo")
    if (result.ok) {
      expect(result.command).toContain("cmd /c start")
      expect(result.command).toContain("pwsh.exe")
    }
  })

  test("launch never reuses the agent shell and never routes IO to tool permissions", () => {
    // Structural guarantee: the spawn argv is purely the visible
    // terminal helper + the resolved shell with -NoLogo. No stdin/stdout
    // pipes (stdio:"ignore"), no KILO_PROCESS or agent-shell env marks.
    setPlatform("win32")
    setWhich({
      pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      wt: "C:\\Program Files\\WindowsTerminal\\wt.exe",
    })
    UserTerminal.launch({ cwd: "D:\\repo" })

    const call = spawnCalls[0]
    expect(call.opts?.stdio).toBe("ignore")
    expect(call.opts?.detached).toBe(true)
    const env = (call.opts?.env ?? {}) as NodeJS.ProcessEnv
    // No agent-shell coupling markers added by us.
    expect(env.KILO_TERMINAL).toBe("1")
    expect("KILO_AGENT_SHELL" in env).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Environment isolation correction. The Kilo launcher overrides the agent
  // shell's profile home (USERPROFILE/HOME/APPDATA/LOCALAPPDATA/TEMP/TMP plus
  // the XDG_* vars) to an isolated profile directory. The Local Developer
  // Terminal must surface the *real* Windows account profile so Git, SSH, npm,
  // and PowerShell config behave normally. `resolveRealUserHome` asks the .NET
  // runtime (via the resolved PowerShell executable) for the `UserProfile`
  // special folder, which reads the real account home from the Known Folder /
  // shell folder registry — unaffected by the launcher's env overrides. The
  // `SystemDrive + os.userInfo().username` construction is a documented
  // fallback when the .NET lookup fails.
  // ---------------------------------------------------------------------------
  const REAL_HOME = "C:\\Users\\kilo-real"
  const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
  const isolatedEnv: NodeJS.ProcessEnv = {
    USERPROFILE: "S:\\KILO-TERMINAL-A6D1\\profile\\home",
    HOME: "S:\\KILO-TERMINAL-A6D1\\profile\\home",
    APPDATA: "S:\\KILO-TERMINAL-A6D1\\profile\\roaming",
    LOCALAPPDATA: "S:\\KILO-TERMINAL-A6D1\\profile\\local",
    TEMP: "S:\\KILO-TERMINAL-A6D1\\profile\\temp",
    TMP: "S:\\KILO-TERMINAL-A6D1\\profile\\temp",
    XDG_CONFIG_HOME: "S:\\KILO-TERMINAL-A6D1\\profile\\config",
    XDG_DATA_HOME: "S:\\KILO-TERMINAL-A6D1\\profile\\data",
    XDG_STATE_HOME: "S:\\KILO-TERMINAL-A6D1\\profile\\state",
    XDG_CACHE_HOME: "S:\\KILO-TERMINAL-A6D1\\profile\\cache",
    SystemDrive: "C:",
    PATH: "C:\\Windows\\System32;C:\\Windows",
    SystemRoot: "C:\\Windows",
  }

  test("resolveRealUserHome prefers the .NET UserProfile result over the constructed fallback", () => {
    spawnSyncResult = { status: 0, stdout: REAL_HOME, stderr: "" }
    const home = resolveRealUserHome(PWSH, isolatedEnv)
    expect(home).toBe(REAL_HOME)
    expect(spawnSyncCalls).toHaveLength(1)
    expect(spawnSyncCalls[0].file).toBe(PWSH)
  })

  test("resolveRealUserHome trims whitespace and newlines from the .NET output", () => {
    spawnSyncResult = { status: 0, stdout: `\r\n  ${REAL_HOME}  \r\n`, stderr: "" }
    const home = resolveRealUserHome(PWSH, isolatedEnv)
    expect(home).toBe(REAL_HOME)
  })

  test("resolveRealUserHome passes discrete PowerShell argv with no string interpolation", () => {
    spawnSyncResult = { status: 0, stdout: REAL_HOME, stderr: "" }
    resolveRealUserHome(PWSH, isolatedEnv)
    expect(spawnSyncCalls[0].args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)",
    ])
    // No shell-string interpolation: the long expression is one argv element.
    expect(spawnSyncCalls[0].args.filter((a) => a.includes("GetFolderPath"))).toHaveLength(1)
  })

  test("resolveRealUserHome spawns with shell:false and windowsHide:true", () => {
    spawnSyncResult = { status: 0, stdout: REAL_HOME, stderr: "" }
    resolveRealUserHome(PWSH, isolatedEnv)
    expect(spawnSyncCalls[0].opts?.shell).toBe(false)
    expect(spawnSyncCalls[0].opts?.windowsHide).toBe(true)
    expect(spawnSyncCalls[0].opts?.stdio).toEqual(["ignore", "pipe", "ignore"])
  })

  test("resolveRealUserHome falls back to SystemDrive+username when the .NET exit is nonzero", () => {
    spawnSyncResult = { status: 1, stdout: "", stderr: "boom" }
    const home = resolveRealUserHome(PWSH, isolatedEnv)
    // The fallback reads `os.userInfo().username` (not the isolated profile)
    // and `SystemDrive`. We only pin the drive/Users segment for portability.
    expect(home.startsWith("C:\\Users\\")).toBe(true)
    expect(home).not.toContain("S:\\KILO-TERMINAL")
  })

  test("resolveRealUserHome falls back when the .NET output is empty", () => {
    spawnSyncResult = { status: 0, stdout: "   \r\n  ", stderr: "" }
    const home = resolveRealUserHome(PWSH, isolatedEnv)
    expect(home.startsWith("C:\\Users\\")).toBe(true)
    expect(home).not.toContain("S:\\KILO-TERMINAL")
  })

  test("resolveRealUserHome falls back when the .NET output is not an absolute Windows path", () => {
    spawnSyncResult = { status: 0, stdout: "relative\\path", stderr: "" }
    const home = resolveRealUserHome(PWSH, isolatedEnv)
    expect(home.startsWith("C:\\Users\\")).toBe(true)
    expect(home).not.toContain("S:\\KILO-TERMINAL")
  })

  test("resolveRealUserHome falls back when spawnSync throws", () => {
    spawnSyncResult = { status: 0, stdout: "", stderr: "", error: new Error("ENOENT") }
    const home = resolveRealUserHome(PWSH, isolatedEnv)
    expect(home.startsWith("C:\\Users\\")).toBe(true)
    expect(home).not.toContain("S:\\KILO-TERMINAL")
  })

  test("resolveRealUserHome never echoes the launcher-overridden HOME or USERPROFILE", () => {
    spawnSyncResult = { status: 1, stdout: "", stderr: "" }
    const home = resolveRealUserHome(PWSH, isolatedEnv)
    expect(home).not.toBe(isolatedEnv.HOME)
    expect(home).not.toBe(isolatedEnv.USERPROFILE)
  })

  test("buildEnv corrects an isolated input environment to the real Windows user home", () => {
    const env = UserTerminal.buildEnv(isolatedEnv, REAL_HOME)
    expect(env.USERPROFILE).toBe(REAL_HOME)
    expect(env.HOME).toBe(REAL_HOME)
    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Windows")
    expect(env.SystemRoot).toBe("C:\\Windows")
  })

  test("buildEnv sets APPDATA, LOCALAPPDATA, TEMP, and TMP to the normal Windows paths", () => {
    const env = UserTerminal.buildEnv(isolatedEnv, REAL_HOME)
    expect(env.APPDATA).toBe(`${REAL_HOME}\\AppData\\Roaming`)
    expect(env.LOCALAPPDATA).toBe(`${REAL_HOME}\\AppData\\Local`)
    expect(env.TEMP).toBe(`${REAL_HOME}\\AppData\\Local\\Temp`)
    expect(env.TMP).toBe(`${REAL_HOME}\\AppData\\Local\\Temp`)
  })

  test("buildEnv strips all four XDG isolation variables", () => {
    const env = UserTerminal.buildEnv(isolatedEnv, REAL_HOME)
    expect("XDG_CONFIG_HOME" in env).toBe(false)
    expect("XDG_DATA_HOME" in env).toBe(false)
    expect("XDG_STATE_HOME" in env).toBe(false)
    expect("XDG_CACHE_HOME" in env).toBe(false)
  })

  test("buildEnv preserves PATH and keeps KILO_TERMINAL=1", () => {
    const env = UserTerminal.buildEnv({ ...isolatedEnv, KILO_TERMINAL: "1" }, REAL_HOME)
    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Windows")
    expect(env.KILO_TERMINAL).toBe("1")
  })

  // Captures the shared assertions for the env forwarded to the visible
  // terminal across both launch branches.
  const expectCorrectedEnv = (env: NodeJS.ProcessEnv) => {
    expect(env.USERPROFILE).toBe(REAL_HOME)
    expect(env.HOME).toBe(REAL_HOME)
    expect(env.APPDATA).toBe(`${REAL_HOME}\\AppData\\Roaming`)
    expect(env.LOCALAPPDATA).toBe(`${REAL_HOME}\\AppData\\Local`)
    expect(env.TEMP).toBe(`${REAL_HOME}\\AppData\\Local\\Temp`)
    expect(env.TMP).toBe(`${REAL_HOME}\\AppData\\Local\\Temp`)
    expect("XDG_CONFIG_HOME" in env).toBe(false)
    expect("XDG_DATA_HOME" in env).toBe(false)
    expect("XDG_STATE_HOME" in env).toBe(false)
    expect("XDG_CACHE_HOME" in env).toBe(false)
    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Windows")
    expect(env.KILO_TERMINAL).toBe("1")
  }

  test("launch forwards the corrected environment to the wt.exe spawn", () => {
    setPlatform("win32")
    setWhich({
      pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      wt: "C:\\Program Files\\WindowsTerminal\\wt.exe",
    })
    mockIsolatedEnv(REAL_HOME)
    UserTerminal.launch({ cwd: "D:\\repo" })

    const call = spawnCalls[0]
    expectCorrectedEnv((call.opts?.env ?? {}) as NodeJS.ProcessEnv)
  })

  test("launch forwards the corrected environment to the cmd /c start fallback", () => {
    setPlatform("win32")
    setWhich({ pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" })
    mockIsolatedEnv(REAL_HOME)
    UserTerminal.launch({ cwd: "D:\\repo" })

    const call = spawnCalls[0]
    expectCorrectedEnv((call.opts?.env ?? {}) as NodeJS.ProcessEnv)
  })
})
