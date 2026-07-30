// kilocode_change - new file
//
// Per-session router for terminal observations. Holds one
// TerminalObservation.Queue per session and routes finalized observations
// from the shared-terminal service to the owning session. The agent prompt
// loop drains the queue at the top of each iteration.
//
// Cross-session isolation: an observation carries a sessionID resolved by the
// service from the terminal's access.sessions[0]. The router enqueues ONLY
// into the queue matching that sessionID. Session B's queue never receives
// session A's observations.
//
// Storage: Instance.state, so queues live once per project directory and are
// torn down on instance dispose.

import { Instance } from "../../project/instance"
import { Bus } from "../../bus"
import { TerminalObservation } from "../shared-terminal/observation"

export namespace TerminalObservationRouter {
  const state = Instance.state(
    () => {
      const queues = new Map<string, TerminalObservation.Queue>()
      const unsub = Bus.subscribeAll((event) => {
        if (event.type !== "session.deleted") return
        queues.delete(event.properties.sessionID)
      })
      return { queues, unsub }
    },
    async (value) => {
      value.unsub()
      value.queues.clear()
    },
  )

  // Router sink handed to SharedTerminalService.create() as
  // observationSink. The service resolves sessionID from the terminal's
  // access list and calls this with the finalized observation.
  export function sink(obs: TerminalObservation.Observation): void {
    const value = state()
    let q = value.queues.get(obs.sessionID)
    if (!q) {
      q = new TerminalObservation.Queue()
      value.queues.set(obs.sessionID, q)
    }
    q.enqueue(obs)
  }

  // Drain pending observations for a session. Called by the prompt loop at
  // the top of each iteration. Returns an empty array when idle (no model
  // turn is started).
  export function drain(sessionID: string): TerminalObservation.Observation[] {
    const value = state()
    const q = value.queues.get(sessionID)
    if (!q) return []
    return q.drain()
  }

  // Pending count for a session. Used by the prompt loop to decide whether
  // there is anything to inject this iteration.
  export function pending(sessionID: string): number {
    const value = state()
    const q = value.queues.get(sessionID)
    if (!q) return 0
    return q.size()
  }

  // Forget observations for a terminal+generation (e.g. on terminal dispose
  // or generation bump). Best-effort.
  export function forget(terminalID: string, generation: number): void {
    const value = state()
    for (const q of value.queues.values()) {
      q.forget(terminalID, generation)
    }
  }
}
