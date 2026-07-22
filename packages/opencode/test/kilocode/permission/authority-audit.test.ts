import { afterEach, expect, spyOn, test } from "bun:test"
import { Bus } from "../../../src/bus"
import { OwnershipAudit, OwnershipPolicy, SourceOwnership } from "../../../src/kilocode/permission/ownership-audit"
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
  delete process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT
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

// kilocode_change start — Phase 2B: SourceOwnership tests
test("SourceOwnership feature flag", () => {
  expect(SourceOwnership.enabled()).toBe(false)
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  expect(SourceOwnership.enabled()).toBe(true)
})

test("SourceOwnership classify external planning and project", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ext = SourceOwnership.classify(["../external.ts"])
      expect(ext).toHaveLength(1)
      expect(ext[0].kind).toBe("external")

      const plan = SourceOwnership.classify([".planning/tasks.md"])
      expect(plan).toHaveLength(1)
      expect(plan[0].kind).toBe("planning")

      const proj = SourceOwnership.classify(["src/file.ts"])
      expect(proj).toHaveLength(1)
      expect(proj[0].kind).toBe("project")

      const multi = SourceOwnership.classify(["src/a.ts", ".planning/b.md"])
      expect(multi).toHaveLength(2)
      expect(multi[0].kind).toBe("project")
      expect(multi[1].kind).toBe("planning")
    },
  })
})

test("SourceOwnership evaluate not_applicable cases", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(
        SourceOwnership.evaluate({
          role: "code",
          permission: "edit",
          patterns: ["src/file.ts"],
          strict: false,
        }),
      ).toEqual({ status: "not_applicable" })

      expect(
        SourceOwnership.evaluate({
          role: "code",
          permission: "bash",
          patterns: ["src/file.ts"],
          strict: true,
        }),
      ).toEqual({ status: "not_applicable" })

      expect(
        SourceOwnership.evaluate({
          role: "code",
          permission: "edit",
          patterns: ["../external.ts"],
          strict: true,
        }),
      ).toEqual({ status: "not_applicable" })

      expect(
        SourceOwnership.evaluate({
          role: "code",
          permission: "edit",
          patterns: [".planning/tasks.md"],
          strict: true,
        }),
      ).toEqual({ status: "not_applicable" })
    },
  })
})

test("SourceOwnership evaluate denied_wrong_owner for non-Phase2F roles", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const roles = ["orchestrator", "code", "general", "debug", "reviewer", "git-ops", "unknown"]
      for (const role of roles) {
        expect(
          SourceOwnership.evaluate({
            role,
            permission: "edit",
            patterns: ["src/file.ts"],
            strict: true,
          }),
        ).toEqual({ status: "denied_wrong_owner", expectedOwner: "phase2f-implementer" })
      }

      expect(
        SourceOwnership.evaluate({
          role: "code",
          permission: "edit",
          patterns: ["src/file.ts", ".planning/tasks.md"],
          strict: true,
        }),
      ).toEqual({ status: "denied_wrong_owner", expectedOwner: "phase2f-implementer" })
    },
  })
})

test("SourceOwnership evaluate denied_missing_authorization for Phase2F", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(
        SourceOwnership.evaluate({
          role: "phase2f-implementer",
          permission: "edit",
          patterns: ["src/file.ts"],
          strict: true,
        }),
      ).toEqual({ status: "denied_missing_authorization", expectedOwner: "phase2f-implementer" })
    },
  })
})

test("SourceOwnership integration through ToolAsk: Phase2F denied missing_authorization", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const { ask } = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "call-phase2f",
        operation: "edit",
        agentID: "phase2f-implementer",
        role: allow,
        agent: allow,
        session: [],
      })
      const err = await ask({
        permission: "edit",
        patterns: ["src/test.ts"],
        always: [],
        metadata: {},
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SourceOwnership.DeniedError)
      expect(err).toHaveProperty("data.expectedOwner", "phase2f-implementer")
      expect(err).toHaveProperty("data.reason", "missing_authorization")
    },
  })
})

test("SourceOwnership integration through ToolAsk: non-Phase2F denied wrong_owner", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const roles = ["orchestrator", "code", "general", "debug", "reviewer", "git-ops", "unknown"]
      for (const role of roles) {
        const { ask } = ToolAsk.build({
          sessionID: session.id,
          messageID: MessageID.ascending(),
          callID: `call-${role}`,
          agentID: role,
          role: allow,
          agent: allow,
          session: [],
        })
        const err = await ask({
          permission: "edit",
          patterns: ["src/test.ts"],
          always: [],
          metadata: {},
        }).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(SourceOwnership.DeniedError)
        expect(err).toHaveProperty("data.expectedOwner", "phase2f-implementer")
        expect(err).toHaveProperty("data.reason", "wrong_owner")
      }
    },
  })
})

test("SourceOwnership integration: planning and external paths passthrough", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const build = (role: string) =>
        ToolAsk.build({
          sessionID: session.id,
          messageID: MessageID.ascending(),
          callID: "call-passthrough",
          agentID: role,
          role: allow,
          agent: allow,
          session: [],
        }).ask

      // Planning path with code role → passthrough
      await expect(
        build("code")({
          permission: "edit",
          patterns: [".planning/tasks.md"],
          always: [],
          metadata: {},
        }),
      ).resolves.toBeUndefined()

      // External path with code role → passthrough
      await expect(
        build("code")({
          permission: "edit",
          patterns: ["../external.ts"],
          always: [],
          metadata: {},
        }),
      ).resolves.toBeUndefined()

      // Planning path with phase2f → passthrough
      await expect(
        build("phase2f-implementer")({
          permission: "edit",
          patterns: [".planning/plan.md"],
          always: [],
          metadata: {},
        }),
      ).resolves.toBeUndefined()
    },
  })
})

test("SourceOwnership integration: flag disabled passthrough", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const { ask } = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "call-disabled",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      })
      await expect(
        ask({
          permission: "edit",
          patterns: ["src/file.ts"],
          always: [],
          metadata: {},
        }),
      ).resolves.toBeUndefined()
    },
  })
})

test("SourceOwnership integration: non-edit permission passthrough", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const { ask } = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "call-non-edit",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      })
      await expect(
        ask({
          permission: "bash",
          patterns: ["echo hello"],
          always: [],
          metadata: {},
        }),
      ).resolves.toBeUndefined()
    },
  })
})

test("SourceOwnership integration: saved always-allow does not bypass enforcement", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const { ask } = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "call-saved",
        agentID: "code",
        role: [{ permission: "edit", pattern: "*", action: "allow" as const }],
        agent: [{ permission: "edit", pattern: "*", action: "allow" as const }],
        session: [],
      })
      const err = await ask({
        permission: "edit",
        patterns: ["src/file.ts"],
        always: ["src/*"],
        metadata: {},
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SourceOwnership.DeniedError)
      expect(err).toHaveProperty("data.expectedOwner", "phase2f-implementer")
      expect(err).toHaveProperty("data.reason", "wrong_owner")
    },
  })
})
// kilocode_change end

// kilocode_change start — Phase 2B: delegated lifecycle + real-tool boundary tests
import { DelegatedEdit } from "../../../src/kilocode/delegated-edit"
import { EditTool } from "../../../src/tool/edit"
import { WriteTool } from "../../../src/tool/write"
import { ApplyPatchTool } from "../../../src/tool/apply_patch"
import { ReadTool } from "../../../src/tool/read"
import { PopulateTool } from "../../../src/kilocode/populate-tool"
import fs from "fs/promises"
import path from "path"

const askAllow = async () => {}
function toolContext(
  agent: string,
  sessionID: SessionID,
  ask: (req: { permission: string; patterns: string[]; always: string[]; metadata: any }) => Promise<void>,
  callID = "call-boundary",
  messageID = MessageID.make("msg-boundary"),
): Tool.Context {
  return {
    agent,
    sessionID,
    messageID,
    callID,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask,
  }
}

test("Phase 2B: valid Phase2F exact-path delegated edit succeeds with SourceOwnership enabled", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "target.ts"), "export const v = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ title: "child", parentID: parent.id })
      const scope = DelegatedEdit.scope({ operation: "edit", path: "src/target.ts" })
      const lease = { parent: parent.id, child: child.id, call: "lease-ok", scope }
      const rules = DelegatedEdit.rules(lease)
      const reservation = DelegatedEdit.reserve(lease)
      const binding = DelegatedEdit.bind(reservation, child.id)
      try {
        const evidence = {
          source: "delegated-edit-lease" as const,
          exactText: DelegatedEdit.canonicalLeaseText(lease, 0),
          purpose: "single edit under enforcement",
        }
        const ask = ToolAsk.build({
          sessionID: child.id,
          messageID: MessageID.ascending(),
          callID: "lease-ok",
          operation: "edit",
          agentID: "phase2f-implementer",
          role: rules,
          agent: rules,
          session: rules,
        }).ask
        await expect(
          ask({ permission: "edit", patterns: [scope.path], always: ["*"], metadata: { evidenceRecall: evidence } }),
        ).resolves.toBeUndefined()
        expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)
      } finally {
        binding.release()
      }
    },
  })
})

test("Phase 2B: delegated authorization consumed exactly once", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "once.ts"), "export const x = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ title: "child", parentID: parent.id })
      const scope = DelegatedEdit.scope({ operation: "edit", path: "src/once.ts" })
      const lease = { parent: parent.id, child: child.id, call: "lease-once", scope }
      const rules = DelegatedEdit.rules(lease)
      const reservation = DelegatedEdit.reserve(lease)
      const binding = DelegatedEdit.bind(reservation, child.id)
      try {
        const evidence = {
          source: "delegated-edit-lease" as const,
          exactText: DelegatedEdit.canonicalLeaseText(lease, 0),
          purpose: "first",
        }
        const ask = ToolAsk.build({
          sessionID: child.id,
          messageID: MessageID.ascending(),
          callID: "lease-once",
          operation: "edit",
          agentID: "phase2f-implementer",
          role: rules,
          agent: rules,
          session: rules,
        }).ask
        await ask({ permission: "edit", patterns: [scope.path], always: ["*"], metadata: { evidenceRecall: evidence } })
        expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)
        // Replay on consumed grant throws LeaseExhaustedError, not SourceOwnership.DeniedError
        await expect(
          ask({ permission: "edit", patterns: [scope.path], always: ["*"], metadata: { evidenceRecall: evidence } }),
        ).rejects.toBeInstanceOf(DelegatedEdit.LeaseExhaustedError)
      } finally {
        binding.release()
      }
    },
  })
})

test("Phase 2B: missing evidence fails without consuming grant and retry succeeds", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "retry.ts"), "export const y = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ title: "child", parentID: parent.id })
      const scope = DelegatedEdit.scope({ operation: "edit", path: "src/retry.ts" })
      const lease = { parent: parent.id, child: child.id, call: "lease-retry", scope }
      const rules = DelegatedEdit.rules(lease)
      const reservation = DelegatedEdit.reserve(lease)
      const binding = DelegatedEdit.bind(reservation, child.id)
      try {
        const ask = ToolAsk.build({
          sessionID: child.id,
          messageID: MessageID.ascending(),
          callID: "lease-retry",
          operation: "edit",
          agentID: "phase2f-implementer",
          role: rules,
          agent: rules,
          session: rules,
        }).ask
        // Missing evidence → tool-ask catch block converts to Permission.DeniedError, grant unconsumed
        await expect(
          ask({ permission: "edit", patterns: [scope.path], always: ["*"], metadata: {} }),
        ).rejects.toBeInstanceOf(Permission.DeniedError)
        expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(false)
        // Retry with evidence succeeds
        const evidence = {
          source: "delegated-edit-lease" as const,
          exactText: DelegatedEdit.canonicalLeaseText(lease, 0),
          purpose: "retry",
        }
        await expect(
          ask({ permission: "edit", patterns: [scope.path], always: ["*"], metadata: { evidenceRecall: evidence } }),
        ).resolves.toBeUndefined()
        expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)
      } finally {
        binding.release()
      }
    },
  })
})

test("Phase 2B: sibling, parent/child broadening, and stale evidence fail under enforcement", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "auth.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "src", "sibling.ts"), "export const b = 2\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ title: "child", parentID: parent.id })
      const scope = DelegatedEdit.scope({ operation: "edit", path: "src/auth.ts" })
      const lease = { parent: parent.id, child: child.id, call: "lease-scope", scope }
      const rules = DelegatedEdit.rules(lease)
      const reservation = DelegatedEdit.reserve(lease)
      const binding = DelegatedEdit.bind(reservation, child.id)
      try {
        const evidence = {
          source: "delegated-edit-lease" as const,
          exactText: DelegatedEdit.canonicalLeaseText(lease, 0),
          purpose: "test",
        }
        const ask = ToolAsk.build({
          sessionID: child.id,
          messageID: MessageID.ascending(),
          callID: "lease-scope",
          operation: "edit",
          agentID: "phase2f-implementer",
          role: rules,
          agent: rules,
          session: rules,
        }).ask
        // Sibling path → DeniedError (wrong path)
        await expect(
          ask({
            permission: "edit",
            patterns: ["src/sibling.ts"],
            always: ["*"],
            metadata: { evidenceRecall: evidence },
          }),
        ).rejects.toBeInstanceOf(Permission.DeniedError)
        // Parent path pattern → DeniedError (doesn't match exact scope)
        await expect(
          ask({ permission: "edit", patterns: ["src/*"], always: ["*"], metadata: { evidenceRecall: evidence } }),
        ).rejects.toBeInstanceOf(Permission.DeniedError)
        // Stale evidence (wrong exactText) → tool-ask catch block converts to Permission.DeniedError
        await expect(
          ask({
            permission: "edit",
            patterns: [scope.path],
            always: ["*"],
            metadata: {
              evidenceRecall: { source: "delegated-edit-lease" as const, exactText: "stale", purpose: "stale" },
            },
          }),
        ).rejects.toBeInstanceOf(Permission.DeniedError)
        expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(false)
      } finally {
        binding.release()
      }
    },
  })
})

test("Phase 2B: post-release and cross-session evidence denied", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "release.ts"), "export const r = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const other = await Session.create({ title: "other", parentID: parent.id })
      const child = await Session.create({ title: "child", parentID: parent.id })
      const scope = DelegatedEdit.scope({ operation: "edit", path: "src/release.ts" })
      const lease = { parent: parent.id, child: child.id, call: "lease-release", scope }
      const rules = DelegatedEdit.rules(lease)
      const reservation = DelegatedEdit.reserve(lease)
      const binding = DelegatedEdit.bind(reservation, child.id)
      const evidence = {
        source: "delegated-edit-lease" as const,
        exactText: DelegatedEdit.canonicalLeaseText(lease, 0),
        purpose: "post-release",
      }
      try {
        const ask = ToolAsk.build({
          sessionID: child.id,
          messageID: MessageID.ascending(),
          callID: "lease-release",
          operation: "edit",
          agentID: "phase2f-implementer",
          role: rules,
          agent: rules,
          session: rules,
        }).ask
        await ask({ permission: "edit", patterns: [scope.path], always: ["*"], metadata: { evidenceRecall: evidence } })
      } finally {
        binding.release()
      }
      // Post-release: same evidence on released grant → DeniedError (no binding)
      const askPost = ToolAsk.build({
        sessionID: child.id,
        messageID: MessageID.ascending(),
        callID: "lease-release",
        operation: "edit",
        agentID: "phase2f-implementer",
        role: rules,
        agent: rules,
        session: [],
      }).ask
      await expect(
        askPost({ permission: "edit", patterns: [scope.path], always: ["*"], metadata: { evidenceRecall: evidence } }),
      ).rejects.toBeInstanceOf(Permission.DeniedError)
      // Cross-session: different child session using same evidence → SourceOwnership.DeniedError (no binding)
      const askOther = ToolAsk.build({
        sessionID: other.id,
        messageID: MessageID.ascending(),
        callID: "lease-release",
        operation: "edit",
        agentID: "phase2f-implementer",
        role: rules,
        agent: rules,
        session: [],
      }).ask
      const err = await askOther({
        permission: "edit",
        patterns: [scope.path],
        always: ["*"],
        metadata: { evidenceRecall: evidence },
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SourceOwnership.DeniedError)
    },
  })
})

test("Phase 2B: real EditTool blocks write on SourceOwnership denial", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "block.ts"), "export const v = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "edit-block",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const target = path.join(tmp.path, "src", "block.ts")
      const before = await Bun.file(target).text()
      const read = await ReadTool.init()
      const edit = await EditTool.init()
      const ctx = toolContext("code", session.id, ask, "edit-block")
      await read.execute({ filePath: target }, ctx)
      const err = await edit
        .execute({ filePath: target, oldString: "export const v = 1", newString: "export const v = 2" }, ctx)
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SourceOwnership.DeniedError)
      const after = await Bun.file(target).text()
      expect(after).toBe(before)
    },
  })
})

test("Phase 2B: real WriteTool blocks file creation on SourceOwnership denial", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "write-block",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const target = path.join(tmp.path, "src", "new-file.ts")
      const write = await WriteTool.init()
      const ctx = toolContext("code", session.id, ask, "write-block")
      const err = await write.execute({ filePath: target, content: "blocked" }, ctx).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SourceOwnership.DeniedError)
      expect(
        await fs
          .access(target)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("Phase 2B: ApplyPatch multi-file preflight denies entire patch when one protected target is unauthorized", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await fs.mkdir(path.join(dir, ".planning"), { recursive: true })
      await Bun.write(path.join(dir, "src", "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "src", "b.ts"), "export const b = 2\n")
      await Bun.write(path.join(dir, ".planning", "notes.md"), "# notes\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "patch-multi",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const targetA = path.join(tmp.path, "src", "a.ts")
      const targetB = path.join(tmp.path, "src", "b.ts")
      const targetPlan = path.join(tmp.path, ".planning", "notes.md")
      const beforeA = await Bun.file(targetA).text()
      const beforeB = await Bun.file(targetB).text()
      const beforePlan = await Bun.file(targetPlan).text()
      // kilocode_change — Phase 2B: genuine multi-file preflight
      // Genuine multi-file patch: notes.md (planning, not applicable) + a.ts (project, denied) + b.ts (project, denied)
      const patchText = [
        "*** Begin Patch",
        "*** Update File: .planning/notes.md",
        "@@",
        "-# notes",
        "+# notes updated",
        "*** Update File: src/a.ts",
        "@@",
        "-export const a = 1",
        "+export const a = 2",
        "*** Update File: src/b.ts",
        "@@",
        "-export const b = 2",
        "+export const b = 3",
        "*** End Patch",
      ].join("\n")
      const tool = await ApplyPatchTool.init()
      const ctx = toolContext("code", session.id, ask, "patch-multi")
      const result = await tool.execute({ patchText }, ctx).catch((e: unknown) => e)
      // SourceOwnership enforcement denies the protected project target
      expect(result).toBeInstanceOf(SourceOwnership.DeniedError)
      // No earlier file was changed before a later target was rejected
      const afterA = await Bun.file(targetA).text()
      const afterB = await Bun.file(targetB).text()
      const afterPlan = await Bun.file(targetPlan).text()
      expect(afterA).toBe(beforeA)
      expect(afterB).toBe(beforeB)
      expect(afterPlan).toBe(beforePlan)
    },
  })
})

// kilocode_change start — Phase 2B: ApplyPatch move-destination preflight regression tests

test("Phase 2B: ApplyPatch move from planning source to protected project destination is denied before any mutation", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await fs.mkdir(path.join(dir, ".planning"), { recursive: true })
      await Bun.write(path.join(dir, ".planning", "draft.md"), "draft content\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const src = path.join(tmp.path, ".planning", "draft.md")
      const dest = path.join(tmp.path, "src", "moved.ts")
      const beforeSrc = await Bun.file(src).text()
      // Capture ctx.ask patterns to prove both planning source and project destination enter preflight
      let capturedPatterns: string[] | undefined
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "move-plan-to-proj",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const wrappedAsk = async (req: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, any>
      }) => {
        capturedPatterns = req.patterns
        return ask(req)
      }
      const tool = await ApplyPatchTool.init()
      const ctx = toolContext("code", session.id, wrappedAsk, "move-plan-to-proj")
      const patchText = [
        "*** Begin Patch",
        "*** Update File: .planning/draft.md",
        "*** Move to: src/moved.ts",
        "@@",
        "-draft content",
        "+moved content",
        "*** End Patch",
      ].join("\n")
      const result = await tool.execute({ patchText }, ctx).catch((e: unknown) => e)
      // Planning source is not_applicable, but the protected project destination
      // must enter preflight and deny the move as wrong_owner.
      expect(result).toBeInstanceOf(SourceOwnership.DeniedError)
      // The single permission preflight request must contain BOTH the planning source
      // and the protected project destination — proving move destinations participate.
      expect(capturedPatterns).toEqual([".planning/draft.md", "src/moved.ts"])
      // Source unchanged, destination not created
      expect(await Bun.file(src).text()).toBe(beforeSrc)
      expect(
        await fs
          .access(dest)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("Phase 2B: ApplyPatch move from external source to protected project destination is denied before any mutation", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using outside = await tmpdir()
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(outside.path, "external.md"), "external content\n")
      return outside.path
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const src = path.join(outside.path, "external.md")
      const dest = path.join(tmp.path, "src", "imported.ts")
      const beforeSrc = await Bun.file(src).text()
      // Calculate the real repository-relative path to the external source
      const relativeExternalSource = path.relative(tmp.path, src).replaceAll("\\", "/")
      // Capture ctx.ask patterns to prove both source and destination enter preflight
      let capturedPatterns: string[] | undefined
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "move-ext-to-proj",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const wrappedAsk = async (req: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, any>
      }) => {
        capturedPatterns = req.patterns
        return ask(req)
      }
      const tool = await ApplyPatchTool.init()
      const ctx = toolContext("code", session.id, wrappedAsk, "move-ext-to-proj")
      const patchText = [
        "*** Begin Patch",
        `*** Update File: ${relativeExternalSource}`,
        "*** Move to: src/imported.ts",
        "@@",
        "-external content",
        "+imported content",
        "*** End Patch",
      ].join("\n")
      const result = await tool.execute({ patchText }, ctx).catch((e: unknown) => e)
      // External source is not_applicable to SourceOwnership, but the protected
      // project destination must still enter the preflight and deny the move.
      expect(result).toBeInstanceOf(SourceOwnership.DeniedError)
      // The single permission preflight request must contain BOTH the external source
      // (calculated relative to the worktree) and the protected project destination.
      expect(capturedPatterns).toEqual([relativeExternalSource, "src/imported.ts"])
      // Source unchanged
      expect(await Bun.file(src).text()).toBe(beforeSrc)
      // Destination not created
      expect(
        await fs
          .access(dest)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("Phase 2B: ApplyPatch move from protected project source to planning destination is denied before any mutation", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await fs.mkdir(path.join(dir, ".planning"), { recursive: true })
      await Bun.write(path.join(dir, "src", "file.ts"), "export const v = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "move-proj-to-plan",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const src = path.join(tmp.path, "src", "file.ts")
      const dest = path.join(tmp.path, ".planning", "moved.md")
      const beforeSrc = await Bun.file(src).text()
      const tool = await ApplyPatchTool.init()
      const ctx = toolContext("code", session.id, ask, "move-proj-to-plan")
      const patchText = [
        "*** Begin Patch",
        "*** Update File: src/file.ts",
        "*** Move to: .planning/moved.md",
        "@@",
        "-export const v = 1",
        "+moved to planning\n",
        "*** End Patch",
      ].join("\n")
      const result = await tool.execute({ patchText }, ctx).catch((e: unknown) => e)
      expect(result).toBeInstanceOf(SourceOwnership.DeniedError)
      // Protected source unchanged, planning destination not created
      expect(await Bun.file(src).text()).toBe(beforeSrc)
      expect(
        await fs
          .access(dest)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("Phase 2B: ApplyPatch move from protected project source to external destination is denied before any mutation", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using outside = await tmpdir()
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "file.ts"), "export const v = 1\n")
      return outside.path
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "move-proj-to-ext",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const src = path.join(tmp.path, "src", "file.ts")
      const dest = path.join(outside.path, "moved.ts")
      const beforeSrc = await Bun.file(src).text()
      // Calculate the real repository-relative path to the external destination
      const relativeExternalDest = path.relative(tmp.path, dest).replaceAll("\\", "/")
      // Capture ctx.ask patterns to prove both source and destination enter preflight
      let capturedPatterns: string[] | undefined
      const wrappedAsk = async (req: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, any>
      }) => {
        capturedPatterns = req.patterns
        return ask(req)
      }
      const tool = await ApplyPatchTool.init()
      const ctx = toolContext("code", session.id, wrappedAsk, "move-proj-to-ext")
      const patchText = [
        "*** Begin Patch",
        "*** Update File: src/file.ts",
        `*** Move to: ${relativeExternalDest}`,
        "@@",
        "-export const v = 1",
        "+moved externally\n",
        "*** End Patch",
      ].join("\n")
      const result = await tool.execute({ patchText }, ctx).catch((e: unknown) => e)
      expect(result).toBeInstanceOf(SourceOwnership.DeniedError)
      // The single permission preflight request must contain BOTH the project source
      // and the calculated external destination.
      expect(capturedPatterns).toEqual(["src/file.ts", relativeExternalDest])
      // Project source remains unchanged
      expect(await Bun.file(src).text()).toBe(beforeSrc)
      // Actual external destination is not created
      expect(
        await fs
          .access(dest)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("Phase 2B: ApplyPatch multi-hunk with one move-to-protected-target denies entire patch before any mutation", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await fs.mkdir(path.join(dir, ".planning"), { recursive: true })
      await Bun.write(path.join(dir, "src", "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "src", "b.ts"), "export const b = 2\n")
      await Bun.write(path.join(dir, ".planning", "draft.md"), "draft\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "move-multi-hunk",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const a = path.join(tmp.path, "src", "a.ts")
      const b = path.join(tmp.path, "src", "b.ts")
      const draft = path.join(tmp.path, ".planning", "draft.md")
      const dest = path.join(tmp.path, "src", "moved-draft.ts")
      const beforeA = await Bun.file(a).text()
      const beforeB = await Bun.file(b).text()
      const beforeDraft = await Bun.file(draft).text()
      const tool = await ApplyPatchTool.init()
      const ctx = toolContext("code", session.id, ask, "move-multi-hunk")
      const patchText = [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "-export const a = 1",
        "+export const a = 2",
        "*** Update File: .planning/draft.md",
        "*** Move to: src/moved-draft.ts",
        "@@",
        "-draft",
        "+moved draft\n",
        "*** Delete File: src/b.ts",
        "*** End Patch",
      ].join("\n")
      const result = await tool.execute({ patchText }, ctx).catch((e: unknown) => e)
      expect(result).toBeInstanceOf(SourceOwnership.DeniedError)
      // No mutation: a.ts unchanged, b.ts not deleted, draft.md unchanged, dest not created
      const afterA = await Bun.file(a).text()
      const afterB = await Bun.file(b).text()
      const afterDraft = await Bun.file(draft).text()
      expect(afterA).toBe(beforeA)
      expect(afterB).toBe(beforeB)
      expect(afterDraft).toBe(beforeDraft)
      expect(
        await fs
          .access(dest)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("Phase 2B: ApplyPatch add/update/delete/move combinations with one protected target deny before any mutation", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await fs.mkdir(path.join(dir, ".planning"), { recursive: true })
      await fs.mkdir(path.join(dir, "other"), { recursive: true })
      await Bun.write(path.join(dir, "src", "update.ts"), "export const u = 1\n")
      await Bun.write(path.join(dir, "src", "delete.ts"), "to delete\n")
      await Bun.write(path.join(dir, "other", "move-src.md"), "move me\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "move-combo",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const updateTarget = path.join(tmp.path, "src", "update.ts")
      const deleteTarget = path.join(tmp.path, "src", "delete.ts")
      const moveSrc = path.join(tmp.path, "other", "move-src.md")
      const moveDest = path.join(tmp.path, "src", "moved-dest.ts")
      const addTarget = path.join(tmp.path, "src", "new-file.ts")
      const beforeUpdate = await Bun.file(updateTarget).text()
      const beforeDelete = await Bun.file(deleteTarget).text()
      const beforeMoveSrc = await Bun.file(moveSrc).text()
      const tool = await ApplyPatchTool.init()
      const ctx = toolContext("code", session.id, ask, "move-combo")
      // Add src/new-file.ts (project) + Update src/update.ts (project) +
      // Delete src/delete.ts (project) + Move other/move-src.md → src/moved-dest.ts (project dest)
      const patchText = [
        "*** Begin Patch",
        "*** Add File: src/new-file.ts",
        "+export const n = 1\n",
        "*** Update File: src/update.ts",
        "@@",
        "-export const u = 1",
        "+export const u = 2",
        "*** Delete File: src/delete.ts",
        "*** Update File: other/move-src.md",
        "*** Move to: src/moved-dest.ts",
        "@@",
        "-move me",
        "+moved content\n",
        "*** End Patch",
      ].join("\n")
      const result = await tool.execute({ patchText }, ctx).catch((e: unknown) => e)
      expect(result).toBeInstanceOf(SourceOwnership.DeniedError)
      // Zero mutations: nothing added, nothing updated, nothing deleted, nothing moved
      expect(await Bun.file(updateTarget).text()).toBe(beforeUpdate)
      expect(await Bun.file(deleteTarget).text()).toBe(beforeDelete)
      expect(await Bun.file(moveSrc).text()).toBe(beforeMoveSrc)
      expect(
        await fs
          .access(addTarget)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      expect(
        await fs
          .access(moveDest)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("Phase 2B: ApplyPatch move with identical source-destination deduplication still classified correctly", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "file.ts"), "export const v = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "move-dedup",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const src = path.join(tmp.path, "src", "file.ts")
      const beforeSrc = await Bun.file(src).text()
      const tool = await ApplyPatchTool.init()
      const ctx = toolContext("code", session.id, ask, "move-dedup")
      // Move to the same path (degenerate but valid parse) — should still be denied because src is project
      const patchText = [
        "*** Begin Patch",
        "*** Update File: src/file.ts",
        "*** Move to: src/file.ts",
        "@@",
        "-export const v = 1",
        "+export const v = 2",
        "*** End Patch",
      ].join("\n")
      const result = await tool.execute({ patchText }, ctx).catch((e: unknown) => e)
      expect(result).toBeInstanceOf(SourceOwnership.DeniedError)
      expect(await Bun.file(src).text()).toBe(beforeSrc)
    },
  })
})

// kilocode_change end — Phase 2B: ApplyPatch move-destination preflight regression tests

test("Phase 2B: Phase2F valid lease still succeeds with SourceOwnership enforcement", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "delegated.ts"), "export const d = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ title: "child", parentID: parent.id })
      const scope = DelegatedEdit.scope({ operation: "edit", path: "src/delegated.ts" })
      const lease = { parent: parent.id, child: child.id, call: "lease-success", scope }
      const rules = DelegatedEdit.rules(lease)
      const reservation = DelegatedEdit.reserve(lease)
      const binding = DelegatedEdit.bind(reservation, child.id)
      try {
        const evidence = {
          source: "delegated-edit-lease" as const,
          exactText: DelegatedEdit.canonicalLeaseText(lease, 0),
          purpose: "successful delegated edit under enforcement",
        }
        // role and agent are permissive (allow all) so that ReadTool's
        // ctx.ask call auto-approves via Permission.ask without blocking.
        // session contains the restrictive delegated rules so that
        // DelegatedEdit.authorize can find the delegate_edit marker.
        const permissive = [{ permission: "*", pattern: "*", action: "allow" as const }]
        const ask = ToolAsk.build({
          sessionID: child.id,
          messageID: MessageID.ascending(),
          callID: "lease-success",
          operation: "edit",
          agentID: "phase2f-implementer",
          role: permissive,
          agent: permissive,
          session: rules,
        }).ask
        const target = path.join(tmp.path, "src", "delegated.ts")
        const read = await ReadTool.init()
        const edit = await EditTool.init()
        const ctx = toolContext("phase2f-implementer", child.id, ask, "lease-success")
        await read.execute({ filePath: target }, ctx)
        // EditTool calls ctx.ask internally → ToolAsk.ask → DelegatedEdit.authorize
        // with evidenceRecall, consuming the lease exactly once.
        await edit.execute(
          {
            filePath: target,
            oldString: "export const d = 1",
            newString: "export const d = 2",
            evidenceRecall: evidence,
          },
          ctx,
        )
        expect(await Bun.file(target).text()).toContain("export const d = 2")
        expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)
        // Second call fails with LeaseExhaustedError — the lease was consumed
        await expect(
          edit.execute(
            {
              filePath: target,
              oldString: "export const d = 2",
              newString: "export const d = 3",
              evidenceRecall: evidence,
            },
            ctx,
          ),
        ).rejects.toBeInstanceOf(DelegatedEdit.LeaseExhaustedError)
        expect(await Bun.file(target).text()).toContain("export const d = 2")
        expect(DelegatedEdit.inspect(child.id)?.consumed).toBe(true)
      } finally {
        binding.release()
      }
    },
  })
})

test("Phase 2B: relative and absolute forms classify identically", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const rel = SourceOwnership.classify(["src/file.ts"])
      const abs = SourceOwnership.classify([path.join(tmp.path, "src", "file.ts")])
      expect(rel[0].kind).toBe(abs[0].kind)
    },
  })
})

test("Phase 2B: .. traversal cannot escape classification as project", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(SourceOwnership.classify(["src/../src/file.ts"])[0].kind).toBe("project")
      expect(SourceOwnership.classify(["../external.ts"])[0].kind).toBe("external")
    },
  })
})

test("Phase 2B: .planning-other remains project, not planning", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(SourceOwnership.classify([".planning-other/file.ts"])[0].kind).toBe("project")
      expect(SourceOwnership.classify([".planning/tasks.md"])[0].kind).toBe("planning")
    },
  })
})

test("Phase 2B: nonexistent file beneath normal directory is protected", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "exists.ts"), "")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(SourceOwnership.classify(["src/new-file.ts"])[0].kind).toBe("project")
      expect(
        SourceOwnership.evaluate({
          role: "code",
          permission: "edit",
          patterns: ["src/new-file.ts"],
          strict: true,
        }),
      ).toEqual({ status: "denied_wrong_owner", expectedOwner: "phase2f-implementer" })
    },
  })
})

test("Phase 2B: Phase 2A Git enforcement unchanged with SourceOwnership enabled", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  process.env.KILO_EXPERIMENTAL_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const tool = await BashTool.init()
      const spawn = spyOn(BashProcess, "spawn").mockImplementation(() => child())
      try {
        const ctx = context("code", session.id, async () => {}, "git-still-blocked")
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

test("Phase 2B: package-install behavior unchanged with SourceOwnership enabled", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  process.env.KILO_EXPERIMENTAL_OWNERSHIP_AUDIT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const events: OwnershipAudit.Info[] = []
      const unsub = Bus.subscribe(OwnershipAudit.Event.Observed, (event) => events.push(event.properties))
      try {
        await OwnershipAudit.record({
          role: "code",
          sessionID: session.id,
          permission: "bash",
          patterns: ["bun install secret-package"],
        })
        expect(events).toHaveLength(1)
        expect(events[0].operation).toBe("package-install")
        expect(events[0].expectedOwner).toBe("package-ops")
      } finally {
        unsub()
      }
    },
  })
})

test("Phase 2B: flag disabled preserves mutation behavior", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "flag.ts"), "export const f = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "flag-disabled",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const target = path.join(tmp.path, "src", "flag.ts")
      const before = await Bun.file(target).text()
      const read = await ReadTool.init()
      const edit = await EditTool.init()
      const ctx = toolContext("code", session.id, ask, "flag-disabled")
      await read.execute({ filePath: target }, ctx)
      await edit.execute({ filePath: target, oldString: "export const f = 1", newString: "export const f = 2" }, ctx)
      expect(await Bun.file(target).text()).toContain("export const f = 2")
      // Restore
      await Bun.write(target, before)
    },
  })
})

test("Phase 2B: denial telemetry contains no raw path or patch content", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  process.env.KILO_EXPERIMENTAL_OWNERSHIP_AUDIT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const logs = spyOn(Log.create({ service: "ownership-audit" }), "info").mockImplementation(() => {})
      try {
        const ask = ToolAsk.build({
          sessionID: session.id,
          messageID: MessageID.ascending(),
          callID: "telemetry",
          agentID: "code",
          role: allow,
          agent: allow,
          session: [],
        }).ask
        await ask({
          permission: "edit",
          patterns: ["src/super-secret-credential.ts"],
          always: [],
          metadata: { secretPatch: "TOKEN=abc123" },
        }).catch(() => {})
        const output = JSON.stringify(logs.mock.calls)
        expect(output).not.toContain(tmp.path)
        // The DeniedError itself does not flow through the audit logger, but
        // ensure the audit logger never sees path content either
      } finally {
        logs.mockRestore()
      }
    },
  })
})

test("Phase 2B: symlink escape is fail-closed", async () => {
  await using outside = await tmpdir()
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "real.ts"), "export const r = 1\n")
      await fs
        .symlink(outside.path, path.join(dir, "src", "link"), process.platform === "win32" ? "junction" : "dir")
        .catch(() => {})
      return outside.path
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // canonicalTarget correctly resolves the symlink and classifies
      // nonexistent children of symlink-to-outside as "external".
      const classification = SourceOwnership.classify(["src/link/target.ts"])
      expect(classification[0].kind).toBe("external")
    },
  })
})

test("Phase 2B: Windows slash and case variants classify identically where supported", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const fwd = SourceOwnership.classify(["src/file.ts"])
      const back = SourceOwnership.classify(["src\\file.ts"])
      expect(back[0].kind).toBe(fwd[0].kind)
      if (process.platform === "win32") {
        const upper = SourceOwnership.classify(["SRC/FILE.TS"])
        expect(upper[0].kind).toBe(fwd[0].kind)
      }
    },
  })
})

// kilocode_change start — Phase 2B: canonicalTarget fail-closed resolver tests

test("Phase 2B: canonicalTarget nonexistent path beneath existing directory resolves via ancestor walk (ENOENT fallback)", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "exists.ts"), "export const e = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Nonexistent child of an existing directory classifies from the existing ancestor
      const result = SourceOwnership.classify(["src/does-not-exist.ts"])
      expect(result[0].kind).toBe("project")
    },
  })
})

test("Phase 2B: canonicalTarget symlink loop fails closed to unknown", async () => {
  await using tmp = await tmpdir<boolean>({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      // Create a symlink loop: src/loopA -> src/loopB -> src/loopA
      const loopA = path.join(dir, "src", "loopA")
      const loopB = path.join(dir, "src", "loopB")
      const linkType = process.platform === "win32" ? "junction" : "dir"
      const a = await fs
        .symlink(loopB, loopA, linkType)
        .then(() => true)
        .catch(() => false)
      const b = await fs
        .symlink(loopA, loopB, linkType)
        .then(() => true)
        .catch(() => false)
      // Return whether BOTH symlinks were created. If either failed, the loop
      // fixture is incomplete and the test cannot assert ELOOP behavior.
      return a && b
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      if (tmp.extra !== true) {
        // Platform cannot create a symlink loop (e.g. Windows without privilege).
        // Fail with an explicit reason rather than silently accepting "project".
        throw new Error("symlink-loop fixture could not be created on this platform")
      }
      // A path through a symlink loop must fail closed to unknown, not classify as project.
      // ELOOP during realpath is NOT ENOENT/ENOTDIR, so canonicalTarget must return unknown.
      const result = SourceOwnership.classify(["src/loopA/inner/deep.ts"])
      expect(result[0].kind).toBe("unknown")
      // Never falsely "planning", "external", or "project"
      expect(result[0].kind).not.toBe("project")
      expect(result[0].kind).not.toBe("planning")
      expect(result[0].kind).not.toBe("external")
    },
  })
})

test("Phase 2B: canonicalTarget nonexistent path in nonexistent nested directory resolves via successive ancestor walk", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Fully nonexistent nested path — every ancestor is missing
      const result = SourceOwnership.classify(["src/nested/deep/file.ts"])
      expect(result[0].kind).toBe("project")
    },
  })
})

// kilocode_change — Phase 2B: force EACCES via realpathSync.native spy
test("Phase 2B: canonicalTarget EACCES from realpath fails closed to unknown", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "real.ts"), "export const r = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Force realpathSync.native to throw EACCES ONLY for the candidate path.
      // EACCES is NOT ENOENT/ENOTDIR, so canonicalTarget must fail closed to unknown
      // rather than continuing ancestor resolution.
      // Other realpathSync calls (e.g. Filesystem.resolve for the worktree root)
      // must delegate to the original implementation.
      const nodeFs = await import("fs")
      const target = path.join(tmp.path, "src", "real.ts")
      const native = nodeFs.realpathSync.native
      const realSpy = spyOn(
        nodeFs.realpathSync as unknown as { native: (p: string) => string },
        "native",
      ).mockImplementation((p: string) => {
        if (p === target || p === target.replaceAll("\\", "/")) {
          const err = new Error("EACCES: permission denied") as Error & { code?: string }
          err.code = "EACCES"
          throw err
        }
        return native(p)
      })
      try {
        const result = SourceOwnership.classify(["src/real.ts"])
        expect(result[0].kind).toBe("unknown")
        expect(result[0].kind).not.toBe("project")
        expect(result[0].kind).not.toBe("planning")
        expect(result[0].kind).not.toBe("external")
      } finally {
        realSpy.mockRestore()
      }
    },
  })
})

// kilocode_change — Phase 2B: force EPERM via realpathSync.native spy (second non-ENOENT failure path)
test("Phase 2B: canonicalTarget EPERM from realpath fails closed to unknown", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "perm.ts"), "export const p = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Force realpathSync.native to throw EPERM ONLY for the candidate path.
      // EPERM is NOT ENOENT/ENOTDIR, so canonicalTarget must fail closed to unknown.
      // Other realpathSync calls (e.g. Filesystem.resolve for the worktree root)
      // must delegate to the original implementation.
      const nodeFs = await import("fs")
      const target = path.join(tmp.path, "src", "perm.ts")
      const native = nodeFs.realpathSync.native
      const realSpy = spyOn(
        nodeFs.realpathSync as unknown as { native: (p: string) => string },
        "native",
      ).mockImplementation((p: string) => {
        if (p === target || p === target.replaceAll("\\", "/")) {
          const err = new Error("EPERM: operation not permitted") as Error & { code?: string }
          err.code = "EPERM"
          throw err
        }
        return native(p)
      })
      try {
        const result = SourceOwnership.classify(["src/perm.ts"])
        expect(result[0].kind).toBe("unknown")
        expect(result[0].kind).not.toBe("project")
        expect(result[0].kind).not.toBe("planning")
        expect(result[0].kind).not.toBe("external")
      } finally {
        realSpy.mockRestore()
      }
    },
  })
})

// kilocode_change end — Phase 2B: canonicalTarget fail-closed resolver tests

test("Phase 2B: source-denial telemetry emits sanitized Bus event", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const events: OwnershipAudit.Info[] = []
      const unsub = Bus.subscribe(OwnershipAudit.Event.Observed, (event) => events.push(event.properties))
      const logs = spyOn(Log.create({ service: "ownership-audit" }), "info").mockImplementation(() => {})
      try {
        const ask = ToolAsk.build({
          sessionID: session.id,
          messageID: MessageID.ascending(),
          callID: "telemetry-denial",
          agentID: "code",
          role: allow,
          agent: allow,
          session: [],
        }).ask
        await ask({
          permission: "edit",
          patterns: ["src/secret-credential.ts"],
          always: [],
          metadata: {},
        }).catch(() => {})
        // Wait for async telemetry
        for (const _ of Array.from({ length: 20 })) {
          if (events.length > 0) break
          await Bun.sleep(0)
        }
        expect(events.length).toBeGreaterThanOrEqual(1)
        const event = events[0]
        expect(event.operation).toBe("source-mutation")
        expect(event.expectedOwner).toBe("phase2f-implementer")
        expect(event.role).toBe("code")
        expect(event.reason).toBeDefined()
        expect(["wrong_owner", "missing_authorization"]).toContain(event.reason!)
        expect(event.sessionCorrelationID).toHaveLength(16)
        expect(event.repositoryRootHash).toHaveLength(16)
        // No raw paths, evidence, or identifiers
        const output = JSON.stringify({ events, logs: logs.mock.calls })
        expect(output).not.toContain("secret-credential")
        expect(output).not.toContain(tmp.path)
        expect(output).not.toContain(session.id)
      } finally {
        unsub()
        logs.mockRestore()
      }
    },
  })
})

test("Phase 2B: PopulateTool denies non-Phase2F without lease", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await fs.writeFile(path.join(dir, "src", "deny-empty.ts"), "")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "populate-deny",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const target = path.join(tmp.path, "src", "deny-empty.ts")
      const populate = await PopulateTool.init()
      const ctx = toolContext("code", session.id, ask, "populate-deny")
      const err = await populate
        .execute({ filePath: target, content: "should be denied" }, ctx)
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SourceOwnership.DeniedError)
      expect(
        await fs
          .access(target)
          .then(() => Bun.file(target).text())
          .catch(() => ""),
      ).toBe("")
    },
  })
})

test("Phase 2B: canonicalTarget shared between scope() and classify() produces identical results", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await fs.writeFile(path.join(dir, "src", "shared.ts"), "export const s = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Both scope() and classify() must resolve to the same kind/classification
      const scope_result = DelegatedEdit.scope({ operation: "edit", path: "src/shared.ts" })
      const classify_result = SourceOwnership.classify(["src/shared.ts"])
      expect(classify_result[0].kind).toBe("project")
      expect(scope_result.path).toBe(path.join("src", "shared.ts"))
      expect(scope_result.operation).toBe("edit")

      // Verify scope() uses canonicalTarget internally
      const ct = DelegatedEdit.canonicalTarget("src/shared.ts")
      expect(scope_result.path).toBe(ct.relative)
      expect(ct.kind).toBe("project")

      // External path: scope() rejects, classify() returns external
      expect(() => DelegatedEdit.scope({ operation: "edit", path: "../external.ts" })).toThrow()
      expect(SourceOwnership.classify(["../external.ts"])[0].kind).toBe("external")

      // Planning path: scope() rejects (doesn't exist in .planning), classify() returns planning kind
      expect(() => DelegatedEdit.scope({ operation: "edit", path: ".planning/nonexistent.md" })).toThrow()
      expect(SourceOwnership.classify([".planning/nonexistent.md"])[0].kind).toBe("planning")
    },
  })
})

test("Phase 2B: MultiEditTool denies non-Phase2F before any edit without reaching Permission.ask", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "a.ts"), "export const a = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { MultiEditTool } = await import("../../../src/tool/multiedit")
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "multiedit-deny",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const tool = await MultiEditTool.init()
      const ctx = toolContext("code", session.id, ask, "multiedit-deny")
      const target = path.join(tmp.path, "src", "a.ts")
      const before = await Bun.file(target).text()

      // Read first so FileTime doesn't block
      const read = await ReadTool.init()
      await read.execute({ filePath: target }, ctx)

      const err = await tool
        .execute(
          {
            filePath: target,
            edits: [{ filePath: target, oldString: "export const a = 1", newString: "export const a = 2" }],
          },
          ctx,
        )
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SourceOwnership.DeniedError)

      // No file changed
      const after = await Bun.file(target).text()
      expect(after).toBe(before)

      // SourceOwnership denial reason is correct
      expect(err).toHaveProperty("data.reason", "wrong_owner")
      expect(err).toHaveProperty("data.expectedOwner", "phase2f-implementer")
    },
  })
})

// kilocode_change — Phase 2B: MultiEdit uses one outer filePath; per-edit filePath is ignored by production.
// This test proves the first denied edit stops the sequential loop before any mutation, not that a
// later separate path is denied (MultiEdit is single-target by design).
test("Phase 2B: MultiEditTool sequential edits on one target are blocked when the first edit is denied by ToolAsk", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "src", "b.ts"), "export const b = 2\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { MultiEditTool } = await import("../../../src/tool/multiedit")
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "multiedit-partial",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const tool = await MultiEditTool.init()
      const ctx = toolContext("code", session.id, ask, "multiedit-partial")
      const targetA = path.join(tmp.path, "src", "a.ts")
      const targetB = path.join(tmp.path, "src", "b.ts")
      const beforeA = await Bun.file(targetA).text()
      const beforeB = await Bun.file(targetB).text()

      // Read files first to satisfy FileTime
      const read = await ReadTool.init()
      await read.execute({ filePath: targetA }, ctx)
      await read.execute({ filePath: targetB }, ctx)

      const err = await tool
        .execute(
          {
            filePath: targetA,
            edits: [
              { filePath: targetA, oldString: "export const a = 1", newString: "export const a = 2" },
              { filePath: targetB, oldString: "export const b = 2", newString: "export const b = 3" },
            ],
          },
          ctx,
        )
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SourceOwnership.DeniedError)

      // Neither file was modified
      const afterA = await Bun.file(targetA).text()
      expect(afterA).toBe(beforeA)
      const afterB = await Bun.file(targetB).text()
      expect(afterB).toBe(beforeB)
    },
  })
})

test("Phase 2B: BatchTool denies protected non-owner mutation without filesystem mutation", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "batch.ts"), "export const b = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { BatchTool } = await import("../../../src/tool/batch")
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "batch-deny",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const tool = await BatchTool.init()
      const ctx = toolContext("code", session.id, ask, "batch-deny")
      const target = path.join(tmp.path, "src", "batch.ts")
      const before = await Bun.file(target).text()

      // Read first to satisfy FileTime
      const read = await ReadTool.init()
      await read.execute({ filePath: target }, ctx)

      const result = await tool.execute(
        {
          tool_calls: [
            {
              tool: "edit",
              parameters: { filePath: target, oldString: "export const b = 1", newString: "export const b = 2" },
            },
          ],
        },
        ctx,
      )
      const details = result.metadata?.details as Array<{ tool: string; success: boolean }>
      expect(details[0].success).toBe(false)

      // No filesystem mutation occurred
      const after = await Bun.file(target).text()
      expect(after).toBe(before)
    },
  })
})

// kilocode_change — Phase 2B: Batch uses Promise.all and is not transactionally atomic.
// Independent non-mutating parts may complete even when a sibling mutation part is denied.
// This test proves the denied edit part is rejected with zero target mutation, while the
// independent read part is allowed to complete — matching production non-atomicity.
test("Phase 2B: BatchTool mixed edit+read batch leaves denied protected target unchanged while independent read may complete", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "keep.ts"), "export const k = 1\n")
      await Bun.write(path.join(dir, "src", "change.ts"), "export const c = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { BatchTool } = await import("../../../src/tool/batch")
      const session = await Session.create({})
      const ask = ToolAsk.build({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "batch-mixed",
        agentID: "code",
        role: allow,
        agent: allow,
        session: [],
      }).ask
      const tool = await BatchTool.init()
      const ctx = toolContext("code", session.id, ask, "batch-mixed")
      const targetChange = path.join(tmp.path, "src", "change.ts")
      const targetKeep = path.join(tmp.path, "src", "keep.ts")
      const beforeChange = await Bun.file(targetChange).text()
      const beforeKeep = await Bun.file(targetKeep).text()

      // Read files to satisfy FileTime
      const read = await ReadTool.init()
      await read.execute({ filePath: targetChange }, ctx)
      await read.execute({ filePath: targetKeep }, ctx)

      const result = await tool.execute(
        {
          tool_calls: [
            {
              tool: "edit",
              parameters: { filePath: targetChange, oldString: "export const c = 1", newString: "export const c = 2" },
            },
            { tool: "read", parameters: { filePath: targetKeep } },
          ],
        },
        ctx,
      )
      const details = result.metadata?.details as Array<{ tool: string; success: boolean }>
      // Edit is denied
      expect(details[0].success).toBe(false)
      // Read should succeed since it's non-edit permission
      expect(details[1].success).toBe(true)

      // Protected file unchanged
      const afterChange = await Bun.file(targetChange).text()
      expect(afterChange).toBe(beforeChange)
      const afterKeep = await Bun.file(targetKeep).text()
      expect(afterKeep).toBe(beforeKeep)
    },
  })
})

// kilocode_change — Phase 2B: force telemetry failure (Bus.publish rejects)
// recordDenied() ends with `.catch(() => undefined)`, so a Bus.publish rejection
// must never alter the synchronous SourceOwnership.DeniedError thrown by tool-ask.
// Log.create() builds a fresh logger instance per call, so the only stable hook
// for a forced failure is the module-level Bus.publish singleton.
test("Phase 2B: telemetry failure never changes SourceOwnership denial outcome even when Bus.publish rejects", async () => {
  process.env.KILO_EXPERIMENTAL_SOURCE_OWNERSHIP_ENFORCEMENT = "1"
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "src"), { recursive: true })
      await Bun.write(path.join(dir, "src", "tel.ts"), "export const t = 1\n")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      // Force Bus.publish to reject — recordDenied must swallow this internally.
      const busSpy = spyOn(Bus, "publish").mockImplementation(() => Promise.reject(new Error("BUS_DOWN")))
      try {
        const ask = ToolAsk.build({
          sessionID: session.id,
          messageID: MessageID.ascending(),
          callID: "telemetry-fail",
          agentID: "code",
          role: allow,
          agent: allow,
          session: [],
        }).ask

        // Denial still happens even though telemetry (Bus.publish) rejects inside recordDenied.
        const err1 = await ask({
          permission: "edit",
          patterns: ["src/tel.ts"],
          always: [],
          metadata: {},
        }).catch((e: unknown) => e)
        expect(err1).toBeInstanceOf(SourceOwnership.DeniedError)
        expect(err1).toHaveProperty("data.reason", "wrong_owner")

        // Second attempt also denies — no sticky state from the failed telemetry.
        const err2 = await ask({
          permission: "edit",
          patterns: ["src/tel.ts"],
          always: [],
          metadata: {},
        }).catch((e: unknown) => e)
        expect(err2).toBeInstanceOf(SourceOwnership.DeniedError)
        expect(err2).toHaveProperty("data.reason", "wrong_owner")

        // Bus.publish spy was invoked by recordDenied's telemetry chain.
        expect(busSpy).toHaveBeenCalled()
      } finally {
        busSpy.mockRestore()
      }
    },
  })
})

// kilocode_change end
