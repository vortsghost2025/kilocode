import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import stripAnsi from "strip-ansi"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { SessionTerminal } from "../../src/kilocode/shared-terminal/session"
import { sharedTerminalRuntime } from "../../src/kilocode/shared-terminal/runtime"
import { TerminalTool } from "../../src/kilocode/shared-terminal/tool"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  TerminalTool.resetForTest()
  await resetDatabase()
})

const wait = async (check: () => boolean, timeout = 10_000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for terminal output")
    await Bun.sleep(25)
  }
}

async function project<T>(fn: (dir: string) => Promise<T>) {
  await using tmp = await tmpdir({ git: true })
  return await Instance.provide({
    directory: tmp.path,
    init: InstanceBootstrap,
    fn: async () => {
      try {
        return await fn(tmp.path)
      } finally {
        await Instance.dispose()
      }
    },
  })
}

function input(sessionID: string, dir: string) {
  return {
    sessionID,
    projectID: Instance.project.id,
    directory: dir,
    worktree: Instance.worktree ?? dir,
    actor: { type: "human" as const, clientID: "panel-test" },
    title: "test-terminal",
    cols: 80,
    rows: 24,
  }
}

function capture() {
  const decoder = new TextDecoder()
  const state = { text: "", events: [] as string[] }
  return {
    state,
    callbacks: {
      onFrame(frame: import("../../src/kilocode/shared-terminal/service").SharedTerminalService.SubscriberFrame) {
        state.text += decoder.decode(frame.bytes, { stream: true })
      },
      onEvent(event: import("../../src/kilocode/shared-terminal/service").SharedTerminalService.ServiceEvent) {
        state.events.push(event.type)
      },
      onError(error: unknown) {
        throw error
      },
    },
  }
}

function context(sessionID: SessionID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make(Identifier.ascending("message")),
    agent: "orchestrator",
    abort: new AbortController().signal,
    callID: "terminal-test",
    messages: [],
    metadata() {},
    async ask() {},
  }
}

describe("session shared terminal controller", () => {
  test("creates only one active terminal per session", async () => {
    await project(async (dir) => {
      const first = await SessionTerminal.ensure(input("session-one", dir))
      const second = await SessionTerminal.ensure(input("session-one", dir))
      expect(second.terminalID).toBe(first.terminalID)
      expect(second.generation).toBe(first.generation)
      expect(
        sharedTerminalRuntime()
          .svc.list()
          .filter((item) => item.lifecycle === "running"),
      ).toHaveLength(1)
    })
  })

  test("panel detach preserves the PTY", async () => {
    await project(async (dir) => {
      const output = capture()
      const terminal = await SessionTerminal.open({
        ...input("session-detach", dir),
        cursor: 0,
        callbacks: output.callbacks,
      })
      await SessionTerminal.detach("session-detach")
      expect(SessionTerminal.current("session-detach")?.terminalID).toBe(terminal.terminalID)
      expect(sharedTerminalRuntime().svc.info(terminal.terminalID)?.lifecycle).toBe("running")
    })
  })

  test("panel reopens with the same terminal ID and generation", async () => {
    await project(async (dir) => {
      const output = capture()
      const first = await SessionTerminal.open({
        ...input("session-reopen", dir),
        cursor: 0,
        callbacks: output.callbacks,
      })
      await SessionTerminal.detach("session-reopen")
      const second = await SessionTerminal.open({
        ...input("session-reopen", dir),
        cursor: 0,
        callbacks: output.callbacks,
      })
      expect(second.terminalID).toBe(first.terminalID)
      expect(second.generation).toBe(first.generation)
    })
  })

  test("panel input reaches the real PTY and output returns to the panel", async () => {
    await project(async (dir) => {
      const output = capture()
      await SessionTerminal.open({ ...input("session-io", dir), cursor: 0, callbacks: output.callbacks })
      await SessionTerminal.write("session-io", "echo HUMAN_SHARED_TERMINAL_OK\r")
      await wait(() => stripAnsi(output.state.text).includes("HUMAN_SHARED_TERMINAL_OK"))
      expect(stripAnsi(output.state.text)).toContain("HUMAN_SHARED_TERMINAL_OK")
    })
  })

  test("preferred shell Backspace edits the line and Enter submits it", async () => {
    await project(async (dir) => {
      const output = capture()
      await SessionTerminal.open({ ...input("session-edit", dir), cursor: 0, callbacks: output.callbacks })
      await SessionTerminal.write("session-edit", "echo BACKSPACE_OKX")
      await SessionTerminal.write("session-edit", "\x7f")
      await SessionTerminal.write("session-edit", "\r")
      const result = () => stripAnsi(output.state.text).replaceAll("\r", "")
      await wait(() => result().includes("\nBACKSPACE_OK"))
      expect(result()).toContain("\nBACKSPACE_OK")
      expect(result()).not.toContain("\nBACKSPACE_OKX")
    })
  })

  test("panel resize reaches the exact PTY", async () => {
    await project(async (dir) => {
      const output = capture()
      const terminal = await SessionTerminal.open({
        ...input("session-resize", dir),
        cursor: 0,
        callbacks: output.callbacks,
      })
      const resized = await SessionTerminal.resize("session-resize", 132, 43)
      expect(resized.terminalID).toBe(terminal.terminalID)
      expect(sharedTerminalRuntime().svc.info(terminal.terminalID)).toMatchObject({ cols: 132, rows: 43 })
    })
  })

  test("explicit terminate removes the session terminal", async () => {
    await project(async (dir) => {
      const terminal = await SessionTerminal.ensure(input("session-terminate", dir))
      await SessionTerminal.terminate("session-terminate")
      expect(SessionTerminal.current("session-terminate")).toBeUndefined()
      expect(sharedTerminalRuntime().svc.info(terminal.terminalID)?.lifecycle).toBe("terminated")
    })
  })

  test("different sessions cannot access each other's terminal", async () => {
    await project(async (dir) => {
      const first = await SessionTerminal.ensure(input("session-a", dir))
      const second = await SessionTerminal.ensure(input("session-b", dir))
      expect(second.terminalID).not.toBe(first.terminalID)
      expect(first.info.access.sessions).toEqual(["session-a"])
      expect(second.info.access.sessions).toEqual(["session-b"])
    })
  })

  test("session deletion disposes its terminal", async () => {
    await project(async (dir) => {
      const session = await Session.create(undefined)
      const terminal = await SessionTerminal.ensure(input(session.id, dir))
      await Session.remove(session.id)
      await wait(() => SessionTerminal.current(session.id) === undefined)
      await wait(() => sharedTerminalRuntime().svc.info(terminal.terminalID)?.lifecycle === "terminated")
      expect(sharedTerminalRuntime().svc.info(terminal.terminalID)?.lifecycle).toBe("terminated")
    })
  })

  test("consecutive bang commands preserve shell working directory", async () => {
    await project(async (dir) => {
      const nested = path.join(dir, "terminal-state-dir")
      await mkdir(nested)
      const output = capture()
      const first = await SessionTerminal.open({
        ...input("session-state", dir),
        cursor: 0,
        callbacks: output.callbacks,
      })
      await SessionTerminal.write("session-state", `cd "${nested.replaceAll("\\", "/")}"\r`)
      await SessionTerminal.write("session-state", `node -e "console.log(process.cwd())"\r`)
      await wait(() => stripAnsi(output.state.text).replaceAll("\\", "/").includes(nested.replaceAll("\\", "/")))
      expect(SessionTerminal.current("session-state")?.terminalID).toBe(first.terminalID)
      expect(stripAnsi(output.state.text).replaceAll("\\", "/")).toContain(nested.replaceAll("\\", "/"))
    })
  })

  test("TerminalTool and panel share one terminal ID, generation, and output stream", async () => {
    await project(async (dir) => {
      const sessionID = SessionID.make(Identifier.ascending("session"))
      const output = capture()
      const panel = await SessionTerminal.open({ ...input(sessionID, dir), cursor: 0, callbacks: output.callbacks })
      await SessionTerminal.write(sessionID, "echo HUMAN_SHARED_TERMINAL_OK\r")
      await wait(() => stripAnsi(output.state.text).includes("HUMAN_SHARED_TERMINAL_OK"))
      await wait(() =>
        sharedTerminalRuntime().svc.readAgent(panel.terminalID, { from: 0 }).text.includes("HUMAN_SHARED_TERMINAL_OK"),
      )
      expect(sharedTerminalRuntime().svc.readAgent(panel.terminalID, { from: 0 }).text).toContain(
        "HUMAN_SHARED_TERMINAL_OK",
      )

      const tool = await TerminalTool.init()
      const ctx = context(sessionID)
      const created = JSON.parse((await tool.execute({ action: "create" }, ctx)).output) as {
        terminalID: string
        generation: number
      }
      expect(created.terminalID).toBe(panel.terminalID)
      expect(created.generation).toBe(panel.generation)

      const read = JSON.parse(
        (await tool.execute({ action: "read", terminal_id: panel.terminalID, cursor: 0 }, ctx)).output,
      ) as { text: string }
      expect(read.text).toContain("HUMAN_SHARED_TERMINAL_OK")

      const lease = JSON.parse(
        (await tool.execute({ action: "lease", terminal_id: panel.terminalID }, ctx)).output,
      ) as {
        leaseID: string
        revision: number
      }
      const written = JSON.parse(
        (
          await tool.execute(
            {
              action: "write",
              terminal_id: panel.terminalID,
              lease_id: lease.leaseID,
              revision: lease.revision,
              data: "echo AGENT_SHARED_TERMINAL_OK\r",
            },
            ctx,
          )
        ).output,
      ) as { revision: number }
      await wait(() => stripAnsi(output.state.text).includes("AGENT_SHARED_TERMINAL_OK"))
      expect(stripAnsi(output.state.text)).toContain("AGENT_SHARED_TERMINAL_OK")
      await tool.execute(
        {
          action: "release",
          terminal_id: panel.terminalID,
          lease_id: lease.leaseID,
          revision: written.revision,
        },
        ctx,
      )
      const reacquired = JSON.parse(
        (await tool.execute({ action: "lease", terminal_id: panel.terminalID }, ctx)).output,
      ) as { leaseID: string }
      expect(reacquired.leaseID).not.toBe(lease.leaseID)
      expect(
        sharedTerminalRuntime()
          .svc.list()
          .filter((item) => item.lifecycle === "running"),
      ).toHaveLength(1)
    })
  })
})
