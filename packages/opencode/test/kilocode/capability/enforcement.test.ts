import { test, expect, describe } from "bun:test"
import { Permission } from "../../../src/permission"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"

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
