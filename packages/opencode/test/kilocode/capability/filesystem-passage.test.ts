import { afterEach, describe, expect, test } from "bun:test"
import { CapabilityAuthority } from "../../../src/kilocode/capability/authority"
import { AuthorityStore } from "../../../src/kilocode/capability/authority-store"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { resetDatabase } from "../../fixture/db"
import { tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

// Mirrors the orchestrator bash config: deny-all ceiling with scoped allows.
// The rm/mv allows are the passage that lets a filesystem subagent inherit
// cleanup authority through the inherited authority ceiling.
const orchestratorBash = [
  { permission: "bash", pattern: "*", action: "deny" as const },
  { permission: "bash", pattern: "git add *", action: "allow" as const },
  { permission: "bash", pattern: "rm *", action: "allow" as const },
  { permission: "bash", pattern: "mv *", action: "allow" as const },
]

// Mirrors the filesystem subagent bash config.
const filesystemBash = [
  { permission: "bash", pattern: "*", action: "deny" as const },
  { permission: "bash", pattern: "git status", action: "allow" as const },
  { permission: "bash", pattern: "git status *", action: "allow" as const },
  { permission: "bash", pattern: "rm *", action: "allow" as const },
  { permission: "bash", pattern: "mv *", action: "allow" as const },
  { permission: "bash", pattern: "ls *", action: "allow" as const },
]

describe("filesystem subagent permission inheritance", () => {
  test("rm is allowed when orchestrator allows rm and child allows rm", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        await AuthorityStore.create({
          childSessionID: child.id,
          parentSessionID: parent.id,
          layers: [
            {
              kind: "config",
              sourceSessionID: parent.id,
              rules: orchestratorBash,
            },
          ],
        })

        const decision = CapabilityAuthority.evaluate({
          permission: "bash",
          pattern: "rm nul",
          role: filesystemBash,
          agent: filesystemBash,
          sessionID: child.id,
        })

        expect(decision.action).toBe("allow")
      },
    })
  })

  test("rm -rf is allowed via the rm * wildcard passage", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        await AuthorityStore.create({
          childSessionID: child.id,
          parentSessionID: parent.id,
          layers: [
            {
              kind: "config",
              sourceSessionID: parent.id,
              rules: orchestratorBash,
            },
          ],
        })

        const decision = CapabilityAuthority.evaluate({
          permission: "bash",
          pattern: "rm -rf undefined",
          role: filesystemBash,
          agent: filesystemBash,
          sessionID: child.id,
        })

        expect(decision.action).toBe("allow")
      },
    })
  })

  test("arbitrary bash is denied even with rm passage open", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        await AuthorityStore.create({
          childSessionID: child.id,
          parentSessionID: parent.id,
          layers: [
            {
              kind: "config",
              sourceSessionID: parent.id,
              rules: orchestratorBash,
            },
          ],
        })

        const decision = CapabilityAuthority.evaluate({
          permission: "bash",
          pattern: "cat secrets.env",
          role: filesystemBash,
          agent: filesystemBash,
          sessionID: child.id,
        })

        expect(decision.action).toBe("deny")
      },
    })
  })

  test("rm is denied when orchestrator does not include rm passage", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        // Orchestrator config WITHOUT the rm/mv passage — the old config.
        const denyOnly = [
          { permission: "bash", pattern: "*", action: "deny" as const },
          { permission: "bash", pattern: "git add *", action: "allow" as const },
        ]
        await AuthorityStore.create({
          childSessionID: child.id,
          parentSessionID: parent.id,
          layers: [
            {
              kind: "config",
              sourceSessionID: parent.id,
              rules: denyOnly,
            },
          ],
        })

        const decision = CapabilityAuthority.evaluate({
          permission: "bash",
          pattern: "rm nul",
          role: filesystemBash,
          agent: filesystemBash,
          sessionID: child.id,
        })

        expect(decision.action).toBe("deny")
      },
    })
  })
})
