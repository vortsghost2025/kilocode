import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { Hono } from "hono"
import { websocket } from "hono/bun"
import { SharedTerminalRoutes } from "../../src/kilocode/shared-terminal/routes"
import { ListenerPolicy } from "../../src/server/listener-policy"
import { sharedTerminalRuntime } from "../../src/kilocode/shared-terminal/runtime"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { tmpdir } from "../fixture/fixture"

const isWin = process.platform === "win32"
const WIN_CMD = process.env.ComSpec || "cmd.exe"
const POSIX_SHELL = process.env.SHELL || "sh"

interface Scope {
  projectID: string
  directory: string
  worktree: string
}

const agentActor: Extract<import("../../src/kilocode/shared-terminal/schema").Actor, { type: "agent" }> = {
  type: "agent",
  sessionID: "sess-ws",
  agentID: "ag-ws",
  callID: "call-ws",
}

let tmp: Awaited<ReturnType<typeof tmpdir>> | null = null
let server: ReturnType<typeof Bun.serve> | null = null
let baseUrl = ""
let testTerminalID = ""
let testScope: Scope | null = null

let rt: {
  svc: import("../../src/kilocode/shared-terminal/service").SharedTerminalService.Instance
  tickets: import("../../src/kilocode/shared-terminal/ticket").TicketState
} | null = null

function makeFakeSpawn(): {
  fn: import("../../src/kilocode/shared-terminal/service").SharedTerminalService.SpawnFn
  onData: (chunk: string) => void
} {
  const cbs: Array<(chunk: string) => void> = []
  return {
    fn: (_file, _args, _opts) => {
      const p = { pid: 9999, cols: 80, rows: 24, process: "test" } as import("bun-pty").IPty
      return {
        ...p,
        onData: (cb) => {
          cbs.push(cb)
          return { dispose: () => {} }
        },
        onExit: () => ({ dispose: () => {} }),
        write: () => {},
        resize: () => {},
        kill: () => {},
      }
    },
    onData: (chunk: string) => {
      for (const cb of cbs) cb(chunk)
    },
  }
}

describe("ST-06Q2: Real Bun WebSocket Integration Tests", () => {
  beforeAll(async () => {
    tmp = await tmpdir({ git: true })
    testScope = { projectID: "proj-ws-test", directory: tmp.path, worktree: tmp.path }

    ListenerPolicy.setFromServerConfig("localhost")

    await Instance.provide({
      directory: testScope.directory,
      init: InstanceBootstrap,
      fn: async () => {
        const runtime = sharedTerminalRuntime()
        rt = runtime
        const sh = isWin
          ? { file: WIN_CMD, args: ["/c", "echo KILO_MARKER && ping -n 60 127.0.0.1"] }
          : { file: POSIX_SHELL, args: ["-c", "printf 'KILO_MARKER\\n'; sleep 60"] }
        const result = await runtime.svc.create({
          file: sh.file,
          args: sh.args,
          scope: testScope!,
          createdBy: agentActor,
          title: "ws-test",
          cols: 80,
          rows: 24,
        })
        testTerminalID = result.info.id
      },
    })

    const routes = SharedTerminalRoutes({
      listenerPolicy: ListenerPolicy.current,
      runtimeGetter: () => rt,
    })
    const app = new Hono()
    app.route("/shared-terminal", routes)

    server = Bun.serve({
      port: 0,
      fetch: app.fetch,
      websocket,
    })
    baseUrl = `http://localhost:${server.port}`
  })

  afterAll(async () => {
    if (testTerminalID && rt) {
      try {
        await rt.svc.disposeTerminal(testTerminalID)
      } catch {}
    }
    if (server) {
      server.stop()
      server = null
    }
    if (tmp) {
      await tmp[Symbol.asyncDispose]()
      tmp = null
    }
  })

  // ── Test 1: Negotiated protocol + real upgrade ──────────────────────
  test("real WebSocket upgrade with negotiated protocol kilo.shared-terminal.v1", async () => {
    const terminalID = testTerminalID
    const ticket = rt!.tickets.issue({
      terminalID,
      generation: rt!.svc.info(terminalID)!.generation,
      projectID: rt!.svc.info(terminalID)!.scope.projectID,
      mode: "read",
      now: Date.now(),
    })

    const ws = await connectWs(makeWsUrl(`/shared-terminal/${terminalID}/connect`), [
      "kilo.shared-terminal.v1",
      `ticket.${ticket.raw}`,
    ])

    try {
      expect(ws.protocol).toBe("kilo.shared-terminal.v1")

      const msg = await waitForMessage(ws)
      const data = JSON.parse(msg.data as string)
      expect(data.type).toBe("output")
    } finally {
      ws.close()
      await waitForClose(ws)
    }
  })

  // ── Test 2: Close-during-attach ─────────────────────────────────────
  test("close-during-attach: socket closes while attachWithTicket pending -> detached, no leak, no frames after close", async () => {
    const AuditStore = (await import("../../src/kilocode/shared-terminal/audit")).AuditStore
    const Service = (await import("../../src/kilocode/shared-terminal/service")).SharedTerminalService
    const TicketState = (await import("../../src/kilocode/shared-terminal/ticket")).TicketState

    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-cda", limit: 128 })
    const tickets = new TicketState()
    const gate = Promise.withResolvers<void>()

    const fake = makeFakeSpawn()

    let svc: import("../../src/kilocode/shared-terminal/service").SharedTerminalService.Instance
    let attachSuccesses = 0
    let detachCalls: string[] = []
    const inspect: { attachmentCount?: (terminalID: string) => number } = {}

    await Instance.provide({
      directory: testScope!.directory,
      init: InstanceBootstrap,
      fn: async () => {
        svc = Service.create({
          clock: ctl.now,
          audit,
          tickets,
          platform:
            process.platform as import("../../src/kilocode/shared-terminal/service").SharedTerminalService.Platform,
          spawn: fake.fn,
          envSource: {},
          isolatedPaths: {},
          _attachHook: { beforeAttach: () => gate.promise },
          _inspectHook: inspect,
        })

        const origAttach = svc.attachWithTicket.bind(svc)
        svc.attachWithTicket = async (id: string, input: any) => {
          const att = await origAttach(id, input)
          attachSuccesses++
          return att
        }
        const origDetach = svc.detach.bind(svc)
        svc.detach = async (id: string, attachmentID: string) => {
          detachCalls.push(attachmentID)
          return origDetach(id, attachmentID)
        }
      },
    })

    const scope = testScope!
    const result = await Instance.provide({
      directory: scope.directory,
      fn: async () => {
        return svc.create({
          file: "sh",
          args: ["-c", "sleep 60"],
          scope,
          createdBy: agentActor,
          title: "cda-test",
          cols: 80,
          rows: 24,
        })
      },
    })
    const terminalID = result.info.id

    fake.onData("PRE_ATTACH\n")

    const ticket = tickets.issue({
      terminalID,
      generation: result.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })

    const cdaRoutes = SharedTerminalRoutes({
      listenerPolicy: ListenerPolicy.current,
      runtimeGetter: () => ({ svc, tickets }),
    })
    const cdaApp = new Hono()
    cdaApp.route("/shared-terminal", cdaRoutes)
    const cdaServer = Bun.serve({ port: 0, fetch: cdaApp.fetch, websocket })
    const cdaUrl = `http://localhost:${cdaServer.port}`

    try {
      // (1) Connect — upgrade succeeds, attachWithTicket blocks on gate
      const ws = await connectWs(cdaUrl.replace("http", "ws") + `/shared-terminal/${terminalID}/connect`, [
        "kilo.shared-terminal.v1",
        `ticket.${ticket.raw}`,
      ])

      // Install frame observer BEFORE close — counts every message received
      let framesReceived = 0
      ws.onmessage = () => {
        framesReceived++
      }

      // (2) Close while attachWithTicket is still pending
      ws.close()
      const closeEv = await waitForClose(ws)
      expect(closeEv.code).toBe(1000)
      expect(framesReceived).toBe(0)

      // (3) Emit PTY output while attach is still pending (subscriber not registered yet)
      fake.onData("frame_while_pending\n")
      await new Promise((r) => setTimeout(r, 50))
      expect(framesReceived).toBe(0)

      // (4) Release the gate — attachWithTicket completes, onOpen sees closed=true,
      //     calls svc.detach, returns without keeping the attachment
      gate.resolve()
      await new Promise((r) => setTimeout(r, 200))

      // (5) Proven: detach was called exactly once
      expect(detachCalls.length).toBe(1)

      // (6) Proven: exactly one attachWithTicket call happened
      expect(attachSuccesses).toBe(1)

      // (7) Proven: zero attachments remain in the actual service registry
      expect(inspect.attachmentCount!(terminalID)).toBe(0)

      // (8) Emit output after attach resolution — closed socket must not receive it
      fake.onData("frame_after_attach_resolved\n")
      await new Promise((r) => setTimeout(r, 50))
      expect(framesReceived).toBe(0)

      // (9) Emit output after detach completion
      fake.onData("frame_after_detach\n")
      await new Promise((r) => setTimeout(r, 50))
      expect(framesReceived).toBe(0)

      // (10) Issue fresh ticket and reconnect — proves clean state
      const ticket2 = tickets.issue({
        terminalID,
        generation: result.ref.generation,
        projectID: scope.projectID,
        mode: "read",
        now: ctl.now(),
      })
      const ws2 = await connectWs(cdaUrl.replace("http", "ws") + `/shared-terminal/${terminalID}/connect`, [
        "kilo.shared-terminal.v1",
        `ticket.${ticket2.raw}`,
      ])
      try {
        expect(ws2.protocol).toBe("kilo.shared-terminal.v1")
        fake.onData("RECONNECT_DATA\n")
        const msg = await waitForMessage(ws2)
        const data = JSON.parse(msg.data as string)
        expect(data.type).toBe("output")
      } finally {
        ws2.close()
        await waitForClose(ws2)
      }
    } finally {
      cdaServer.stop()
      await Instance.provide({
        directory: scope.directory,
        fn: async () => {
          await svc.disposeTerminal(terminalID)
        },
      })
    }
  })

  // ── Test 3: Same-ticket simultaneous WS race ────────────────────────
  test("simultaneous same-ticket connection race: exactly one attaches, loser rejected", async () => {
    const Service = (await import("../../src/kilocode/shared-terminal/service")).SharedTerminalService
    const AuditStore = (await import("../../src/kilocode/shared-terminal/audit")).AuditStore
    const TicketState = (await import("../../src/kilocode/shared-terminal/ticket")).TicketState

    const ctl = clock()
    const audit = new AuditStore({ clock: ctl.now, id: () => "evt-race", limit: 128 })
    const tickets = new TicketState()

    const fake = makeFakeSpawn()

    let svc: import("../../src/kilocode/shared-terminal/service").SharedTerminalService.Instance
    let attachSuccesses = 0
    const inspect: { attachmentCount?: (terminalID: string) => number } = {}

    await Instance.provide({
      directory: testScope!.directory,
      init: InstanceBootstrap,
      fn: async () => {
        svc = Service.create({
          clock: ctl.now,
          audit,
          tickets,
          platform:
            process.platform as import("../../src/kilocode/shared-terminal/service").SharedTerminalService.Platform,
          spawn: fake.fn,
          envSource: {},
          isolatedPaths: {},
          _inspectHook: inspect,
        })
        const origAttach = svc.attachWithTicket.bind(svc)
        svc.attachWithTicket = async (id: string, input: any) => {
          const att = await origAttach(id, input)
          attachSuccesses++
          return att
        }
      },
    })

    const scope = testScope!
    const result = await Instance.provide({
      directory: scope.directory,
      fn: async () => {
        return svc.create({
          file: "sh",
          args: ["-c", "sleep 60"],
          scope,
          createdBy: agentActor,
          title: "race-test",
          cols: 80,
          rows: 24,
        })
      },
    })
    const terminalID = result.info.id

    fake.onData("RACE_PREAMBLE\n")

    const ticket = tickets.issue({
      terminalID,
      generation: result.ref.generation,
      projectID: scope.projectID,
      mode: "read",
      now: ctl.now(),
    })

    const raceRoutes = SharedTerminalRoutes({
      listenerPolicy: ListenerPolicy.current,
      runtimeGetter: () => ({ svc, tickets }),
    })
    const raceApp = new Hono()
    raceApp.route("/shared-terminal", raceRoutes)
    const raceServer = Bun.serve({ port: 0, fetch: raceApp.fetch, websocket })
    const raceUrl = `http://localhost:${raceServer.port}`

    try {
      const [ws1, ws2] = await Promise.all([
        connectWs(raceUrl.replace("http", "ws") + `/shared-terminal/${terminalID}/connect`, [
          "kilo.shared-terminal.v1",
          `ticket.${ticket.raw}`,
        ]),
        connectWs(raceUrl.replace("http", "ws") + `/shared-terminal/${terminalID}/connect`, [
          "kilo.shared-terminal.v1",
          `ticket.${ticket.raw}`,
        ]),
      ])

      // Capture close codes and reasons early — server closes loser during onOpen,
      // before the async waitForMessage below yields control back
      let ws1CloseCode = 0
      let ws1CloseReason = ""
      let ws2CloseCode = 0
      let ws2CloseReason = ""
      ws1.addEventListener("close", (ev) => {
        ws1CloseCode = ev.code
        ws1CloseReason = ev.reason
      })
      ws2.addEventListener("close", (ev) => {
        ws2CloseCode = ev.code
        ws2CloseReason = ev.reason
      })

      fake.onData("RACE_DATA\n")

      const results = await Promise.all([
        waitForMessage(ws1, 10000)
          .then((m) => [m, 1] as const)
          .catch(() => [null, 1] as const),
        waitForMessage(ws2, 10000)
          .then((m) => [m, 2] as const)
          .catch(() => [null, 2] as const),
      ])
      const msg1 = results[0][0]
      const msg2 = results[1][0]

      const winnerMsg = msg1 ?? msg2
      const isWs1Winner = msg1 !== null
      const loserSocket = isWs1Winner ? ws2 : ws1
      const winnerSocket = isWs1Winner ? ws1 : ws2
      const loserCloseCode = isWs1Winner ? ws2CloseCode : ws1CloseCode
      const loserCloseReason = isWs1Winner ? ws2CloseReason : ws1CloseReason

      // (1) Proven: exactly one of the two race attachWithTicket calls succeeded
      expect(attachSuccesses).toBe(1)

      // (2) Proven: actual service registry has exactly one attachment from the race
      expect(inspect.attachmentCount!(terminalID)).toBe(1)

      // (3) Proven: winner receives frames
      expect(winnerMsg).not.toBeNull()
      const winnerData = JSON.parse(winnerMsg!.data as string)
      expect(winnerData.type).toBe("output")

      // (4) Proven: loser closed with exact code 4001 (ticket_reused).
      // The reason is String(err) from the route's catch block, where err is a
      // SharedTerminalError("ticket_reused") with message "ticket already consumed".
      expect(loserCloseCode).toBe(4001)
      expect(loserCloseReason).toBe("SharedTerminalError: ticket already consumed")

      // (5) Close the winner and prove zero attachments remain
      // Use addEventListener (not onclose) to avoid conflicts with early close
      // listeners already registered for code/reason capture
      const winnerCloseDone = new Promise<void>((resolve) => {
        winnerSocket.addEventListener("close", () => resolve(), { once: true })
      })
      winnerSocket.close()
      await winnerCloseDone
      // Allow the server's enqueued detach work to complete (microtask chain)
      await new Promise((r) => setTimeout(r, 50))
      expect(inspect.attachmentCount!(terminalID)).toBe(0)

      // (6) Proven: fresh-ticket reconnect works (no stale leaked state)
      const ticket2 = tickets.issue({
        terminalID,
        generation: result.ref.generation,
        projectID: scope.projectID,
        mode: "read",
        now: ctl.now(),
      })
      const ws3 = await connectWs(raceUrl.replace("http", "ws") + `/shared-terminal/${terminalID}/connect`, [
        "kilo.shared-terminal.v1",
        `ticket.${ticket2.raw}`,
      ])
      try {
        expect(ws3.protocol).toBe("kilo.shared-terminal.v1")
        fake.onData("RENEW_DATA\n")
        const msg3 = await waitForMessage(ws3)
        expect(msg3).not.toBeNull()
      } finally {
        ws3.close()
        await waitForClose(ws3)
      }

      // (7) Proven: three total attachWithTicket calls: race winner + ws3
      // (the loser never succeeded)
      expect(attachSuccesses).toBe(2)

      // Cleanup loser socket if still open
      if (loserSocket.readyState === WebSocket.OPEN) {
        loserSocket.close()
        await waitForClose(loserSocket).catch(() => {})
      }
    } finally {
      raceServer.stop()
      await Instance.provide({
        directory: scope.directory,
        fn: async () => {
          await svc.disposeTerminal(terminalID)
        },
      })
    }
  })
})

// ── Helpers ──────────────────────────────────────────────────────────

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function makeWsUrl(path: string): string {
  return baseUrl.replace("http", "ws") + path
}

async function connectWs(url: string, protocols?: string | string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols)
    ws.binaryType = "arraybuffer"
    ws.onopen = () => resolve(ws)
    ws.onerror = (err) => reject(err)
  })
}

function waitForMessage(ws: WebSocket, timeout = 5000): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for message")), timeout)
    ws.onmessage = (event) => {
      clearTimeout(timer)
      resolve(event)
    }
  })
}

function waitForClose(ws: WebSocket, timeout = 5000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for close")), timeout)
    ws.onclose = (event) => {
      clearTimeout(timer)
      resolve(event)
    }
  })
}
