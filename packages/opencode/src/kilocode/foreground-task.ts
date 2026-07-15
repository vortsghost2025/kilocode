// kilocode_change - new file
import type { SessionID } from "@/session/schema"

export namespace ForegroundTask {
  export interface Handle {
    interrupt(): void
  }

  interface Entry {
    token: symbol
    handle: Handle
  }

  export type Listener = (active: boolean) => void

  const entries = new Map<SessionID, Entry>()
  const listeners = new Map<SessionID, Set<Listener>>()

  function notify(sessionID: SessionID) {
    const set = listeners.get(sessionID)
    if (!set) return
    const active = entries.has(sessionID)
    for (const listener of [...set]) listener(active)
  }

  export function register(sessionID: SessionID, handle: Handle) {
    if (entries.has(sessionID)) {
      throw new Error(`Foreground task already registered for session ${sessionID}`)
    }

    const entry: Entry = {
      token: Symbol(sessionID),
      handle,
    }

    entries.set(sessionID, entry)
    notify(sessionID)

    return () => {
      const current = entries.get(sessionID)
      if (current?.token !== entry.token) return
      entries.delete(sessionID)
      notify(sessionID)
    }
  }

  export function interrupt(sessionID: SessionID) {
    const entry = entries.get(sessionID)
    if (!entry) return false

    // Delete the exact entry before invoking user code.
    // A resumed task using the same task_id may register a new entry while
    // the previous child Promise is still finishing.
    entries.delete(sessionID)
    notify(sessionID)
    entry.handle.interrupt()
    return true
  }

  export function subscribe(sessionID: SessionID, listener: Listener) {
    const set = listeners.get(sessionID) ?? new Set<Listener>()
    listeners.set(sessionID, set)
    set.add(listener)
    listener(entries.has(sessionID))
    const state = { done: false }

    return () => {
      if (state.done) return
      state.done = true
      set.delete(listener)
      if (set.size === 0) listeners.delete(sessionID)
    }
  }

  export function has(sessionID: SessionID) {
    return entries.has(sessionID)
  }
}
