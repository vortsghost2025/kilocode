import { describe, expect, test, spyOn } from "bun:test"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

describe("session.system", () => {
  test("skills output is sorted by name and stable across calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
        await Bun.write(
          path.join(dir, ".kilo", "capability", "build.json"),
          JSON.stringify({ id: "code", roles: ["code"], skills: ["zeta-skill", "alpha-skill", "middle-skill"] }),
        )
      },
    })

    const home = process.env.KILO_TEST_HOME
    process.env.KILO_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await Agent.get("build")
          const first = await SystemPrompt.skills(build!)
          const second = await SystemPrompt.skills(build!)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.KILO_TEST_HOME = home
    }
  })

  test("skills logs only current-role diagnostics and excludes warnings from prompt", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "alpha-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: alpha-skill
description: Alpha skill.
---

# alpha-skill
`,
        )
        await Bun.write(
          path.join(dir, ".kilo", "capability", "build.json"),
          JSON.stringify({
            id: "code-bundle",
            roles: ["code"],
            skills: ["alpha-skill", "missing-current-skill"],
          }),
        )
        await Bun.write(
          path.join(dir, ".kilo", "capability", "plan.json"),
          JSON.stringify({
            id: "plan-bundle",
            roles: ["plan"],
            skills: ["missing-unrelated-skill"],
          }),
        )
      },
    })

    const home = process.env.KILO_TEST_HOME
    process.env.KILO_TEST_HOME = tmp.path

    const warn = spyOn(Log.create({ service: "capability-bundle" }), "warn").mockImplementation(() => {})

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await Agent.get("build")
          const prompt = await SystemPrompt.skills(build!)

          expect(prompt).toBeDefined()
          expect(prompt).toContain("<name>alpha-skill</name>")

          const excludes = [
            "missing-current-skill",
            "missing-unrelated-skill",
            "Unknown skill",
            "capability bundle issue",
            "code-bundle",
            "plan-bundle",
            tmp.path,
          ]
          for (const exclude of excludes) {
            expect(prompt).not.toContain(exclude)
          }

          expect(warn).toHaveBeenCalledTimes(1)
          expect(warn).toHaveBeenCalledWith("capability bundle issue", {
            role: "code",
            category: "unknown-skill",
            manifestID: "code-bundle",
          })

          const calls = JSON.stringify(warn.mock.calls)
          const callExcludes = [
            "plan-bundle",
            "missing-current-skill",
            "missing-unrelated-skill",
            "Unknown skill",
            tmp.path,
          ]
          for (const exclude of callExcludes) {
            expect(calls).not.toContain(exclude)
          }
        },
      })
    } finally {
      warn.mockRestore()
      process.env.KILO_TEST_HOME = home
    }
  })
})
