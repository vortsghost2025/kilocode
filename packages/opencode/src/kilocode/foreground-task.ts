// kilocode_change - new file
import type { ProjectID } from "@/project/schema"
import type { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"

export namespace ForegroundTask {
  export const TIMEOUT_MS = 5 * 60 * 1000

  export interface Handle {
    interrupt(): void
    complete?(message: MessageV2.WithParts): void
    timeout?(): void
  }

  interface Entry {
    token: symbol
    handle: Handle
    timeout: number
    timer?: ReturnType<typeof setTimeout>
  }

  export type Listener = (active: boolean) => void

  const entries = new Map<ProjectID, Map<SessionID, Entry>>()
  const listeners = new Map<ProjectID, Map<SessionID, Set<Listener>>>()

  function tasks(projectID: ProjectID, create = false) {
    const current = entries.get(projectID)
    if (current || !create) return current
    const next = new Map<SessionID, Entry>()
    entries.set(projectID, next)
    return next
  }

  function watches(projectID: ProjectID, create = false) {
    const current = listeners.get(projectID)
    if (current || !create) return current
    const next = new Map<SessionID, Set<Listener>>()
    listeners.set(projectID, next)
    return next
  }

  function notify(projectID: ProjectID, sessionID: SessionID) {
    const set = watches(projectID)?.get(sessionID)
    if (!set) return
    const active = tasks(projectID)?.has(sessionID) ?? false
    for (const listener of [...set]) listener(active)
  }

  function clear(entry: Entry) {
    if (!entry.timer) return
    clearTimeout(entry.timer)
    entry.timer = undefined
  }

  function remove(projectID: ProjectID, sessionID: SessionID, entry: Entry) {
    const bucket = tasks(projectID)
    if (!bucket) return false
    const current = bucket.get(sessionID)
    if (current?.token !== entry.token) return false
    clear(entry)
    bucket.delete(sessionID)
    if (bucket.size === 0) entries.delete(projectID)
    notify(projectID, sessionID)
    return true
  }

  function arm(projectID: ProjectID, sessionID: SessionID, entry: Entry) {
    clear(entry)
    if (entry.timeout <= 0) return
    entry.timer = setTimeout(() => timeout(projectID, sessionID), entry.timeout)
    entry.timer.unref?.()
  }

  export function register(
    projectID: ProjectID,
    sessionID: SessionID,
    handle: Handle,
    options?: { timeoutMs?: number },
  ) {
    const bucket = tasks(projectID, true)!
    if (bucket.has(sessionID)) {
      throw new Error(`Foreground task already registered for session ${sessionID}`)
    }

    const entry: Entry = {
      token: Symbol(sessionID),
      handle,
      timeout: options?.timeoutMs ?? TIMEOUT_MS,
    }

    bucket.set(sessionID, entry)
    arm(projectID, sessionID, entry)
    notify(projectID, sessionID)

    return () => {
      remove(projectID, sessionID, entry)
    }
  }

  export function touch(projectID: ProjectID, sessionID: SessionID) {
    const entry = tasks(projectID)?.get(sessionID)
    if (!entry) return false
    arm(projectID, sessionID, entry)
    return true
  }

  export function complete(projectID: ProjectID, sessionID: SessionID, message: MessageV2.WithParts) {
    const entry = tasks(projectID)?.get(sessionID)
    if (!entry) return false
    if (!remove(projectID, sessionID, entry)) return false
    entry.handle.complete?.(message)
    return true
  }

  export function timeout(projectID: ProjectID, sessionID: SessionID) {
    const entry = tasks(projectID)?.get(sessionID)
    if (!entry) return false
    if (!remove(projectID, sessionID, entry)) return false
    if (entry.handle.timeout) entry.handle.timeout()
    else entry.handle.interrupt()
    return true
  }

  export function interrupt(projectID: ProjectID, sessionID: SessionID) {
    const entry = tasks(projectID)?.get(sessionID)
    if (!entry) return false
    if (!remove(projectID, sessionID, entry)) return false
    entry.handle.interrupt()
    return true
  }

  export function subscribe(projectID: ProjectID, sessionID: SessionID, listener: Listener) {
    const bucket = watches(projectID, true)!
    const set = bucket.get(sessionID) ?? new Set<Listener>()
    bucket.set(sessionID, set)
    set.add(listener)
    listener(tasks(projectID)?.has(sessionID) ?? false)

    const subscription = { done: false }

    return () => {
      if (subscription.done) return
      subscription.done = true
      set.delete(listener)
      if (set.size > 0) return
      bucket.delete(sessionID)
      if (bucket.size === 0) listeners.delete(projectID)
    }
  }

  export function has(projectID: ProjectID, sessionID: SessionID) {
    return tasks(projectID)?.has(sessionID) ?? false
  }
}
