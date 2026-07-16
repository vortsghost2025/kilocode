// kilocode_change - new file
import { expect, test } from "bun:test"
import path from "node:path"

const names = [
  "baseline-failure-classification",
  "bounded-source-patch",
  "capability-security-review",
  "evidence-handoff",
  "focused-test-validation",
  "orchestrator-delegation",
  "provider-model-routing",
  "repo-state-verification",
  "strict-code-review",
]

test("discovers instruction-only project skills with required policy sections", async () => {
  const root = path.resolve(import.meta.dir, "../../../../..")
  const files = await Array.fromAsync(
    new Bun.Glob(".kilo/skills/**/*").scan({ cwd: root, absolute: true, onlyFiles: true, dot: true }),
  )
  expect(files.map((file) => path.basename(file))).toEqual(names.map(() => "SKILL.md"))

  const found: string[] = []
  for (const file of files) {
    const text = await Bun.file(file).text()
    const name = /^name:\s*(.+)$/m.exec(text)?.[1]
    const description = /^description:\s*(.+)$/m.exec(text)?.[1]
    expect(name).toBe(path.basename(path.dirname(file)))
    expect(description?.length).toBeGreaterThan(20)
    expect(text).toContain("## Activation conditions")
    expect(text).toContain("## Required inputs")
    expect(text).toContain("## Allowed tools")
    expect(text).toContain("## Prohibited actions")
    expect(text).toContain("## Stopping conditions")
    expect(text).toContain("## Required evidence")
    expect(text).toContain("## When this skill must not be used")
    found.push(name!)
  }
  expect(found.toSorted()).toEqual(names)
})
