import type { PermissionRequest } from "@kilocode/sdk/v2"

// kilocode_change — session-scoped in-memory auto-approve state
// Defaults OFF for every new process. Not persisted. Not tied to Config.

interface SessionState {
  enabled: boolean
  inFlight: Set<string>
}

const sessions = new Map<string, SessionState>()

function getOrCreate(sessionID: string): SessionState {
  let s = sessions.get(sessionID)
  if (!s) {
    s = { enabled: false, inFlight: new Set() }
    sessions.set(sessionID, s)
  }
  return s
}

export function isEnabled(sessionID: string): boolean {
  return getOrCreate(sessionID).enabled
}

export function toggle(sessionID: string): boolean {
  const s = getOrCreate(sessionID)
  s.enabled = !s.enabled
  return s.enabled
}

export function setEnabled(sessionID: string, value: boolean): void {
  getOrCreate(sessionID).enabled = value
}

export function tryAcquire(sessionID: string, requestID: string): boolean {
  const s = getOrCreate(sessionID)
  if (!s.enabled) return false
  if (s.inFlight.has(requestID)) return false
  s.inFlight.add(requestID)
  return true
}

export function release(sessionID: string, requestID: string): void {
  const s = sessions.get(sessionID)
  if (s) s.inFlight.delete(requestID)
}

export function pendingCount(sessionID: string): number {
  const s = sessions.get(sessionID)
  return s ? s.inFlight.size : 0
}

export function enabledSessionIDs(): string[] {
  const result: string[] = []
  for (const [id, s] of sessions) {
    if (s.enabled) result.push(id)
  }
  return result
}

export function reset(): void {
  sessions.clear()
}

export function autoApproveRequest(
  sessionID: string,
  request: PermissionRequest,
  reply: (input: { reply: string; requestID: string }) => Promise<unknown>,
): { handled: boolean; promise: Promise<void> } {
  if (!tryAcquire(sessionID, request.id)) {
    return { handled: false, promise: Promise.resolve() }
  }
  const promise = reply({ reply: "once", requestID: request.id })
    .then(() => {
      release(sessionID, request.id)
    })
    .catch((err) => {
      release(sessionID, request.id)
      throw err
    })
  return { handled: true, promise }
}
