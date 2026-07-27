import { SharedTerminalSchema as S } from "./schema"

// Pure ticket issuing and consuming for the Kilo-only shared-terminal service.
// Randomness and clock are injected for deterministic tests. The raw ticket
// value is returned once from issue() and never retained in any map, object,
// closure, log payload, or serialized result; only its SHA-256 digest lives in
// state. The ticket map is keyed globally by digest — one digest corresponds to
// exactly one retained ticket regardless of scope.
//
// Lifetime digest uniqueness: every successfully issued digest is added to a
// private tombstone set that lives for the entire TicketState instance.
// prune() removes expired ticket metadata but NEVER removes a digest tombstone,
// so the same raw ticket can never be issued twice in one TicketState — not
// across modes, terminals, projects, generations, or after prune().
//
// Every public transition validates its full input shape before touching
// internal state. consume() validates `now` before mutating any retained
// record and commits `usedAt` through a fail-closed candidate-then-validate
// sequence: it constructs a new record, sets `usedAt`, validates the candidate
// through Ticket.zod, and only then replaces the retained entry. The object
// already in the map is never mutated before validation succeeds.

type Mode = "read" | "write"

export interface TicketOptions {
  random?: () => Uint8Array
}

export interface IssueInput {
  terminalID: string
  generation: number
  projectID: string
  mode: Mode
  now: number
}

export interface IssueResult {
  raw: string
  digest: string
}

export interface ConsumeInput {
  raw: string
  terminalID: string
  generation: number
  projectID: string
  mode: Mode
  now: number
}

export interface ConsumeResult {
  success: boolean
  error?: "ticket_invalid" | "ticket_expired" | "ticket_reused"
}

export interface ConsumeModeInput {
  raw: string
  terminalID: string
  generation: number
  projectID: string
  now: number
}

export interface ConsumeModeResult {
  success: boolean
  mode?: Mode
  error?: "ticket_invalid" | "ticket_expired" | "ticket_reused"
}

export interface InspectKey {
  digest: string
}

interface StoredTicket {
  terminalID: string
  generation: number
  projectID: string
  mode: Mode
  digest: string
  expiresAt: number
  usedAt?: number
}

// Default production random source: 32 cryptographically random bytes.
function defaultRandom(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

export class TicketState {
  private readonly random: () => Uint8Array
  private readonly tickets = new Map<string, StoredTicket>()
  // Lifetime digest tombstone. Permanently records every digest ever issued in
  // this TicketState. prune() may drop ticket metadata but never a tombstone,
  // so a deterministic or defective random source can never reissue the same
  // raw ticket after the original has been expired and pruned.
  private readonly seenDigests = new Set<string>()

  constructor(opts: TicketOptions = {}) {
    this.random = opts.random ?? defaultRandom
  }

  issue(input: IssueInput): IssueResult {
    validateTicketInput(input.terminalID, input.generation, input.projectID, input.now)
    validateMode(input.mode)

    const bytes = this.random()
    if (bytes.length !== 32) {
      throw S.SharedTerminalError.create("ticket_invalid", {
        message: "random source must produce exactly 32 bytes",
      })
    }
    const raw = base64url(bytes)
    const digest = sha256hex(raw)

    // One digest may correspond to exactly one retained ticket across the
    // entire lifetime of this TicketState. A digest present in the active map
    // OR in the lifetime tombstone set fails closed and never overwrites the
    // existing record, resets usedAt, changes expiry/scope, or mutates the
    // tombstone beyond the already-recorded original digest.
    if (this.tickets.has(digest) || this.seenDigests.has(digest)) {
      throw S.SharedTerminalError.create("ticket_invalid", {
        message: "ticket digest collision — refusing to reissue a lifetime digest",
      })
    }

    const expiresAt = input.now + S.LIMITS.TICKET_TTL_MS
    if (expiresAt > Number.MAX_SAFE_INTEGER) {
      throw S.SharedTerminalError.create("offset_overflow", {
        message: "expiresAt would exceed safe integer range",
      })
    }
    const ticket: StoredTicket = {
      terminalID: input.terminalID,
      generation: input.generation,
      projectID: input.projectID,
      mode: input.mode,
      digest,
      expiresAt,
    }
    const parsed = S.Ticket.zod.safeParse(ticket)
    if (!parsed.success) {
      throw S.SharedTerminalError.create("ticket_invalid", {
        message: "constructed ticket failed schema validation",
      })
    }
    this.tickets.set(digest, ticket)
    this.seenDigests.add(digest)
    return { raw, digest }
  }

  inspect(k: InspectKey): StoredTicket | undefined {
    // Malformed digest input must fail deterministically rather than silently
    // treating a typo as "not found". A digest is exactly 64 lowercase hex.
    if (!isValidDigest(k.digest)) return undefined
    const t = this.tickets.get(k.digest)
    return t ? { ...t } : undefined
  }

  // Additive mode-agnostic consume used by the shared-terminal WebSocket
  // route. Unlike consume(), the caller does not supply a mode: this method
  // validates terminal/generation/project scope only and returns the stored
  // mode alongside success. The same fail-closed candidate-validate-commit
  // discipline as consume() is preserved, and consume() is left unchanged for
  // ST-02 compatibility. Synchronous and await-free, so two concurrent
  // callers cannot interleave between the usedAt guard and the write.
  consumeMode(input: ConsumeModeInput): ConsumeModeResult {
    try {
      validateTicketInput(input.terminalID, input.generation, input.projectID, input.now)
    } catch {
      return { success: false, error: "ticket_invalid" }
    }
    if (!isValidTicket(input.raw)) {
      return { success: false, error: "ticket_invalid" }
    }
    const digest = sha256hex(input.raw)
    const t = this.tickets.get(digest)
    if (
      !t ||
      t.projectID !== input.projectID ||
      t.terminalID !== input.terminalID ||
      t.generation !== input.generation
    ) {
      return { success: false, error: "ticket_invalid" }
    }
    if (input.now >= t.expiresAt) {
      return { success: false, error: "ticket_expired" }
    }
    if (t.usedAt !== undefined) {
      return { success: false, error: "ticket_reused" }
    }
    const candidate: StoredTicket = { ...t, usedAt: input.now }
    const parsed = S.Ticket.zod.safeParse(candidate)
    if (!parsed.success) {
      return { success: false, error: "ticket_invalid" }
    }
    this.tickets.set(digest, candidate)
    return { success: true, mode: t.mode }
  }

  consume(input: ConsumeInput): ConsumeResult {
    // Validate every input field before touching retained state. The validate
    // helper throws a SharedTerminalError (ticket_invalid), but consume() must
    // return { success: false, error: "ticket_invalid" } — so we translate.
    try {
      validateTicketInput(input.terminalID, input.generation, input.projectID, input.now)
      validateMode(input.mode)
    } catch {
      return { success: false, error: "ticket_invalid" }
    }
    // Validate syntax before hashing. base64url, no padding, decodes to 32 bytes.
    if (!isValidTicket(input.raw)) {
      return { success: false, error: "ticket_invalid" }
    }
    const digest = sha256hex(input.raw)
    const t = this.tickets.get(digest)
    // Unknown ticket or scope/mode mismatch -> ticket_invalid. We deliberately
    // do not distinguish "unknown" from "wrong scope" to avoid leaking which
    // dimension failed.
    if (
      !t ||
      t.projectID !== input.projectID ||
      t.terminalID !== input.terminalID ||
      t.generation !== input.generation ||
      t.mode !== input.mode
    ) {
      return { success: false, error: "ticket_invalid" }
    }
    // Expiry takes precedence over reuse: at now >= expiresAt the ticket is
    // expired regardless of whether it was previously consumed.
    if (input.now >= t.expiresAt) {
      return { success: false, error: "ticket_expired" }
    }
    if (t.usedAt !== undefined) {
      return { success: false, error: "ticket_reused" }
    }
    // Fail-closed commit: construct a new candidate, set usedAt, validate
    // through Ticket.zod, and only then replace the retained entry. Never
    // mutate the object already in the map before validation succeeds.
    const candidate: StoredTicket = { ...t, usedAt: input.now }
    const parsed = S.Ticket.zod.safeParse(candidate)
    if (!parsed.success) {
      return { success: false, error: "ticket_invalid" }
    }
    this.tickets.set(digest, candidate)
    return { success: true }
  }

  prune(now: number): number {
    validateNow(now)
    let removed = 0
    for (const [digest, t] of this.tickets) {
      if (now >= t.expiresAt) {
        this.tickets.delete(digest)
        removed += 1
      }
    }
    // Tombstones are intentionally never removed: a consumed+expired+pruned
    // ticket can never be reissued in the same TicketState.
    return removed
  }

  serialize(): StoredTicket[] {
    const out: StoredTicket[] = []
    for (const t of this.tickets.values()) {
      out.push({ ...t })
    }
    return out
  }
}

// base64url encoding without padding.
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

// Synchronous SHA-256 lowercase hex digest.
function sha256hex(input: string): string {
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(new TextEncoder().encode(input))
  return Buffer.from(hash.digest()).toString("hex")
}

// A valid ticket is base64url with no padding that decodes to exactly 32 bytes.
function isValidTicket(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("=")) return false
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return false
  let decoded: Uint8Array
  try {
    decoded = new Uint8Array(Buffer.from(raw, "base64url"))
  } catch {
    return false
  }
  return decoded.length === 32
}

// A valid ticket digest is exactly 64 lowercase hex chars (SHA-256).
function isValidDigest(digest: unknown): boolean {
  return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)
}

function validateMode(mode: unknown): void {
  if (mode !== "read" && mode !== "write") {
    throw S.SharedTerminalError.create("ticket_invalid", {
      message: "mode must be 'read' or 'write'",
    })
  }
}

function validateNow(now: number): void {
  // Reject NaN, Infinity, negative, fractional, and overflow. A shared helper
  // (no terminalID context) so consume()/prune() can route the same error code
  // deterministically without carrying terminal metadata.
  if (
    typeof now !== "number" ||
    !Number.isFinite(now) ||
    !Number.isInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER
  ) {
    throw S.SharedTerminalError.create("ticket_invalid", {
      message: "now must be a non-negative safe integer",
    })
  }
}

function validateTicketInput(terminalID: string, generation: number, projectID: string, now: number): void {
  if (!terminalID || terminalID.length < 1) {
    throw S.SharedTerminalError.create("ticket_invalid", {
      message: "terminalID must be a non-empty string",
    })
  }
  if (
    typeof generation !== "number" ||
    !Number.isFinite(generation) ||
    !Number.isInteger(generation) ||
    generation < 0 ||
    generation > Number.MAX_SAFE_INTEGER
  ) {
    throw S.SharedTerminalError.create("ticket_invalid", {
      message: "generation must be a non-negative safe integer",
    })
  }
  if (!projectID || projectID.length < 1) {
    throw S.SharedTerminalError.create("ticket_invalid", {
      message: "projectID must be a non-empty string",
    })
  }
  validateNow(now)
}
