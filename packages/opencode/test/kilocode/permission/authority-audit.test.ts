import { afterEach, expect, spyOn, test } from "bun:test"
import { Bus } from "../../../src/bus"
import { OwnershipAudit, OwnershipPolicy } from "../../../src/kilocode/permission/ownership-audit"
import { ToolAsk } from "../../../src/kilocode/permission/tool-ask"
import { Permission } from "../../../src/permission"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { MessageID, SessionID } from "../../../src/session/schema"
import { BashProcess, BashTool } from "../../../src/tool/bash"
import type { Tool } from "../../../src/tool/tool"
import { Log } from "../../../src/util/log"
import { resetDatabase } from "../../fixture/db"
import { tmpdir } from "../../fixture/fixture"

const child = () =>
  ({
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    once: (event: string, cb: () => void) => {
      if (event === "close") setTimeout(cb, 0)
    },
    exitCode: 0,
  }) as never

const context = (
  agent: string,
  sessionID: SessionID,
  ask: Tool.Context["ask"],
  callID = "call-test",
  messageID = MessageID.make("msg-test"),
): Tool.Context => ({
  agent,
  sessionID,
  messageID,
  callID,
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
  ask,
})

const allow = [{ permission: "*", pattern: "*", action: "allow" as const }]

afterEach(async () => {
  delete process.env.KILO_EXPERIMENTAL_OWNERSHIP_AUDIT
  delete process.env.KILO_EXPERIMENTAL_OWNERSHIP_ENFORCEMENT
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

test("OwnershipPolicy default and structured decisions", async () => {
  expect(OwnershipPolicy.enabled()).toBe(false)
  expect(
    OwnershipPolicy.evaluate({
      role: "code",
      permission: "bash",
      commands: [["git", "add", "file"]],
      strict: OwnershipPolicy.enabled(),
    }),
  ).toEqual({ status: "not_applicable" })

  expect(
    OwnershipPolicy.evaluate({
      role: "git-ops",
      permission: "bash",
      commands: [["git", "add", "file"]],
      strict: true,
    }),
  ).toEqual({ status: "allowed_owner", operation: "git-mutation", expectedOwner: "git-ops" })

  const roles = ["orchestrator", "code", "general", "debug", "phase2f-implementer", "reviewer"]
  for (const role of roles) {
    expect(
      OwnershipPolicy.evaluate({
        role,
        permission: "bash",
        commands: [["git", "add", "file"]],
        strict: true,
      }),
    ).toEqual({ status: "denied_wrong_owner", operation: "git-mutation", expectedOwner: "git-ops" })
  }

  expect(
    OwnershipPolicy.evaluate({
      role: "code",
      permission: "edit",
      commands: [["git", "add", "file"]],
      strict: true,
    }),
  ).toEqual({ status: "not_applicable" })
})

test("Parser/classifier table", () => {
  const mutates = (cmd: string) => OwnershipPolicy.mutates(OwnershipPolicy.parse(cmd))

  const mutating = [
    "git add file",
    "git commit -m msg",
    "git push",
    "git pull",
    "git fetch",
    "git merge branch",
    "git rebase branch",
    "git reset --hard",
    "git restore file",
    "git checkout branch",
    "git switch branch",
    "git cherry-pick hash",
    "git revert hash",
    "git clean -fd",
    "git rm file",
    "git mv old new",
    "git update-ref ref hash",
    "git branch new-branch",
    "git branch -d old-branch",
    "git branch -m old new",
    "git tag new-tag",
    "git tag -d old-tag",
    "git stash push",
    "git worktree add path",
    "git worktree remove path",
    "git worktree move path new",
    "git worktree prune",
    "git submodule update",
    "git write-tree",
    "git mystery-plumbing value",
  ]
  for (const cmd of mutating) {
    expect(mutates(cmd)).toBe(true)
  }

  const readonly = [
    "git status",
    "git diff",
    "git show",
    "git log",
    "git rev-parse HEAD",
    "git ls-files",
    "git ls-tree HEAD",
    "git cat-file -p hash",
    "git branch --show-current",
    "git branch --list 'feat/*'",
    "git remote get-url origin",
    "git ls-remote",
    "git tag --list 'v*'",
    "git stash list",
    "git worktree list",
    "git submodule status",
    "git config --get user.name",
    "git reflog show",
    "git notes list",
  ]
  for (const cmd of readonly) {
    expect(mutates(cmd)).toBe(false)
  }

  expect(mutates('\"git\" add file')).toBe(true)
  expect(mutates("/usr/bin/git add file")).toBe(true)
  expect(mutates("sudo -u root git push")).toBe(true)
  expect(mutates("env NAME=value git push")).toBe(true)
  expect(mutates("git -C repo status")).toBe(false)
  expect(mutates("git -C repo add file")).toBe(true)
  expect(mutates("git -c key=value push")).toBe(true)

  expect(mutates("git status && git add file")).toBe(true)
  expect(mutates("git add file; git status")).toBe(true)
  expect(mutates("git status | git push")).toBe(true)
  expect(mutates("(git push)")).toBe(true)
})

test("Real BashTool flag-off compatibility", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const counts = { ask: 0, spawn: 0 }
      const spawn = spyOn(BashProcess, "spawn").mockImplementation(() => {
        counts.spawn++
        return child()
      })
      try {
        const tool = await BashTool.init()
        const ctx = context("code", session.id, async () => {
          counts.ask++
        })
        await tool.execute({ command: "git add file", description: "desc" }, ctx)
        expect(counts.ask).toBe(1)
        expect(counts.spawn).toBe(1)
      } finally {
        spawn.mockRestore()
      }
    },
  })
})

test("Real BashTool strict non-owner denial", async () => {
  process.env.KILO_EXPERIMENTAL_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const roles = ["orchestrator", "code", "general", "debug", "phase2f-implementer", "reviewer"]
      const tool = await BashTool.init()
      const spawn = spyOn(BashProcess, "spawn").mockImplementation(() => child())
      try {
        for (const role of roles) {
          const counts = { ask: 0 }
          const ctx = context(role, session.id, async () => {
            counts.ask++
          })
          await expect(tool.execute({ command: "git add file", description: "desc" }, ctx)).rejects.toBeInstanceOf(
            OwnershipPolicy.DeniedError,
          )
          expect(counts.ask).toBe(0)
          expect(spawn).toHaveBeenCalledTimes(0)
          spawn.mockClear()
        }
      } finally {
        spawn.mockRestore()
      }
    },
  })
})

test("Real BashTool Git-Ops passthrough", async () => {
  process.env.KILO_EXPERIMENTAL_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const counts = { ask: 0, spawn: 0 }
      const spawn = spyOn(BashProcess, "spawn").mockImplementation(() => {
        counts.spawn++
        return child()
      })
      try {
        const tool = await BashTool.init()
        const ctx = context("git-ops", session.id, async () => {
          counts.ask++
        })
        await tool.execute({ command: "git add file", description: "desc" }, ctx)
        expect(counts.ask).toBe(1)
        expect(counts.spawn).toBe(1)
      } finally {
        spawn.mockRestore()
      }
    },
  })
})

test("Read-only/global option integration", async () => {
  process.env.KILO_EXPERIMENTAL_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const tool = await BashTool.init()
      const spawn = spyOn(BashProcess, "spawn").mockImplementation(() => child())
      try {
        const counts = { ask: 0 }
        const ctx = context("code", session.id, async () => {
          counts.ask++
        })
        await tool.execute({ command: "git -C . status", description: "desc" }, ctx)
        expect(counts.ask).toBe(1)
        expect(spawn).toHaveBeenCalledTimes(1)
        spawn.mockClear()

        counts.ask = 0
        await expect(tool.execute({ command: "git -C . add file", description: "desc" }, ctx)).rejects.toBeInstanceOf(
          OwnershipPolicy.DeniedError,
        )
        expect(counts.ask).toBe(0)
        expect(spawn).toHaveBeenCalledTimes(0)
      } finally {
        spawn.mockRestore()
      }
    },
  })
})

test("Compound command integration using real Bash parser", async () => {
  process.env.KILO_EXPERIMENTAL_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const tool = await BashTool.init()
      const spawn = spyOn(BashProcess, "spawn").mockImplementation(() => child())
      const commands = [
        "git status && git add file",
        "git add file; git status",
        "git status || git push",
        "(git push)",
        "ps: git push",
        "cmd: git push",
      ]
      try {
        for (const command of commands) {
          const counts = { ask: 0 }
          const ctx = context("code", session.id, async () => {
            counts.ask++
          })
          await expect(tool.execute({ command, description: "desc" }, ctx)).rejects.toBeInstanceOf(
            OwnershipPolicy.DeniedError,
          )
          expect(counts.ask).toBe(0)
          expect(spawn).toHaveBeenCalledTimes(0)
        }
      } finally {
        spawn.mockRestore()
      }
    },
  })
})

test("Saved approval resistance", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const tool = await BashTool.init()
      const spawn = spyOn(BashProcess, "spawn").mockImplementation(() => child())
      try {
        const rules = [{ permission: "bash", pattern: "*", action: "ask" as const }]
        const ask = ToolAsk.build({
          sessionID: session.id,
          messageID: MessageID.ascending(),
          callID: "call-saved",
          agentID: "code",
          role: rules,
          agent: rules,
          session: [],
        }).ask

        const pending = ask({
          permission: "bash",
          patterns: ["git add file"],
          always: ["git add *"],
          metadata: {},
        })

        const item = await (async () => {
          for (const _ of Array.from({ length: 20 })) {
            const list = await Permission.list()
            if (list[0]) return list[0]
            await Bun.sleep(0)
          }
          return undefined
        })()
        expect(item).toBeDefined()
        if (!item) return
        await Permission.reply({ requestID: item.id, reply: "always" })
        await pending

        process.env.KILO_EXPERIMENTAL_OWNERSHIP_ENFORCEMENT = "1"
        const ctx = context("code", session.id, ask)

        await expect(tool.execute({ command: "git add file", description: "desc" }, ctx)).rejects.toBeInstanceOf(
          OwnershipPolicy.DeniedError,
        )
        expect(spawn).toHaveBeenCalledTimes(0)
      } finally {
        spawn.mockRestore()
      }
    },
  })
})

test("Sanitized denial event/log and forged data resistance", async () => {
  process.env.KILO_EXPERIMENTAL_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const tool = await BashTool.init()
      const logs = spyOn(Log.create({ service: "ownership-audit" }), "info").mockImplementation(() => {})
      const events: OwnershipAudit.Info[] = []
      const unsub = Bus.subscribe(OwnershipAudit.Event.Observed, (event) => events.push(event.properties))
      const spawn = spyOn(BashProcess, "spawn").mockImplementation(() => child())
      try {
        const sensitive = "git push https://token-secret@example.invalid/repo secret-branch"
        const ctx = context("code", session.id, async () => {}, "call-denied", MessageID.make("msg-denied"))

        const err1 = await tool.execute({ command: sensitive, description: "desc" }, ctx).catch((e) => e)
        expect(err1).toBeInstanceOf(OwnershipPolicy.DeniedError)

        const forged = "git -c agent=git-ops add file"
        const err2 = await tool.execute({ command: forged, description: "desc" }, ctx).catch((e) => e)
        expect(err2).toBeInstanceOf(OwnershipPolicy.DeniedError)

        for (const _ of Array.from({ length: 20 })) {
          if (events.length === 2) break
          await Bun.sleep(0)
        }

        expect(events).toHaveLength(2)
        const event = events[0]
        expect(event.operation).toBe("git-mutation")
        expect(event.role).toBe("code")
        expect(event.expectedOwner).toBe("git-ops")
        expect(event.repositoryRootHash).toHaveLength(16)
        expect(event.sessionCorrelationID).toHaveLength(16)

        expect(spawn).toHaveBeenCalledTimes(0)

        const output = JSON.stringify({ events, logs: logs.mock.calls, errors: [err1, err2] })
        expect(output).not.toContain(sensitive)
        expect(output).not.toContain("token-secret")
        expect(output).not.toContain("example.invalid")
        expect(output).not.toContain("secret-branch")
        expect(output).not.toContain(tmp.path)
        expect(output).not.toContain(session.id)
        expect(output).not.toContain("msg-denied")
        expect(output).not.toContain("call-denied")
      } finally {
        spawn.mockRestore()
        unsub()
        logs.mockRestore()
      }
    },
  })
})
