// kilocode_change - new file
import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Bus } from "../../../src/bus"
import { Config } from "../../../src/config/config"
import { Instance } from "../../../src/project/instance"
import { Skill } from "../../../src/skill"
import { Discovery } from "../../../src/skill/discovery"
import { tmpdir } from "../../fixture/fixture"

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

test("discovers all project skills through the real Skill service", async () => {
  await using tmp = await tmpdir()
  const root = path.resolve(import.meta.dir, "../../../../..")
  const info: Config.Info = {}
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      get: () => Effect.succeed(info),
      getGlobal: () => Effect.succeed(info),
      update: () => Effect.void,
      updateGlobal: (value) => Effect.succeed(value),
      invalidate: () => Effect.void,
      directories: () => Effect.succeed([path.join(root, ".kilo")]),
      waitForDependencies: () => Effect.void,
      warnings: () => Effect.succeed([]),
    }),
  )
  const discovery = Layer.succeed(
    Discovery.Service,
    Discovery.Service.of({ pull: () => Effect.succeed([]) }),
  )
  const deps = Layer.mergeAll(config, discovery, Bus.layer)
  const layer = Skill.layer.pipe(Layer.provide(deps))
  const program = Effect.gen(function* () {
    const service = yield* Skill.Service
    return yield* service.available()
  })
  const available = await Instance.provide({
    directory: tmp.path,
    fn: () => Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer)))),
  })
  const project = available
    .filter((item) => item.location.startsWith(path.join(root, ".kilo", "skills")))
    .toSorted((a, b) => a.name.localeCompare(b.name))

  expect(project.map((item) => item.name)).toEqual(names)
  expect(project.every((item) => item.description.length > 20)).toBe(true)
  expect(project.every((item) => Object.keys(item).toSorted().join(",") === "content,description,location,name")).toBe(
    true,
  )
})
