import { afterEach, expect, spyOn, test } from "bun:test"
import { Bus } from "../../../src/bus"
import { OwnershipAudit } from "../../../src/kilocode/permission/ownership-audit"
import { ToolAsk } from "../../../src/kilocode/permission/tool-ask"
import { Permission } from "../../../src/permission"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { MessageID } from "../../../src/session/schema"
import { Log } from "../../../src/util/log"
import { resetDatabase } from "../../fixture/db"
import { tmpdir } from "../../fixture/fixture"

const allow = [{ permission: "*", pattern: "*", action: "allow" as const }]

afterEach(async () => {
  delete process.env.KILO_EXPERIMENTAL_OWNERSHIP_AUDIT
  await Instance.disposeAll()
  await resetDatabase()
})

test("denial trace identifies its source without logging raw commands", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const info = spyOn(Log.create({ service: "permission" }), "info").mockImplementation(() => {})
      const session = await Session.create({})
      const command = "bun install secret-package --token=secret-value"
      try {
        await expect(
          Permission.ask(
            {
              sessionID: session.id,
              permission: "bash",
              patterns: [command],
              always: ["bun install *"],
              metadata: {},
              ruleset: allow,
            },
            [{ permission: "bash", pattern: "*", action: "deny" }],
          ),
        ).rejects.toBeInstanceOf(Permission.DeniedError)

        const decision = info.mock.calls.find((call) => call[0] === "decision")?.[1]
        expect(decision).toMatchObject({ permission: "bash", action: "deny", source: "canonical-role" })
        expect(decision?.winningPatternHash).toHaveLength(16)
        expect(decision?.correlationID).toHaveLength(16)
        expect(JSON.stringify(info.mock.calls)).not.toContain(command)
        expect(JSON.stringify(info.mock.calls)).not.toContain("secret-value")
      } finally {
        info.mockRestore()
      }
    },
  })
})

test("permission ask log hashes raw commands", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const info = spyOn(Log.create({ service: "permission" }), "info").mockImplementation(() => {})
      const session = await Session.create({})
      const command = "bun install secret-package --token=secret-value"
      try {
        const pending = Permission.ask(
          {
            sessionID: session.id,
            permission: "bash",
            patterns: [command],
            always: ["bun install *"],
            metadata: {},
            ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
          },
          [{ permission: "bash", pattern: "*", action: "ask" }],
        )
        const request = await (async () => {
          for (const _ of Array.from({ length: 20 })) {
            const item = (await Permission.list())[0]
            if (item) return item
            await Bun.sleep(0)
          }
          return undefined
        })()
        expect(request).toBeDefined()
        if (!request) return
        await Permission.reply({ requestID: request.id, reply: "reject" })
        await expect(pending).rejects.toBeInstanceOf(Permission.RejectedError)

        const asking = info.mock.calls.find((call) => call[0] === "asking")?.[1]
        expect(asking?.patternHashes).toHaveLength(1)
        expect(asking?.patternHashes[0]).toHaveLength(16)
        expect(JSON.stringify(info.mock.calls)).not.toContain(command)
        expect(JSON.stringify(info.mock.calls)).not.toContain("secret-value")
      } finally {
        info.mockRestore()
      }
    },
  })
})

test("ownership audit is disabled by default", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const result = await OwnershipAudit.record({
        role: "code",
        sessionID: session.id,
        permission: "edit",
        patterns: ["src/secret.ts"],
      })
      expect(result).toBeUndefined()
      expect(OwnershipAudit.classify({ role: "code", permission: "bash", patterns: ["yarn run test"] })).toBeUndefined()
      expect(OwnershipAudit.classify({ role: "code", permission: "bash", patterns: ["yarn"] })).toEqual({
        operation: "package-install",
        expectedOwner: "package-ops",
      })
    },
  })
})

test("ownership audit failures never change permission outcomes", async () => {
  process.env.KILO_EXPERIMENTAL_OWNERSHIP_AUDIT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const publish = spyOn(Bus, "publish").mockRejectedValue(new Error("audit unavailable"))
      try {
        const ask = ToolAsk.build({
          sessionID: session.id,
          messageID: MessageID.ascending(),
          callID: "call-fail-open",
          agentID: "code",
          role: allow,
          agent: allow,
          session: [],
        }).ask
        await expect(
          ask({
            permission: "edit",
            patterns: ["src/index.ts"],
            always: ["*"],
            metadata: {},
          }),
        ).resolves.toBeUndefined()
      } finally {
        publish.mockRestore()
      }
    },
  })
})

test("ownership audit records sanitized events without changing permission outcomes", async () => {
  process.env.KILO_EXPERIMENTAL_OWNERSHIP_AUDIT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const messageID = MessageID.ascending()
      const events: OwnershipAudit.Info[] = []
      const logs = spyOn(Log.create({ service: "ownership-audit" }), "info").mockImplementation(() => {})
      const unsub = Bus.subscribe(OwnershipAudit.Event.Observed, (event) => events.push(event.properties))
      try {
        const ask = ToolAsk.build({
          sessionID: session.id,
          messageID,
          callID: "call-audit",
          agentID: "code",
          role: allow,
          agent: allow,
          session: [],
        }).ask
        await expect(
          ask({
            permission: "edit",
            patterns: ["src/credential-secret.ts"],
            always: ["*"],
            metadata: {},
          }),
        ).resolves.toBeUndefined()

        await OwnershipAudit.record({
          role: "orchestrator",
          sessionID: session.id,
          permission: "bash",
          patterns: ["git push -u sean secret-branch"],
        })
        await OwnershipAudit.record({
          role: "code",
          sessionID: session.id,
          permission: "bash",
          patterns: ["bun install secret-package --token=secret-value"],
        })
        await OwnershipAudit.record({
          role: "git-ops",
          sessionID: session.id,
          permission: "bash",
          patterns: ["git push -u sean approved-branch"],
        })

        expect(events.map((event) => event.operation)).toEqual(["source-mutation", "git-mutation", "package-install"])
        expect(events[0]).toMatchObject({ role: "code", expectedOwner: "phase2f-implementer" })
        expect(events[1]).toMatchObject({ role: "orchestrator", expectedOwner: "git-ops" })
        expect(events[2]).toMatchObject({ role: "code", expectedOwner: "package-ops" })
        expect(events.every((event) => event.sessionCorrelationID.length === 16)).toBe(true)
        expect(events.every((event) => event.repositoryRootHash.length === 16)).toBe(true)

        const output = JSON.stringify({ events, logs: logs.mock.calls })
        expect(output).not.toContain(tmp.path)
        expect(output).not.toContain("credential-secret")
        expect(output).not.toContain("secret-package")
        expect(output).not.toContain("secret-value")
        expect(output).not.toContain("secret-branch")
      } finally {
        unsub()
        logs.mockRestore()
      }
    },
  })
})
