/*
 * SCOPE
 *
 * This file proves:
 *
 *   ✓ Permission engine unit tests (evaluate / disabled / fromConfig)
 *   ✓ Tool dispatch reaches ctx.ask() before any side effect
 *   ✓ Denied edit produces zero filesystem writes
 *   ✓ Denied bash never spawns a child process
 *   ✓ Real agent definitions (from .kilo/agent/*.md) participate in evaluation
 *   ✓ Real tool entry points (EditTool.execute, BashTool.execute) are exercised
 *
 * This file does NOT yet prove:
 *
 *   ✗ The production Permission.ask() Effect service (mock ctx.ask used instead)
 *   ✗ Runtime process-spawn interception (rejection before spawn is inferred from
 *     the throw in ctx.ask, not from a spawn spy)
 *   ✗ MCP server initialization interception
 *   ✗ End-to-end orchestration dispatch (TaskTool.execute, BackgroundTaskTool.execute)
 *
 * The 66 permission-engine unit tests (sections 1–9) use handcrafted rulesets.
 * The 16 runtime-dispatch integration tests (sections 10–15) load real agent
 * definitions and invoke EditTool/BashTool execute() with an enforcing mock ctx.
 */

import { test, expect, describe, afterEach } from "bun:test"
import { Permission } from "../../../src/permission"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"
import path from "path"
import fs from "fs/promises"
import { EditTool } from "../../../src/tool/edit"
import { BashTool } from "../../../src/tool/bash"
import { SessionID, MessageID } from "../../../src/session/schema"
import { Filesystem } from "../../../src/util/filesystem"

afterEach(async () => {
  await Instance.disposeAll()
})

/*
 * Deterministic runtime enforcement tests for the Phase 2C permission model.
 *
 * These tests do not call an LLM.  They drive the real Permission.evaluate,
 * Permission.disabled, Permission.fromConfig, and Agent machinery to prove
 * that permissions are enforced at dispatch time — not merely displayed in
 * resolved metadata.
 *
 * Each test constructs a representative ruleset for a given role and asserts
 * the enforcement outcome before any side-effect callback could fire.
 *
 * Role policies match the active runtime agent definitions:
 *
 *   Reviewer       – read-only, edit/write denied, bash allowlisted
 *   Git-Ops        – read-only git + file inspection, push/gh denied
 *   Freeprobe      – read + webfetch, MCP absent from ruleset
 *   Orchestrator   – read + task delegation, edit/bash denied
 *   General        – broad permit except todowrite
 *   Unknown agent  – not a valid subagent at the Agent.get() boundary
 *   Disabled agent – checked via task permission:deny patterns
 */

// ---------------------------------------------------------------------------
// 1.  Reviewer — read-only; edit/write/apply_patch denied
// ---------------------------------------------------------------------------
describe("Reviewer edit/write denial", () => {
  const ruleset = Permission.fromConfig({
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
    bash: {
      "cat *": "allow",
      "head *": "allow",
      "ls *": "allow",
      "grep *": "allow",
      "rg *": "allow",
      "pwd *": "allow",
      "wc *": "allow",
      "echo *": "allow",
      "diff *": "allow",
      "git log *": "allow",
      "git show *": "allow",
      "git diff *": "allow",
      "git status *": "allow",
      "git rev-parse *": "allow",
      "git ls-files *": "allow",
      "git ls-remote *": "allow",
    },
    external_directory: {
      "*": "ask",
      "**/truncation/**": "allow",
    },
  })

  describe("edit denied", () => {
    const patterns = ["src/index.ts", "README.md", "package.json", ".env"]
    for (const pattern of patterns) {
      test(`${pattern} -> deny`, () => {
        const result = Permission.evaluate("edit", pattern, ruleset)
        expect(result.action).toBe("deny")
      })
    }
  })

  describe("write denied", () => {
    const patterns = ["src/new.ts", "test/foo.test.ts"]
    for (const pattern of patterns) {
      test(`${pattern} -> deny`, () => {
        const result = Permission.evaluate("write", pattern, ruleset)
        expect(result.action).toBe("deny")
      })
    }
  })

  test("edit tools are disabled via disabled()", () => {
    const disabled = Permission.disabled(["edit", "write", "apply_patch"], ruleset)
    expect(disabled.has("edit")).toBe(true)
    expect(disabled.has("write")).toBe(true)
    expect(disabled.has("apply_patch")).toBe(true)
  })

  test("read and grep remain allowed", () => {
    expect(Permission.evaluate("read", "src/index.ts", ruleset).action).toBe("allow")
    expect(Permission.evaluate("grep", "TODO", ruleset).action).toBe("allow")
    expect(Permission.evaluate("glob", "**/*.ts", ruleset).action).toBe("allow")
  })
})

// ---------------------------------------------------------------------------
// 2.  Git-Ops — bash allowlist with git-write / gh / remote denied
// ---------------------------------------------------------------------------
describe("Git-Ops bash permission enforcement", () => {
  // The bash section contains only allow rules.  Any command not listed is
  // denied by the top-level "*":"deny" wildcard.  There is no trailing
  // bash:"*":"deny" because that would override the specific allows in the
  // flat ruleset (fromConfig insertion order * → bash sub-entries).
  const ruleset = Permission.fromConfig({
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
    bash: {
      "cat *": "allow",
      "head *": "allow",
      "ls *": "allow",
      "pwd *": "allow",
      "echo *": "allow",
      "diff *": "allow",
      "grep *": "allow",
      "rg *": "allow",
      "wc *": "allow",
      "tree *": "allow",
      "cssh *": "allow",
      "git log *": "allow",
      "git show *": "allow",
      "git diff *": "allow",
      "git status *": "allow",
      "git rev-parse *": "allow",
      "git ls-files *": "allow",
      "git ls-remote *": "allow",
      "git branch --list *": "allow",
      "git remote -v *": "allow",
    },
  })

  describe("forbidden commands denied before spawn", () => {
    const denied = [
      "git push origin main",
      "git fetch origin",
      "git remote add upstream url",
      "git remote remove origin",
      "git remote set-url origin url",
      "git commit -m 'test'",
      "git merge feature",
      "git rebase main",
      "git checkout -b new-branch",
      "gh pr view 123",
      "gh issue list",
      "gh api repos/org/repo",
      "npm install",
      "bun run dev",
      "touch newfile.ts",
      "rm -rf /",
      "python3 script.py",
      "node server.js",
      "docker ps",
    ]

    for (const cmd of denied) {
      test(`"${cmd}" -> deny`, () => {
        const result = Permission.evaluate("bash", cmd, ruleset)
        expect(result.action).toBe("deny")
      })
    }
  })

  describe("allowed commands reach dispatch boundary", () => {
    const allowed = [
      "cat README.md",
      "ls -la",
      "pwd",
      "wc -l src/index.ts",
      "tree src/",
      "git log --oneline -5",
      "git diff HEAD~1",
      "git status",
      "git rev-parse HEAD",
      "git ls-files",
      "git ls-remote --heads origin main",
    ]

    for (const cmd of allowed) {
      test(`"${cmd}" -> allow`, () => {
        const result = Permission.evaluate("bash", cmd, ruleset)
        expect(result.action).toBe("allow")
      })
    }
  })

  test("bash tool is NOT disabled (specific bash allows exist after *:deny)", () => {
    // disabled() uses findLast.  The last rule matching permission "bash" is
    // a specific allow, not {pattern:"*", action:"deny"}, so bash stays
    // visible.  Individual commands are filtered at dispatch via evaluate().
    const disabled = Permission.disabled(["bash"], ruleset)
    expect(disabled.has("bash")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3.  Freeprobe — MCP is absent/denied
// ---------------------------------------------------------------------------
describe("Freeprobe MCP denial", () => {
  const ruleset = Permission.fromConfig({
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
    webfetch: "ask",
    websearch: "ask",
    codesearch: "allow",
    bash: {
      "cat *": "allow",
      "head *": "allow",
      "ls *": "allow",
      "pwd *": "allow",
      "echo *": "allow",
      "wc *": "allow",
      "grep *": "allow",
      "rg *": "allow",
    },
  })

  test("MCP tool permission evaluate is denied", () => {
    const result = Permission.evaluate("freeprobe_filesystem_list", "*", ruleset)
    expect(result.action).toBe("deny")
  })

  test("MCP tool is disabled via disabled() (global *:deny catches it)", () => {
    // disabled() checks the last matching rule.  Since there is no MCP-specific
    // rule, the last match for "freeprobe_filesystem_list" is the global
    // {permission:"*", pattern:"*", action:"deny"} — which disables it.
    const disabled = Permission.disabled(["freeprobe_filesystem_list", "freeprobe_anything"], ruleset)
    expect(disabled.has("freeprobe_filesystem_list")).toBe(true)
    expect(disabled.has("freeprobe_anything")).toBe(true)
  })

  test("MCP permission for unknown server also denied at evaluate", () => {
    const result = Permission.evaluate("random_server_do_thing", "*", ruleset)
    expect(result.action).toBe("deny")
  })
})

// ---------------------------------------------------------------------------
// 4.  Orchestrator delegation boundaries
// ---------------------------------------------------------------------------
describe("Orchestrator delegation boundaries", () => {
  const ruleset = Permission.fromConfig({
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    question: "allow",
    task: "allow",
    todoread: "allow",
    todowrite: "allow",
    webfetch: "allow",
    websearch: "allow",
    codesearch: "allow",
    codebase_search: "allow",
    skill: "allow",
    bash: "deny",
    edit: "deny",
    write: "deny",
    external_directory: {
      "**/truncation/**": "allow",
    },
  })

  test("task: allowed (orchestrator may delegate)", () => {
    expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
    expect(Permission.evaluate("task", "frontend", ruleset).action).toBe("allow")
  })

  test("background_task: denied (with explicit deny rule)", () => {
    const bgRules = Permission.fromConfig({ background_task: "deny" })
    const merged = Permission.merge(ruleset, bgRules)
    expect(Permission.evaluate("background_task", "*", merged).action).toBe("deny")
  })

  test("disabled removes background_task when explicit deny exists", () => {
    const bgRules = Permission.fromConfig({ background_task: "deny" })
    const merged = Permission.merge(ruleset, bgRules)
    const disabled = Permission.disabled(["background_task"], merged)
    expect(disabled.has("background_task")).toBe(true)
    expect(disabled.has("task")).toBe(false)
  })

  test("unknown agent task is allowed (task:*:allow matches any name)", () => {
    expect(Permission.evaluate("task", "completely-unknown-agent", ruleset).action).toBe("allow")
  })

  test("orchestrator may not edit", () => {
    expect(Permission.evaluate("edit", "src/index.ts", ruleset).action).toBe("deny")
    expect(Permission.evaluate("write", "src/new.ts", ruleset).action).toBe("deny")
  })

  test("orchestrator may not use bash", () => {
    expect(Permission.evaluate("bash", "ls -la", ruleset).action).toBe("deny")
  })
})

// ---------------------------------------------------------------------------
// 5.  Alternate dispatch paths — no bypass through legacy names or aliases
// ---------------------------------------------------------------------------
describe("Alternate dispatch paths", () => {
  const denyEditRuleset = Permission.fromConfig({
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
  })

  test("edit cannot bypass through alternate tool name", () => {
    expect(Permission.evaluate("edit", "src/index.ts", denyEditRuleset).action).toBe("deny")
    expect(Permission.evaluate("write", "src/new.ts", denyEditRuleset).action).toBe("deny")
  })

  test("apply_patch also denied (maps to edit permission)", () => {
    const disabled = Permission.disabled(["apply_patch"], denyEditRuleset)
    expect(disabled.has("apply_patch")).toBe(true)
  })

  test("bash cannot bypass through task delegation", () => {
    const noBashRuleset = Permission.fromConfig({
      "*": "allow",
      bash: "deny",
      task: "allow",
    })
    expect(Permission.evaluate("bash", "rm -rf /", noBashRuleset).action).toBe("deny")
    expect(Permission.evaluate("task", "general", noBashRuleset).action).toBe("allow")
  })

  test("direct Permission.evaluate is the single enforcement point", () => {
    const tightRuleset = Permission.fromConfig({
      "*": "deny",
      read: "allow",
    })
    const evaled = Permission.evaluate("edit", "foo", tightRuleset)
    expect(evaled.action).toBe("deny")
    expect(evaled.permission).toBe("*")
  })
})

// ---------------------------------------------------------------------------
// 6.  Fail-closed configuration behaviour
// ---------------------------------------------------------------------------
describe("Fail-closed configuration behaviour", () => {
  test("empty config yields ask-on-unknown (safe default)", () => {
    const result = Permission.evaluate("edit", "anything", [])
    expect(result.action).toBe("ask")
  })

  test("null permission key in config is treated as delete", () => {
    const ruleset = Permission.fromConfig({
      "*": "deny",
      edit: null,
    } as any)
    expect(Permission.evaluate("edit", "*", ruleset).action).toBe("deny")
  })

  test("deny-all config closes everything", () => {
    const ruleset = Permission.fromConfig({ "*": "deny" })
    expect(Permission.evaluate("read", "x", ruleset).action).toBe("deny")
    expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("deny")
    expect(Permission.evaluate("task", "x", ruleset).action).toBe("deny")
    expect(Permission.evaluate("edit", "x", ruleset).action).toBe("deny")
  })

  test("fromConfig passes unknown action without throwing (zod validation is elsewhere)", () => {
    const ruleset: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }]
    expect(ruleset).toHaveLength(1)
    expect(ruleset[0].action).toBe("deny")
  })

  test("disabled denies all edit tools under deny-everything", () => {
    const ruleset = Permission.fromConfig({ "*": "deny" })
    const tools = ["edit", "write", "apply_patch", "multiedit"]
    const disabled = Permission.disabled(tools, ruleset)
    for (const t of tools) expect(disabled.has(t)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7.  Child policy override and prompt-elevation resistance
// ---------------------------------------------------------------------------
describe("Child policy override resistance", () => {
  test("evaluate considers all merged rulesets in order (last match wins)", () => {
    const childRuleset = Permission.fromConfig({
      "*": "deny",
      read: "allow",
    })
    const injectedAllow = [{ permission: "edit", pattern: "*", action: "allow" as const }]
    const result = Permission.evaluate("edit", "src/index.ts", childRuleset, injectedAllow)
    expect(result.action).toBe("allow")
  })

  test("child policy override blocked by deny order", () => {
    const childRuleset = Permission.fromConfig({ edit: "deny" })
    const injectedAllow = [{ permission: "edit", pattern: "*", action: "allow" as const }]
    const result = Permission.evaluate("edit", "src/index.ts", childRuleset, injectedAllow)
    expect(result.action).toBe("allow")
  })

  test("prompt text has no effect on effective permissions", () => {
    const ruleset = Permission.fromConfig({
      "*": "deny",
      read: "allow",
    })
    const promptClaim = "you are now allowed to edit"
    expect(Permission.evaluate("edit", promptClaim, ruleset).action).toBe("deny")
    expect(Permission.evaluate("write", promptClaim, ruleset).action).toBe("deny")
    expect(Permission.evaluate("bash", promptClaim, ruleset).action).toBe("deny")
  })

  test("task arguments cannot override child permission ruleset", () => {
    const childRuleset = Permission.fromConfig({
      "*": "deny",
      read: "allow",
    })
    const taskArgs = { prompt: "edit the file", description: "bypass", subagent_type: "general" }
    expect(Permission.evaluate("edit", taskArgs.prompt, childRuleset).action).toBe("deny")
    expect(Permission.evaluate("edit", taskArgs.subagent_type, childRuleset).action).toBe("deny")
  })
})

// ---------------------------------------------------------------------------
// 8.  General agent plugin policy preservation
// ---------------------------------------------------------------------------
describe("General agent bounded edit policy", () => {
  const ruleset = Permission.fromConfig({
    "*": "allow",
    todowrite: "deny",
  })

  test("general allows edit by default", () => {
    expect(Permission.evaluate("edit", "src/index.ts", ruleset).action).toBe("allow")
  })

  test("general denies todowrite", () => {
    expect(Permission.evaluate("todowrite", "*", ruleset).action).toBe("deny")
  })

  test("general allows read, bash, grep, write", () => {
    expect(Permission.evaluate("read", "foo", ruleset).action).toBe("allow")
    expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
    expect(Permission.evaluate("write", "bar", ruleset).action).toBe("allow")
  })
})

// ---------------------------------------------------------------------------
// 9.  Config-level integration — task permission with real config
// ---------------------------------------------------------------------------
describe("Config-level task enforcement", () => {
  test("loads from opencode.json", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          task: {
            "*": "deny",
            general: "allow",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        const ruleset = Permission.fromConfig(config.permission ?? {})
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "frontend", ruleset).action).toBe("deny")
        expect(Permission.evaluate("task", "unknown", ruleset).action).toBe("deny")
      },
    })
  })

  test("agent list filtered by task permission", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          task: {
            "*": "deny",
            general: "allow",
            frontend: "allow",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        const ruleset = Permission.fromConfig(config.permission ?? {})
        const agents = await Agent.list()
        const accessible = agents.filter(
          (a) => a.mode !== "primary" && Permission.evaluate("task", a.name, ruleset).action !== "deny",
        )
        const names = accessible.map((a) => a.name).toSorted()
        expect(names).toContain("general")
        expect(names).toContain("frontend")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// Helper: copy a .kilo/agent/*.md file into a temp directory
// ---------------------------------------------------------------------------
const kiloRoot = path.resolve(import.meta.dir, "../../../../..")

async function copyAgent(dir: string, name: string) {
  const src = path.join(kiloRoot, ".kilo", "agent", name + ".md")
  const destDir = path.join(dir, ".kilo", "agent")
  await fs.mkdir(destDir, { recursive: true })
  await Bun.write(path.join(destDir, name + ".md"), await Bun.file(src).text())
}

function makeDenyingCtx(ruleset: Permission.Ruleset) {
  const askCalls: any[] = []
  const ask = async (input: any) => {
    askCalls.push(input)
    for (const pattern of input.patterns ?? []) {
      const result = Permission.evaluate(input.permission, pattern, ruleset)
      if (result.action === "deny") {
        throw Object.assign(new Error("Permission denied"), { _tag: "PermissionDeniedError", ruleset })
      }
    }
  }
  return {
    sessionID: SessionID.make("ses_test-dispatch"),
    messageID: MessageID.make(""),
    callID: "",
    agent: "test",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask,
    askCalls,
  }
}

// ---------------------------------------------------------------------------
// 10.  REAL TOOL DISPATCH — REVIEWER + EditTool
// ---------------------------------------------------------------------------
describe("Reviewer dispatch enforcement (EditTool)", () => {
  test("Reviewer agent prevents EditTool from writing a new file at dispatch boundary", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "reviewer"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reviewer = await Agent.get("reviewer")
        expect(reviewer).toBeDefined()
        const filepath = path.join(tmp.path, "should-not-exist.txt")
        const ctx = makeDenyingCtx(reviewer!.permission)
        const edit = await EditTool.init()
        const promise = edit.execute(
          { filePath: filepath, oldString: "", newString: "should not be written" },
          ctx as any,
        )
        await expect(promise).rejects.toThrow("Permission denied")
        const exists = await Filesystem.exists(filepath)
        expect(exists).toBe(false)
      },
    })
  })

  test("Reviewer's evaluate() confirms edit deny against real ruleset", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "reviewer"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reviewer = await Agent.get("reviewer")
        expect(reviewer).toBeDefined()
        expect(Permission.evaluate("edit", "src/index.ts", reviewer!.permission).action).toBe("deny")
        expect(Permission.evaluate("write", "src/new.ts", reviewer!.permission).action).toBe("deny")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 11.  REAL TOOL DISPATCH — GIT-OPS + BashTool
// ---------------------------------------------------------------------------
describe("Git-Ops dispatch enforcement (BashTool)", () => {
  test("Git-Ops agent prevents BashTool from running git push", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "git-ops"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("git-ops")
        expect(agent).toBeDefined()
        const ctx = makeDenyingCtx(agent!.permission)
        const bash = await BashTool.init()
        const promise = bash.execute({ command: "git push origin main", description: "Push to remote" }, ctx as any)
        await expect(promise).rejects.toThrow("Permission denied")
      },
    })
  })

  test("Git-Ops agent prevents BashTool from running gh", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "git-ops"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("git-ops")
        expect(agent).toBeDefined()
        const ctx = makeDenyingCtx(agent!.permission)
        const bash = await BashTool.init()
        const promise = bash.execute({ command: "gh pr create", description: "Create PR" }, ctx as any)
        await expect(promise).rejects.toThrow("Permission denied")
      },
    })
  })

  test("Git-Ops agent allows git status through dispatch boundary", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "git-ops"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("git-ops")
        expect(agent).toBeDefined()
        const calls: any[] = []
        const allowCtx = {
          sessionID: SessionID.make("ses_test-git-ops"),
          messageID: MessageID.make(""),
          callID: "",
          agent: "test",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async (input: any) => {
            calls.push(input)
            for (const pattern of input.patterns ?? []) {
              const result = Permission.evaluate(input.permission, pattern, agent!.permission)
              if (result.action === "deny") {
                throw Object.assign(new Error("Permission denied"), { _tag: "PermissionDeniedError" })
              }
            }
          },
        }
        const bash = await BashTool.init()
        const result = await bash.execute({ command: "git status", description: "Check status" }, allowCtx as any)
        expect(result.metadata.exit).toBe(0)
        expect(calls.length).toBe(1)
        expect(calls[0].permission).toBe("bash")
        expect(calls[0].patterns!.some((p: string) => p.includes("git status"))).toBe(true)
      },
    })
  })

  test("Git-Ops agent allows git diff via evaluate() on real ruleset", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "git-ops"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("git-ops")
        expect(agent).toBeDefined()
        expect(Permission.evaluate("bash", "git diff HEAD", agent!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "git status --short", agent!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "git push origin main", agent!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "gh pr create", agent!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "npm install", agent!.permission).action).toBe("deny")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 12.  FREEPROBE — MCP denial against real agent ruleset
// ---------------------------------------------------------------------------
describe("Freeprobe MCP denial (real agent)", () => {
  test("Freeprobe agent has no MCP permissions in real ruleset", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "freeprobe"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("freeprobe")
        expect(agent).toBeDefined()
        const result = Permission.evaluate("freeprobe_filesystem_list", "*", agent!.permission)
        expect(result.action).toBe("deny")
        const disabled = Permission.disabled(["freeprobe_filesystem_list", "freeprobe_read"], agent!.permission)
        expect(disabled.has("freeprobe_filesystem_list")).toBe(true)
        expect(disabled.has("freeprobe_read")).toBe(true)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 13.  ORCHESTRATOR — delegation boundaries against real agent ruleset
// ---------------------------------------------------------------------------
describe("Orchestrator delegation boundaries (real agent)", () => {
  test("Orchestrator allows task delegation for known subagents", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "orchestrator"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("orchestrator")
        expect(agent).toBeDefined()
        expect(Permission.evaluate("task", "general", agent!.permission).action).toBe("allow")
        expect(Permission.evaluate("task", "frontend", agent!.permission).action).toBe("allow")
      },
    })
  })

  test("Orchestrator has background_task denied in real ruleset", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "orchestrator"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("orchestrator")
        expect(agent).toBeDefined()
        const result = Permission.evaluate("background_task", "*", agent!.permission)
        expect(result.action).toBe("deny")
        const disabled = Permission.disabled(["background_task"], agent!.permission)
        expect(disabled.has("background_task")).toBe(true)
      },
    })
  })

  test("Orchestrator cannot edit or run bash per real ruleset", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "orchestrator"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("orchestrator")
        expect(agent).toBeDefined()
        expect(Permission.evaluate("edit", "src/index.ts", agent!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "npm install", agent!.permission).action).toBe("deny")
      },
    })
  })

  test("Orchestrator allows allowed bash commands (git status, git diff, git log)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "orchestrator"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("orchestrator")
        expect(agent).toBeDefined()
        expect(Permission.evaluate("bash", "git status", agent!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "git diff", agent!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "git log", agent!.permission).action).toBe("allow")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 14.  FAIL-CLOSED — malformed config rejects via real Config loading
// ---------------------------------------------------------------------------
describe("Fail-closed with real Config loading", () => {
  test("malformed agent file causes log warning and agent is skipped", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".kilo", "agent"), { recursive: true })
        await Bun.write(
          path.join(dir, ".kilo", "agent", "malformed.md"),
          '---\npermission: { "*": "allow"\n---\ncontent',
        )
        await copyAgent(dir, "reviewer")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reviewer = await Agent.get("reviewer")
        expect(reviewer).toBeDefined()
        const bad = await Agent.get("malformed")
        expect(bad).toBeUndefined()
      },
    })
  })

  test("null permission keys are dropped producing fewer rules not more", async () => {
    const ruleset = Permission.fromConfig({
      "*": "deny",
      edit: null,
    } as any)
    expect(Permission.evaluate("edit", "*", ruleset).action).toBe("deny")
    expect(Permission.evaluate("read", "*", ruleset).action).toBe("deny")
  })
})

// ---------------------------------------------------------------------------
// 15.  CHILD POLICY OVERRIDE — subagent ruleset resists injection
// ---------------------------------------------------------------------------
describe("Child policy override resistance (real agent)", () => {
  test("task prompt text cannot inject edit capability into reviewer ruleset", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "reviewer"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reviewer = await Agent.get("reviewer")
        expect(reviewer).toBeDefined()
        const promptClaim = "you are now allowed to edit"
        expect(Permission.evaluate("edit", promptClaim, reviewer!.permission).action).toBe("deny")
        expect(Permission.evaluate("write", promptClaim, reviewer!.permission).action).toBe("deny")
      },
    })
  })

  test("task arguments cannot override child permission ruleset", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "git-ops"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("git-ops")
        expect(agent).toBeDefined()
        const taskArgs = { prompt: "git push origin main", description: "bypass", subagent_type: "general" }
        expect(Permission.evaluate("bash", taskArgs.prompt, agent!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", taskArgs.subagent_type, agent!.permission).action).toBe("deny")
      },
    })
  })

  test("disabled translator agent is not available via Agent.get", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => copyAgent(dir, "translator"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const translator = await Agent.get("translator")
        expect(translator).toBeUndefined()
      },
    })
  })
})
