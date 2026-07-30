import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import type { Event } from "@kilocode/sdk/v2"
import { Flag } from "@/flag/flag"
import { setTimeout as sleep } from "node:timers/promises"
import { writeHeapSnapshot } from "node:v8"
import { WorkspaceID } from "@/control-plane/schema"
import { sharedTerminalRuntime } from "@/kilocode/shared-terminal/runtime" // kilocode_change
import { Session } from "@/session" // kilocode_change
import { ListenerPolicy } from "@/server/listener-policy" // kilocode_change
import { Filesystem } from "@/util/filesystem" // kilocode_change
import { SessionTerminal } from "@/kilocode/shared-terminal/session" // kilocode_change
import type { TuiTerminalEvent, TuiTerminalInfo } from "@/kilocode/shared-terminal/tui" // kilocode_change
import { SharedTerminalDebug } from "@/kilocode/shared-terminal/debug" // kilocode_change

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined
interface SharedTerminalServer {
  stop: () => void
  port: number
  url: string
  releasePolicy: () => boolean
} // kilocode_change
let sharedTerminalServer: SharedTerminalServer | undefined // kilocode_change
let sharedTerminalPolicyToken: number | undefined // kilocode_change

const eventStream = {
  abort: undefined as AbortController | undefined,
}

const startEventStream = (input: { directory: string; workspaceID?: string }) => {
  if (eventStream.abort) eventStream.abort.abort()
  const abort = new AbortController()
  eventStream.abort = abort
  const signal = abort.signal

  ;(async () => {
    while (!signal.aborted) {
      const shouldReconnect = await Instance.provide({
        directory: input.directory,
        init: InstanceBootstrap,
        fn: () =>
          new Promise<boolean>((resolve) => {
            Rpc.emit("event", {
              type: "server.connected",
              properties: {},
            } satisfies Event)

            let settled = false
            const settle = (value: boolean) => {
              if (settled) return
              settled = true
              signal.removeEventListener("abort", onAbort)
              unsub()
              resolve(value)
            }

            const unsub = Bus.subscribeAll((event) => {
              Rpc.emit("event", event as Event)
              if (event.type === Bus.InstanceDisposed.type) {
                settle(true)
              }
            })

            const onAbort = () => {
              settle(false)
            }

            signal.addEventListener("abort", onAbort, { once: true })
          }),
      }).catch((error) => {
        Log.Default.error("event stream subscribe error", {
          error: error instanceof Error ? error.message : error,
        })
        return false
      })

      if (!shouldReconnect || signal.aborted) {
        break
      }

      if (!signal.aborted) {
        await sleep(250)
      }
    }
  })().catch((error) => {
    Log.Default.error("event stream error", {
      error: error instanceof Error ? error.message : error,
    })
  })
}

startEventStream({ directory: process.cwd() })

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = getAuthorizationHeader()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await Instance.provide({
      directory: input.directory,
      init: InstanceBootstrap,
      fn: async () => {
        await upgrade().catch(() => {})
      },
    })
  },
  async reload() {
    await Config.invalidate(true)
  },
  async setWorkspace(input: { workspaceID?: string }) {
    startEventStream({ directory: process.cwd(), workspaceID: input.workspaceID })
  },
  // kilocode_change start
  async sharedTerminalOpen(input: { sessionID: string; directory: string }) {
    // Architectural note (Gap 3): In TUI internal mode the worker does NOT
    // bind an active loopback listener; the TUI thread reaches the server
    // via Server.Default().fetch over an in-process RPC. There is no live
    // WebSocket-capable HTTP server to reuse. We therefore lazily bind one
    // here, sharing Server.Default()'s Hono app so the SharedTerminalRoutes
    // resolve the exact same per-Instance runtime the TUI itself uses.
    //
    // The launch is idempotent: a second call reuses the existing binding.
    // ListenerPolicy is published only after a successful bind; shutdown
    // releases only the policy this binding published.
    return Instance.provide({
      directory: Filesystem.resolve(process.cwd()),
      init: InstanceBootstrap,
      fn: async () => {
        const session = await Session.get(input.sessionID as Parameters<typeof Session.get>[0]).catch(() => undefined)
        if (!session) {
          throw new Error(`shared-terminal: session not found: ${input.sessionID}`)
        }
        const projectID = Instance.project.id
        const directory = Instance.directory
        // kilocode_change - validate session belongs to active project and
        // that the supplied directory matches the session's stored directory.
        if (session.projectID !== projectID) {
          throw new Error("shared-terminal: session belongs to a different project")
        }
        if (input.directory && session.directory !== Filesystem.resolve(input.directory)) {
          throw new Error("shared-terminal: supplied directory does not match session directory")
        }
        const resolvedDirectory = session.directory
        const worktree = Instance.worktree ?? resolvedDirectory

        const runtime = sharedTerminalRuntime()
        const result = await SessionTerminal.ensure({
          sessionID: input.sessionID,
          projectID,
          directory: resolvedDirectory,
          worktree,
          actor: { type: "human", clientID: "shared-terminal-window" },
          title: "shared-terminal",
          cols: 120,
          rows: 40,
        })

        // kilocode_change - the visible shared-terminal window is the FIRST
        // human attachment and MUST own keyboard input. Issue a write-mode
        // ticket.
        const ticket = runtime.tickets.issue({
          terminalID: result.info.id,
          generation: result.info.generation,
          projectID,
          mode: "write",
          now: Date.now(),
        })

        if (!sharedTerminalServer) {
          const { websocket } = await import("hono/bun")
          const s = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            idleTimeout: 0,
            fetch: Server.Default().fetch,
            websocket,
          })
          const p = s.port
          if (!p) {
            // kilocode_change - bind failed: dispose the just-created PTY and
            // throw so the caller can revoke the ticket on its side.
            await runtime.svc.disposeTerminal(result.info.id).catch(() => {})
            throw new Error("shared-terminal server failed to bind a port")
          }
          const policyToken = ListenerPolicy.setFromServerConfig("127.0.0.1", [])
          sharedTerminalPolicyToken = policyToken
          sharedTerminalServer = {
            stop: () => s.stop(true),
            port: p,
            url: `http://127.0.0.1:${p}`,
            releasePolicy: () => ListenerPolicy.release(policyToken),
          }
        }

        const out = {
          url: sharedTerminalServer!.url,
          terminalID: result.info.id,
          generation: result.info.generation,
          ticket: ticket.raw,
          cols: result.info.cols,
          rows: result.info.rows,
          worktree,
          directory: resolvedDirectory,
        }
        return out
      },
    })
  },
  // kilocode_change end
  // kilocode_change start - integrated shared-terminal panel RPC
  async sharedTerminalPanelOpen(input: {
    sessionID: string
    directory: string
    cursor: number
    cols: number
    rows: number
  }) {
    SharedTerminalDebug.trace("worker_open_rpc_received")
    return Instance.provide({
      directory: Filesystem.resolve(process.cwd()),
      init: InstanceBootstrap,
      fn: async () => {
        const session = await Session.get(input.sessionID as Parameters<typeof Session.get>[0]).catch(() => undefined)
        if (!session) throw new Error(`shared-terminal: session not found: ${input.sessionID}`)
        if (session.projectID !== Instance.project.id)
          throw new Error("shared-terminal: session belongs to another project")
        if (session.directory !== Filesystem.resolve(input.directory)) {
          throw new Error("shared-terminal: supplied directory does not match session directory")
        }
        const base = {
          sessionID: input.sessionID,
          projectID: Instance.project.id,
          directory: Instance.directory,
          worktree: Instance.worktree ?? Instance.directory,
          actor: { type: "human" as const, clientID: "tui-terminal-panel" },
          title: "terminal",
          cols: input.cols,
          rows: input.rows,
        }
        const terminal = await SessionTerminal.ensure(base)
        const view = {
          attachmentID: "",
          pending: [] as Array<(attachmentID: string) => TuiTerminalEvent>,
        }
        const emit = (make: (attachmentID: string) => TuiTerminalEvent) => {
          if (!view.attachmentID) {
            view.pending.push(make)
            return
          }
          Rpc.emit("shared-terminal.event", make(view.attachmentID))
        }
        const opened = await SessionTerminal.open({
          ...base,
          cursor: input.cursor,
          callbacks: {
            onFrame(frame) {
              emit((attachmentID) => ({
                type: "output",
                sessionID: input.sessionID,
                terminalID: terminal.terminalID,
                generation: terminal.generation,
                attachmentID,
                data: Buffer.from(frame.bytes).toString("base64"),
                next: frame.next,
                replay: frame.replay,
              }))
            },
            onEvent(event) {
              if (event.type !== "exit" && event.type !== "cleanup") return
              emit((attachmentID) => ({
                type: "status",
                sessionID: input.sessionID,
                terminalID: terminal.terminalID,
                generation: terminal.generation,
                attachmentID,
                status: event.type === "exit" ? "exited" : event.status,
              }))
            },
            onError(error) {
              emit((attachmentID) => ({
                type: "error",
                sessionID: input.sessionID,
                terminalID: terminal.terminalID,
                generation: terminal.generation,
                attachmentID,
                message: error instanceof Error ? error.message : String(error),
              }))
            },
          },
        })
        view.attachmentID = opened.attachmentID
        setTimeout(() => {
          for (const make of view.pending.splice(0)) Rpc.emit("shared-terminal.event", make(opened.attachmentID))
        }, 0)
        const data: TuiTerminalInfo = {
          sessionID: input.sessionID,
          terminalID: opened.terminalID,
          generation: opened.generation,
          attachmentID: opened.attachmentID,
          title: opened.info.title,
          status: opened.info.lifecycle,
          cols: opened.info.cols,
          rows: opened.info.rows,
        }
        return data
      },
    }).then(
      async (result) => {
        const data = await result
        SharedTerminalDebug.trace("worker_open_rpc_result", {
          attachmentID: data.attachmentID,
          terminalID: data.terminalID,
          generation: data.generation,
          attached: true,
          status: data.status,
        })
        return { ok: true as const, data }
      },
      (error) => {
        SharedTerminalDebug.trace("worker_open_rpc_result", { errorCode: SharedTerminalDebug.errorCode(error) })
        return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
      },
    )
  },
  async sharedTerminalPanelDetach(input: { sessionID: string; attachmentID: string }) {
    return Instance.provide({
      directory: Filesystem.resolve(process.cwd()),
      init: InstanceBootstrap,
      fn: () => SessionTerminal.detach(input.sessionID, input.attachmentID),
    }).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
    )
  },
  async sharedTerminalPanelWrite(input: { sessionID: string; attachmentID: string; data: string }) {
    SharedTerminalDebug.traceSubmit("worker_rpc_received", input.data, { attachmentID: input.attachmentID })
    return Instance.provide({
      directory: Filesystem.resolve(process.cwd()),
      init: InstanceBootstrap,
      fn: async () => {
        const terminal = await SessionTerminal.write(input.sessionID, input.data, input.attachmentID)
        return {
          sessionID: input.sessionID,
          terminalID: terminal.terminalID,
          generation: terminal.generation,
          attachmentID: terminal.attachmentID,
          title: terminal.info.title,
          status: terminal.info.lifecycle,
          cols: terminal.info.cols,
          rows: terminal.info.rows,
        } satisfies TuiTerminalInfo
      },
    }).then(
      async (result) => {
        const data = await result
        SharedTerminalDebug.traceSubmit("worker_rpc_result", input.data, {
          attachmentID: data.attachmentID,
          terminalID: data.terminalID,
          generation: data.generation,
          attached: true,
          status: data.status,
        })
        return { ok: true as const, data }
      },
      (error) => {
        SharedTerminalDebug.traceSubmit("worker_rpc_result", input.data, {
          attachmentID: input.attachmentID,
          errorCode: SharedTerminalDebug.errorCode(error),
        })
        return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
      },
    )
  },
  async sharedTerminalPanelResize(input: { sessionID: string; attachmentID: string; cols: number; rows: number }) {
    return Instance.provide({
      directory: Filesystem.resolve(process.cwd()),
      init: InstanceBootstrap,
      fn: async () => {
        const terminal = await SessionTerminal.resize(input.sessionID, input.cols, input.rows, input.attachmentID)
        return {
          sessionID: input.sessionID,
          terminalID: terminal.terminalID,
          generation: terminal.generation,
          attachmentID: terminal.attachmentID,
          title: terminal.info.title,
          status: terminal.info.lifecycle,
          cols: terminal.info.cols,
          rows: terminal.info.rows,
        } satisfies TuiTerminalInfo
      },
    }).then(
      (data) => ({ ok: true as const, data }),
      (error) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
    )
  },
  async sharedTerminalPanelTerminate(input: { sessionID: string }) {
    return Instance.provide({
      directory: Filesystem.resolve(process.cwd()),
      init: InstanceBootstrap,
      fn: () => SessionTerminal.terminate(input.sessionID),
    }).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
    )
  },
  // kilocode_change end
  // kilocode_change start - cleanup RPC: terminate a visible window's
  // terminal, dispose the PTY, and leave no attachment behind.
  async sharedTerminalClose(input: { terminalID: string; generation: number }) {
    return Instance.provide({
      directory: Filesystem.resolve(process.cwd()),
      init: InstanceBootstrap,
      fn: async () => {
        const runtime = sharedTerminalRuntime()
        await runtime.svc.disposeTerminal(input.terminalID).catch(() => {})
        return { closed: true, terminalID: input.terminalID }
      },
    })
  },
  // kilocode_change end
  async shutdown() {
    Log.Default.info("worker shutting down")
    if (eventStream.abort) eventStream.abort.abort()
    await Instance.disposeAll()
    if (sharedTerminalServer) {
      // kilocode_change
      sharedTerminalServer.stop() // kilocode_change
      // kilocode_change start - release ONLY the listener policy this server
      // published. Reuses ListenerPolicy.release's fail-closed token check.
      sharedTerminalServer.releasePolicy()
      // kilocode_change end
      sharedTerminalPolicyToken = undefined // kilocode_change
      sharedTerminalServer = undefined // kilocode_change
    }
    if (server) await server.stop(true)
    // kilocode_change start - Clear the Rpc message channel so the worker's event loop can drain and
    // exit naturally. Without this, the active onmessage handle keeps the
    // worker alive even after all async work is done.
    onmessage = null
    // kilocode_change end
  },
}

Rpc.listen(rpc)

function getAuthorizationHeader(): string | undefined {
  const password = Flag.KILO_SERVER_PASSWORD
  if (!password) return undefined
  const username = Flag.KILO_SERVER_USERNAME ?? "kilo" // kilocode_change
  return `Basic ${btoa(`${username}:${password}`)}`
}
