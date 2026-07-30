// Per-instance runtime state for the shared-terminal WebSocket routes.
// Uses Instance.state so init runs once per project directory and is torn
// down on instance dispose.

import { Instance } from "../../project/instance"
import { SharedTerminalService } from "./service"
import { TicketState } from "./ticket"
import { AuditStore } from "./audit"
import { TerminalObservationRouter } from "../session/observation-router"

export const sharedTerminalRuntime = Instance.state(
  () => {
    const tickets = new TicketState()
    const audit = new AuditStore({
      clock: () => Date.now(),
      id: () => crypto.randomUUID(),
      limit: 1024,
    })
    const svc = SharedTerminalService.create({
      clock: () => Date.now(),
      audit,
      tickets,
      platform: process.platform as SharedTerminalService.Platform,
      spawn: (file, args, opts) => {
        const { spawn } = require("bun-pty") as typeof import("bun-pty")
        return spawn(file, args, opts)
      },
      envSource: process.env as Record<string, string>,
      isolatedPaths: {},
      // kilocode_change - wire automatic same-session terminal visibility.
      // Finalized observations from human submissions are routed to the
      // owning session's queue. The prompt loop drains the queue on each
      // iteration.
      observationSink: TerminalObservationRouter.sink,
    })
    return { svc, tickets, audit }
  },
  async (state) => {
    for (const info of state.svc.list()) {
      await state.svc.disposeTerminal(info.id)
    }
  },
)
