import { test, expect, describe } from "bun:test"
import { SharedTerminalEnv } from "../../src/kilocode/shared-terminal/env"

// Pure environment builder tests. The builder must never read process.env,
// never call the shell.env plugin hook, never restore the real developer
// environment, and never log environment values. All inputs are injected.
//
// Secret values are never asserted on by content and never printed. We only
// assert that secret NAMES are absent from the result.

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

// Representative secrets that must NEVER survive into a shared terminal env,
// regardless of platform or case. Values are opaque placeholders; we never
// print or assert on the values, only on name absence.
const SECRET_NAMES = [
  "OPENAI_API_KEY",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "KILO_OPENROUTER_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "SSH_AUTH_SOCK",
  "GIT_ASKPASS",
  "CUSTOM_SECRET",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
] as const

function sourceWithSecrets(): Record<string, string> {
  const src: Record<string, string> = {}
  for (const name of SECRET_NAMES) src[name] = "REDACTED"
  // arbitrary custom variables
  src["ARBITRARY_CUSTOM_VAR"] = "REDACTED"
  src["ANOTHER_RANDOM_THING"] = "REDACTED"
  return src
}

function windowsSource(): Record<string, string> {
  return {
    ...sourceWithSecrets(),
    PATH: "C:\\Windows\\System32;C:\\Windows",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    WINDIR: "C:\\Windows",
    USERPROFILE: "C:\\Users\\realdev",
    HOME: "C:\\Users\\realdev",
    APPDATA: "C:\\Users\\realdev\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\realdev\\AppData\\Local",
    TEMP: "C:\\Users\\realdev\\AppData\\Local\\Temp",
    TMP: "C:\\Users\\realdev\\AppData\\Local\\Temp",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\realdev",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LC_CTYPE: "en_US.UTF-8",
  }
}

function posixSource(): Record<string, string> {
  return {
    ...sourceWithSecrets(),
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/realdev",
    SHELL: "/bin/bash",
    USER: "realdev",
    LOGNAME: "realdev",
    TMPDIR: "/tmp",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LC_CTYPE: "en_US.UTF-8",
  }
}

const winIso = {
  userprofile: "<WIN_USERPROFILE>",
  home: "<WIN_HOME>",
  appdata: "<WIN_APPDATA>",
  localappdata: "<WIN_LOCALAPPDATA>",
  temp: "<WIN_TEMP>",
  tmp: "<WIN_TMP>",
  homedrive: "<WIN_HOMEDRIVE>",
  homepath: "<WIN_HOMEPATH>",
}

const posixIso = {
  home: "<POSIX_HOME>",
  tmpdir: "<POSIX_TMPDIR>",
}

describe("SharedTerminalEnv: Windows allowlist", () => {
  test("exact Windows retained-name set", () => {
    const env = SharedTerminalEnv.build({
      platform: "win32",
      source: windowsSource(),
      isolated: winIso,
    })
    const names = Object.keys(env)
    for (const name of WINDOWS_ALLOWLIST) expect(names).toContain(name)
    // No name outside the allowlist + forced markers may appear.
    const forced = new Set(["TERM", "KILO_TERMINAL", "KILO_SHARED_TERMINAL"])
    for (const name of names) {
      expect(WINDOWS_ALLOWLIST.includes(name as (typeof WINDOWS_ALLOWLIST)[number]) || forced.has(name)).toBe(true)
    }
  })

  test("Windows case-insensitive lookup", () => {
    const src = windowsSource()
    // Provide the same variable under different case; canonical form must win once.
    src["path"] = "C:\\lower\\path"
    src["Path"] = "C:\\mixed\\path"
    const env = SharedTerminalEnv.build({ platform: "win32", source: src, isolated: winIso })
    expect(env["PATH"]).toBeDefined()
    // Exactly one canonical PATH entry.
    const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === "path")
    expect(pathKeys.length).toBe(1)
    expect(pathKeys[0]).toBe("PATH")
  })

  test("duplicate-case source names produce one canonical output", () => {
    const src = windowsSource()
    src["Home"] = "C:\\dup\\home"
    src["HOME"] = "C:\\canonical\\home"
    const env = SharedTerminalEnv.build({ platform: "win32", source: src, isolated: winIso })
    const homeKeys = Object.keys(env).filter((k) => k.toLowerCase() === "home")
    expect(homeKeys.length).toBe(1)
    expect(homeKeys[0]).toBe("HOME")
  })
})

describe("SharedTerminalEnv: POSIX allowlist", () => {
  test("exact POSIX retained-name set", () => {
    const env = SharedTerminalEnv.build({
      platform: "linux",
      source: posixSource(),
      isolated: posixIso,
    })
    const names = Object.keys(env)
    for (const name of POSIX_ALLOWLIST) expect(names).toContain(name)
    const forced = new Set(["TERM", "KILO_TERMINAL", "KILO_SHARED_TERMINAL"])
    for (const name of names) {
      expect(POSIX_ALLOWLIST.includes(name as (typeof POSIX_ALLOWLIST)[number]) || forced.has(name)).toBe(true)
    }
  })
})

describe("SharedTerminalEnv: isolation", () => {
  test("Windows isolated path rewriting", () => {
    const env = SharedTerminalEnv.build({
      platform: "win32",
      source: windowsSource(),
      isolated: winIso,
    })
    expect(env["USERPROFILE"]).toBe(winIso.userprofile)
    expect(env["HOME"]).toBe(winIso.home)
    expect(env["APPDATA"]).toBe(winIso.appdata)
    expect(env["LOCALAPPDATA"]).toBe(winIso.localappdata)
    expect(env["TEMP"]).toBe(winIso.temp)
    expect(env["TMP"]).toBe(winIso.tmp)
    expect(env["HOMEDRIVE"]).toBe(winIso.homedrive)
    expect(env["HOMEPATH"]).toBe(winIso.homepath)
  })

  test("POSIX isolated path rewriting", () => {
    const env = SharedTerminalEnv.build({
      platform: "linux",
      source: posixSource(),
      isolated: posixIso,
    })
    expect(env["HOME"]).toBe(posixIso.home)
    expect(env["TMPDIR"]).toBe(posixIso.tmpdir)
  })

  test("no inherited real profile/temp path survives on Windows", () => {
    const env = SharedTerminalEnv.build({
      platform: "win32",
      source: windowsSource(),
      isolated: winIso,
    })
    expect(env["USERPROFILE"]).not.toContain("realdev")
    expect(env["HOME"]).not.toContain("realdev")
    expect(env["APPDATA"]).not.toContain("realdev")
    expect(env["LOCALAPPDATA"]).not.toContain("realdev")
    expect(env["TEMP"]).not.toContain("realdev")
    expect(env["TMP"]).not.toContain("realdev")
    expect(env["HOMEDRIVE"]).not.toContain("realdev")
    expect(env["HOMEPATH"]).not.toContain("realdev")
  })

  test("no inherited real profile/temp path survives on POSIX", () => {
    const env = SharedTerminalEnv.build({
      platform: "darwin",
      source: posixSource(),
      isolated: posixIso,
    })
    expect(env["HOME"]).not.toContain("realdev")
    expect(env["TMPDIR"]).not.toContain("/tmp")
  })
})

describe("SharedTerminalEnv: secret exclusion", () => {
  test("all representative secrets excluded on Windows", () => {
    const env = SharedTerminalEnv.build({
      platform: "win32",
      source: windowsSource(),
      isolated: winIso,
    })
    const names = new Set(Object.keys(env).map((k) => k.toLowerCase()))
    for (const secret of SECRET_NAMES) expect(names.has(secret.toLowerCase())).toBe(false)
  })

  test("all representative secrets excluded on POSIX", () => {
    const env = SharedTerminalEnv.build({
      platform: "linux",
      source: posixSource(),
      isolated: posixIso,
    })
    const names = new Set(Object.keys(env))
    for (const secret of SECRET_NAMES) expect(names.has(secret)).toBe(false)
  })

  test("arbitrary source variables excluded on Windows", () => {
    const env = SharedTerminalEnv.build({
      platform: "win32",
      source: windowsSource(),
      isolated: winIso,
    })
    const names = new Set(Object.keys(env).map((k) => k.toLowerCase()))
    expect(names.has("arbitrary_custom_var")).toBe(false)
    expect(names.has("another_random_thing")).toBe(false)
  })

  test("arbitrary source variables excluded on POSIX", () => {
    const env = SharedTerminalEnv.build({
      platform: "linux",
      source: posixSource(),
      isolated: posixIso,
    })
    const names = new Set(Object.keys(env))
    expect(names.has("ARBITRARY_CUSTOM_VAR")).toBe(false)
    expect(names.has("ANOTHER_RANDOM_THING")).toBe(false)
  })
})

describe("SharedTerminalEnv: markers and TERM", () => {
  test("markers forced to 1 on Windows", () => {
    const env = SharedTerminalEnv.build({
      platform: "win32",
      source: windowsSource(),
      isolated: winIso,
    })
    expect(env["KILO_TERMINAL"]).toBe("1")
    expect(env["KILO_SHARED_TERMINAL"]).toBe("1")
  })

  test("markers forced to 1 on POSIX", () => {
    const env = SharedTerminalEnv.build({
      platform: "linux",
      source: posixSource(),
      isolated: posixIso,
    })
    expect(env["KILO_TERMINAL"]).toBe("1")
    expect(env["KILO_SHARED_TERMINAL"]).toBe("1")
  })

  test("deterministic TERM default on Windows", () => {
    const env = SharedTerminalEnv.build({
      platform: "win32",
      source: windowsSource(),
      isolated: winIso,
    })
    expect(env["TERM"]).toBe(SharedTerminalEnv.DEFAULT_TERM)
  })

  test("deterministic TERM default on POSIX when source lacks TERM", () => {
    const src = posixSource()
    delete src["TERM"]
    const env = SharedTerminalEnv.build({ platform: "linux", source: src, isolated: posixIso })
    expect(env["TERM"]).toBe(SharedTerminalEnv.DEFAULT_TERM)
  })

  test("injected TERM value honored on POSIX", () => {
    const env = SharedTerminalEnv.build({
      platform: "linux",
      source: posixSource(),
      isolated: posixIso,
      term: "screen-256color",
    })
    expect(env["TERM"]).toBe("screen-256color")
  })

  test("injected TERM value honored on Windows", () => {
    const env = SharedTerminalEnv.build({
      platform: "win32",
      source: windowsSource(),
      isolated: winIso,
      term: "xterm-direct",
    })
    expect(env["TERM"]).toBe("xterm-direct")
  })
})

describe("SharedTerminalEnv: purity and shape", () => {
  test("source object unchanged", () => {
    const src = windowsSource()
    const snapshot = { ...src }
    SharedTerminalEnv.build({ platform: "win32", source: src, isolated: winIso })
    expect(src).toEqual(snapshot)
  })

  test("isolated-path input unchanged", () => {
    const iso = { ...winIso }
    SharedTerminalEnv.build({ platform: "win32", source: windowsSource(), isolated: winIso })
    expect(winIso).toEqual(iso)
  })

  test("result contains string values only", () => {
    const env = SharedTerminalEnv.build({
      platform: "win32",
      source: windowsSource(),
      isolated: winIso,
    })
    for (const v of Object.values(env)) expect(typeof v).toBe("string")
  })

  test("missing optional allowed values are simply absent on Windows", () => {
    const src: Record<string, string> = {
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    }
    const env = SharedTerminalEnv.build({ platform: "win32", source: src, isolated: winIso })
    expect(env["PATHEXT"]).toBeUndefined()
    expect(env["WINDIR"]).toBeUndefined()
    expect(env["LANG"]).toBeUndefined()
  })

  test("missing optional allowed values are simply absent on POSIX", () => {
    const src: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/dev",
    }
    const env = SharedTerminalEnv.build({ platform: "linux", source: src, isolated: posixIso })
    expect(env["SHELL"]).toBeUndefined()
    expect(env["USER"]).toBeUndefined()
    expect(env["LOGNAME"]).toBeUndefined()
    expect(env["COLORTERM"]).toBeUndefined()
  })
})
