import { afterEach, describe, expect, test } from "bun:test"
import { CapabilityAuthority } from "../../../src/kilocode/capability/authority"
import { AuthorityStore } from "../../../src/kilocode/capability/authority-store"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { resetDatabase } from "../../fixture/db"
import { tmpdir } from "../../fixture/fixture"

const allow = [{ permission: "bash", pattern: "*", action: "allow" as const }]

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("capability authority decisions", () => {
  test("last matching rule wins within the canonical role", () => {
    const decision = CapabilityAuthority.evaluate({
      permission: "bash",
      pattern: "bun install pkg",
      role: [
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "bun install *", action: "deny" },
      ],
      agent: [],
      correlationID: "corr-last",
    })

    expect(decision).toMatchObject({
      permission: "bash",
      action: "deny",
      winningPattern: "bun install *",
      source: { layer: "canonical-role" },
      correlationID: "corr-last",
    })
  })

  test("strictest action wins across canonical and configured roles", () => {
    const decision = CapabilityAuthority.evaluate({
      permission: "bash",
      pattern: "bun install pkg",
      role: [{ permission: "*", pattern: "*", action: "allow" }],
      agent: [{ permission: "bash", pattern: "bun install *", action: "deny" }],
    })

    expect(decision.action).toBe("deny")
    expect(decision.permission).toBe("bash")
    expect(decision.requestedPermission).toBe("bash")
    expect(decision.source).toEqual({ layer: "configured-role" })
  })

  test("structured metadata preserves the winning rule fields", () => {
    const decision = CapabilityAuthority.evaluate({
      permission: "bash",
      pattern: "bun install pkg",
      role: [{ permission: "*", pattern: "*", action: "deny" }],
      agent: [],
    })

    expect(decision.permission).toBe("*")
    expect(decision.pattern).toBe("*")
    expect(decision.requestedPermission).toBe("bash")
    expect(decision.winningPattern).toBe("*")
  })

  test("saved approval upgrades ask but never deny", () => {
    const approved = [{ permission: "bash", pattern: "bun install *", action: "allow" as const }]
    const ask = CapabilityAuthority.evaluate({
      permission: "bash",
      pattern: "bun install pkg",
      role: [{ permission: "bash", pattern: "*", action: "ask" }],
      agent: [],
      approved,
    })
    const denied = CapabilityAuthority.evaluate({
      permission: "bash",
      pattern: "bun install pkg",
      role: [{ permission: "bash", pattern: "*", action: "deny" }],
      agent: [],
      approved,
    })

    expect(ask.action).toBe("allow")
    expect(ask.source).toEqual({ layer: "saved-approval" })
    expect(denied.action).toBe("deny")
    expect(denied.source).toEqual({ layer: "canonical-role" })
  })

  test("session ask and saved approval identify their sources", () => {
    const session = [{ permission: "bash", pattern: "bun install *", action: "ask" as const }]
    const pending = CapabilityAuthority.evaluate({
      permission: "bash",
      pattern: "bun install pkg",
      role: allow,
      agent: allow,
      session,
    })
    const approved = CapabilityAuthority.evaluate({
      permission: "bash",
      pattern: "bun install pkg",
      role: allow,
      agent: allow,
      session,
      approved: [{ permission: "bash", pattern: "bun install *", action: "allow" }],
    })

    expect(pending.action).toBe("ask")
    expect(pending.source).toEqual({ layer: "session-rule" })
    expect(approved.action).toBe("allow")
    expect(approved.source).toEqual({ layer: "saved-approval" })
  })

  test("inherited deny identifies its authority source", async () => {
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
              kind: "role",
              sourceSessionID: parent.id,
              rules: [{ permission: "bash", pattern: "bun install *", action: "deny" }],
            },
          ],
        })

        const decision = CapabilityAuthority.evaluate({
          permission: "bash",
          pattern: "bun install pkg",
          role: allow,
          agent: allow,
          sessionID: child.id,
        })

        expect(decision.action).toBe("deny")
        expect(decision.source).toEqual({
          layer: "inherited-authority",
          kind: "role",
          sourceSessionID: parent.id,
        })
      },
    })
  })

  test("control deny identifies its authority source", async () => {
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
              kind: "control",
              sourceSessionID: parent.id,
              rules: [{ permission: "bash", pattern: "*", action: "deny" }],
            },
          ],
        })

        const decision = CapabilityAuthority.evaluate({
          permission: "bash",
          pattern: "git status",
          role: allow,
          agent: allow,
          sessionID: child.id,
        })

        expect(decision.action).toBe("deny")
        expect(decision.source).toEqual({ layer: "control-authority", sourceSessionID: parent.id })
      },
    })
  })

  test("delegated lease decision identifies its source", () => {
    const decision = CapabilityAuthority.delegated({
      permission: "edit",
      pattern: "src/index.ts",
      correlationID: "corr-lease",
    })

    expect(decision).toMatchObject({
      action: "allow",
      source: { layer: "delegated-lease" },
      correlationID: "corr-lease",
    })
  })
})
