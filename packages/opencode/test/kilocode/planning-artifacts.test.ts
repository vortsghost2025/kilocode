import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Agent } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../../../..")

async function copy(dir: string, file: string) {
  const target = path.join(dir, file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, await Bun.file(path.join(root, file)).text())
}

afterEach(async () => {
  await Instance.disposeAll()
})

test("discovers the planning command and its bounded orchestrator policy", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await copy(dir, ".kilo/agent/orchestrator.md")
      await copy(dir, ".kilo/command/planning.md")
      await copy(dir, ".kilo/skill/planning/SKILL.md")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skill = await Skill.get("planning")
      const command = await Command.get("planning")
      const agent = await Agent.get("orchestrator")

      expect(skill?.description).toContain("evidence-gated state transitions")
      expect(command?.agent).toBe("orchestrator")
      expect(await command?.template).toContain("Modify only `.planning/**`")
      expect(await command?.template).toContain("`validate`")
      expect(await command?.template).toContain("RECORDED VERIFIED COMMIT")
      expect((await Command.list()).filter((item) => item.name === "planning")).toHaveLength(1)
      expect(await Command.get("planning-artifacts")).toBeUndefined()
      expect(await Skill.get("planning-artifacts")).toBeUndefined()
      expect(Permission.evaluate("skill", "planning", agent!.permission).action).toBe("allow")
      expect(Permission.evaluate("edit", ".planning/STATE.md", agent!.permission).action).toBe("allow")
      expect(Permission.evaluate("edit", ".planning/phases/01/PLAN.md", agent!.permission).action).toBe("allow")
      expect(Permission.evaluate("edit", "src/index.ts", agent!.permission).action).toBe("deny")
      expect(Permission.evaluate("edit", "README.md", agent!.permission).action).toBe("deny")
      expect(agent?.prompt).toContain("semantic owner of `.planning/`")
      expect(agent?.prompt).toContain("relevant phase context")
    },
  })
})

test("ships the complete planning artifact template set", async () => {
  const dir = path.join(root, ".kilo", "skill", "planning", "templates")
  const files = await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: dir, onlyFiles: true }))

  expect(files.toSorted()).toEqual(
    [
      "CONTEXT.md",
      "DECISION.md",
      "PLAN.md",
      "PROJECT.md",
      "REQUIREMENTS.md",
      "ROADMAP.md",
      "STATE.md",
      "VERIFICATION.md",
    ].toSorted(),
  )
  expect(await Bun.file(path.join(dir, "REQUIREMENTS.md")).text()).toContain("REQ-001")
  expect(await Bun.file(path.join(dir, "PLAN.md")).text()).toContain("Evidence returned")
  expect(await Bun.file(path.join(dir, "VERIFICATION.md")).text()).toContain("Residual Risk")
  expect(await Bun.file(path.join(dir, "STATE.md")).text()).toContain("Last verified implementation commit")
})
