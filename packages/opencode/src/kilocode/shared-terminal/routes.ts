// kilocode_change start
// ST-06Q2: shared-terminal WebSocket route with origin validation, subprotocol
// parsing, ticket consumption on the service-owned attach seam, and
// callbacks-driven connection lifecycle. The upgradeWebSocket factory validates
// origin and subprotocol before the upgrade; onOpen wires ticket consumption,
// service attachment, and message forwarding.
// kilocode_change end

import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { upgradeWebSocket } from "hono/bun"
import { ListenerPolicy } from "../../server/listener-policy"
import type { SharedTerminalService } from "./service"

const PROTOCOL_TOKEN = "kilo.shared-terminal.v1"
const TICKET_PREFIX = "ticket."

interface RawSocket {
  readyState: number
  bufferedAmount: number
  send: (data: string | Uint8Array | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
}

const OPEN = 1

export function isRawSocket(value: unknown): value is RawSocket {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return typeof v.readyState === "number" && typeof v.send === "function" && typeof v.close === "function"
}

export interface OriginVerdict {
  allowed: boolean
  reason?: string
}

// Fail-closed origin policy.
//
// For a loopback listener:
//   - missing Origin is allowed
//   - any syntactically valid Origin is allowed
//
// For a non-loopback listener:
//   - unavailable policy fails closed
//   - missing Origin fails closed
//   - malformed Origin fails closed
//   - Origin must exactly match allowedOrigins
//   - empty allowedOrigins denies all
export function checkOrigin(origin: string | undefined, policy: ListenerPolicy.Policy | undefined): OriginVerdict {
  if (policy && policy.loopbackOnly) {
    if (!origin) return { allowed: true }
    try {
      new URL(origin)
      return { allowed: true }
    } catch {
      return { allowed: false, reason: "malformed_origin" }
    }
  }

  if (!policy) return { allowed: false, reason: "policy_unavailable" }
  if (!origin) return { allowed: false, reason: "origin_missing" }

  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return { allowed: false, reason: "malformed_origin" }
  }

  const allowed = policy.allowedOrigins
  if (allowed.length === 0) return { allowed: false, reason: "empty_allowlist" }
  if (allowed.includes(origin)) return { allowed: true }
  return { allowed: false, reason: "origin_not_allowed" }
}

export interface SubprotocolResult {
  ok: boolean
  protocol?: string
  ticket?: string
  reason?: string
}

// Parse the Sec-WebSocket-Protocol header for exactly:
//   - kilo.shared-terminal.v1  (required, exactly once)
//   - ticket.<base64url-ticket>  (required, exactly once, no duplicates)
//
// The raw ticket is never logged, echoed, or placed in errors. Reject
// duplicates, malformed tokens, and missing values.
export function parseSubprotocol(header: string | undefined): SubprotocolResult {
  if (!header) return { ok: false, reason: "missing_protocol" }

  const tokens: string[] = []
  for (const part of header.split(",")) {
    const trimmed = part.trim()
    if (trimmed.length > 0) tokens.push(trimmed)
  }

  let protocolCount = 0
  let ticketCount = 0
  let ticketToken: string | undefined

  for (const tok of tokens) {
    if (tok === PROTOCOL_TOKEN) {
      protocolCount++
      continue
    }
    if (tok.startsWith(TICKET_PREFIX)) {
      ticketCount++
      const candidate = tok.slice(TICKET_PREFIX.length)
      if (candidate.length === 0) return { ok: false, reason: "malformed_ticket_token" }
      if (!isBase64UrlNoPad(candidate)) return { ok: false, reason: "malformed_ticket_token" }
      ticketToken = candidate
      continue
    }
    // Unknown token from a non-loopback listener is rejected.
    return { ok: false, reason: "unexpected_subprotocol_token" }
  }

  if (protocolCount !== 1) return { ok: false, reason: "protocol_count" }
  if (ticketCount !== 1) return { ok: false, reason: "ticket_count" }
  if (!ticketToken) return { ok: false, reason: "ticket_count" }

  return { ok: true, protocol: PROTOCOL_TOKEN, ticket: ticketToken }
}

function isBase64UrlNoPad(s: string): boolean {
  // base64url alphabet: A-Z a-z 0-9 - _ ; no padding (=).
  if (s.length === 0) return false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const isUpper = c >= 65 && c <= 90
    const isLower = c >= 97 && c <= 122
    const isDigit = c >= 48 && c <= 57
    const isDash = c === 45
    const isUnderscore = c === 95
    if (!isUpper && !isLower && !isDigit && !isDash && !isUnderscore) return false
  }
  return true
}

// ST-06Q2: the Hono route factory mounts a single GET route that validates
// origin and subprotocol inside the upgradeWebSocket factory (before the
// upgrade), then wires ticket consumption, service attachment, and message
// forwarding in onOpen after the WebSocket connects.
export function SharedTerminalRoutes(opts: {
  listenerPolicy: () => ListenerPolicy.Policy | undefined
  runtimeGetter?: () => unknown
}): Hono {
  return new Hono().get(
    "/:terminalID/connect",
    upgradeWebSocket(async (c) => {
      const policy = opts.listenerPolicy()
      const origin = c.req.header("origin")
      const verdict = checkOrigin(origin, policy)
      if (!verdict.allowed) throw new HTTPException(403, { message: "origin_not_allowed" })

      const sub = c.req.header("sec-websocket-protocol")
      const result = parseSubprotocol(sub)
      if (!result.ok) throw new HTTPException(400, { message: "subprotocol_invalid" })

      const rawRuntime = opts.runtimeGetter?.()
      if (!rawRuntime) throw new HTTPException(503, { message: "runtime_unavailable" })

      const rt = rawRuntime as { svc: SharedTerminalService.Instance }
      const terminalID = c.req.param("terminalID")!

      let attachment: SharedTerminalService.Attachment | null = null
      let ready = false
      let closed = false
      // kilocode_change start — capture ws+raw in closure scope so onMessage
      // can close the connection (e.g. for pty.detach).
      let wsRef: { close: () => void } | null = null
      // kilocode_change end
      const pending: string[] = []
      // kilocode_change start — pending resize arrived before attachment, or
      // before ready. Keep ONLY the most-recent requested size so the win goes
      // to the latest event the human issued (not the oldest). Applied
      // immediately after attachWithTicket succeeds.
      let pendingResize: { cols: number; rows: number } | undefined
      function applyPendingResize(): void {
        if (!attachment || pendingResize === undefined) return
        const r = pendingResize
        try {
          rt.svc.resizeAttachment(terminalID, attachment.attachmentID, r.cols, r.rows)
        } catch {}
        pendingResize = undefined
      }
      // kilocode_change end

      return {
        async onOpen(_event, ws) {
          // kilocode_change start — expose ws to onMessage for graceful
          // pty.detach close.
          wsRef = ws as unknown as { close: () => void }
          // kilocode_change end
          const raw = ws.raw
          if (!isRawSocket(raw)) {
            ws.close()
            return
          }

          const info = rt.svc.info(terminalID)
          if (!info) {
            raw.close(4004, "terminal_not_found")
            return
          }

          try {
            const att = await rt.svc.attachWithTicket(terminalID, {
              rawTicket: result.ticket!,
              callbacks: {
                onFrame: (frame) => {
                  if (raw.readyState !== OPEN || closed) return
                  raw.send(JSON.stringify(formatFrame(frame)))
                },
                onEvent: (event) => {
                  if (raw.readyState !== OPEN || closed) return
                  raw.send(JSON.stringify(event))
                },
                onError: (err) => {
                  raw.close(4001, String(err))
                },
              },
            })
            if (closed) {
              // Connection closed while attaching — detach immediately
              await rt.svc.detach(terminalID, att.attachmentID)
              return
            }
            attachment = att
            ready = true
            // kilocode_change start — apply any resize that arrived before the
            // attachment became ready, then flush queued stdin.
            applyPendingResize()
            // kilocode_change end
            for (const msg of pending) {
              rt.svc.submitHuman(terminalID, att.attachmentID, msg, Date.now())
            }
            pending.length = 0
          } catch (err) {
            raw.close(4001, String(err))
          }
        },
        onMessage(event) {
          if (typeof event.data !== "string") return
          // kilocode_change start — typed control messages from the attach
          // client. resize and private and pty.kill are evaluated even before
          // attach completes so the latest user intent always wins.
          if (event.data.startsWith("{")) {
            try {
              const msg = JSON.parse(event.data)
              if (
                msg &&
                msg.type === "resize" &&
                typeof msg.cols === "number" &&
                typeof msg.rows === "number" &&
                Number.isFinite(msg.cols) &&
                Number.isFinite(msg.rows) &&
                msg.cols > 0 &&
                msg.rows > 0
              ) {
                pendingResize = { cols: msg.cols, rows: msg.rows }
                if (ready && attachment && !closed) applyPendingResize()
                return
              }
              if (msg && msg.type === "private" && typeof msg.active === "boolean") {
                if (ready && attachment && !closed) {
                  rt.svc
                    .setAttachmentPrivate(terminalID, attachment.attachmentID, msg.active, Date.now())
                    .catch(() => {})
                }
                return
              }
              if (msg && msg.type === "pty.kill") {
                if (ready && attachment && !closed) {
                  const info = rt.svc.info(terminalID)
                  if (info) {
                    rt.svc
                      .terminate(terminalID, {
                        terminalID,
                        generation: attachment.generation,
                        rootPID: info.pid,
                        platform: process.platform as Parameters<typeof rt.svc.terminate>[1]["platform"],
                      })
                      .catch(() => {})
                  }
                }
                return
              }
              if (msg && msg.type === "pty.detach") {
                // Close the attachment without terminating the PTY. The local
                // user exits the visible window; the PTY keeps running for
                // any future attach.
                try {
                  wsRef?.close()
                } catch {}
                return
              }
            } catch {}
          }
          // kilocode_change end
          if (!ready) {
            pending.push(event.data)
            return
          }
          if (attachment && !closed) {
            rt.svc.submitHuman(terminalID, attachment.attachmentID, event.data, Date.now())
          }
        },
        onClose() {
          closed = true
          if (attachment) {
            rt.svc.detach(terminalID, attachment.attachmentID)
            attachment = null
          }
        },
        onError() {
          closed = true
          if (attachment) {
            rt.svc.detach(terminalID, attachment.attachmentID)
            attachment = null
          }
        },
      }
    }),
  )
}

// Serializes a SubscriberFrame for WebSocket delivery. Called from onOpen's
// attachWithTicket onFrame callback.
export function formatFrame(frame: unknown): Record<string, unknown> {
  const f = frame as Record<string, unknown>
  return {
    type: "output",
    from: f.from,
    next: f.next,
    end: f.end,
    bytes: Buffer.from(f.bytes as Uint8Array).toString("base64"),
    replay: f.replay,
    gap: f.gap,
    gapStart: f.gapStart,
    gapEnd: f.gapEnd,
    truncated: f.truncated,
    retainedStart: f.retainedStart,
    privateBytes: f.privateBytes,
  }
}

export { OPEN as READY_OPEN }
