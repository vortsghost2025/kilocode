import { SharedTerminalSchema as S } from "./schema"

// Metadata-only audit records for the Kilo-only shared-terminal service.
//
// This module is a PURE in-process value store. It does NOT register itself as
// an Effect/Layer/Service, route, command, tool, BusEvent, or any other
// runtime side effect. The shared-terminal service may inject an instance,
// but the store remains a stateful value object — no IO, no timers, no
// process.env access, no logging.
//
// What audit records ARE permitted to carry (structured metadata only):
//   * event ID, timestamp, terminalID, generation, revision
//   * actor identity (human clientID / agent sessionID+agentID+callID /
//     system reason)
//   * action name (discriminated enum)
//   * outcome (applied/rejected/failed), optional reason (AuditReason enum)
//   * byte counts, cursor spans, dimensions, process ID, exit code
//   * correlation IDs
//
// What audit records must NEVER carry:
//   * raw terminal output
//   * human keyboard input bytes
//   * agent command text
//   * tickets or ticket digests
//   * environment names or values
//   * credentials
//   * complete argv
//   * shell history
//   * PTY replay bytes
//   * arbitrary error stacks containing sensitive values
//
// The store enforces this contract structurally: every record is validated
// against S.AuditEvent.zod BEFORE any retention state is touched. A malformed
// record throws a SharedTerminalError and leaves the retained set untouched.
// Retention is a bounded FIFO with deterministic oldest-first eviction.
// Snapshots are independent shallow copies so a caller mutating a returned
// snapshot can never alter internal state or a later snapshot.

export interface AuditStoreOptions {
  // Injected monotonic clock. Required, deterministic in tests.
  clock: () => number
  // Injected deterministic event-ID source. Required so tests can assert
  // stable IDs without depending on randomness or wall time.
  id: () => string
  // Optional bounded retention. Defaults to DEFAULT_LIMIT when omitted.
  limit?: number
}

export const DEFAULT_LIMIT = 1024 as const

export type RecordInput = Omit<S.AuditEvent, "id" | "time"> &
  Partial<Pick<S.AuditEvent, "id" | "time">> & {
    // Out-of-band project scope used only for snapshot filtering. Not part of
    // the serialized AuditEvent; never carries a raw payload.
    projectID?: string
  }

export interface SnapshotFilter {
  terminalID?: string
  generation?: number
  projectID?: string
}

type StoredEvent = S.AuditEvent & { readonly projectID: string }

export class AuditStore {
  private readonly events: StoredEvent[] = []
  private readonly clock: () => number
  private readonly id: () => string
  private readonly limit: number
  // Reverse index from terminalID -> projectID so snapshot filtering by
  // project can resolve without storing projectID on the AuditEvent itself.
  // The AuditEvent schema does not carry projectID; we keep an out-of-band
  // resolution map keyed only by terminalID. This NEVER carries raw output,
  // input, ticket, or environment payload — just the bare projectID string.
  private readonly projectIndex = new Map<string, string>()

  constructor(opts: AuditStoreOptions) {
    this.clock = opts.clock
    this.id = opts.id
    const limit = opts.limit ?? DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit <= 0 || limit > Number.MAX_SAFE_INTEGER) {
      throw S.SharedTerminalError.create("terminal_missing", {
        message: "audit limit must be a positive safe integer",
      })
    }
    this.limit = limit
  }

  record(input: RecordInput): S.AuditEvent {
    // Build the candidate record. `id` and `time` may be omitted and are
    // seeded from the injected sources; explicit values take precedence so
    // callers can place a deterministic id/time if they choose.
    const id = input.id ?? this.id()
    const time = input.time ?? this.clock()

    const candidate: Record<string, unknown> = {
      id,
      terminalID: input.terminalID,
      generation: input.generation,
      revision: input.revision,
      time,
      actor: input.actor,
      action: input.action,
      outcome: input.outcome,
    }
    if (input.bytes !== undefined) candidate.bytes = input.bytes
    if (input.correlationID !== undefined) candidate.correlationID = input.correlationID
    if (input.reason !== undefined) candidate.reason = input.reason

    // The AuditEvent schema cannot be modified (protected Phase 0 file) and
    // zod's default object behavior STRIPS unknown keys rather than rejecting
    // them. The audit store is the authority on what may be persisted, so it
    // must enforce the metadata-only contract itself: reject ANY caller key
    // that is not part of the canonical AuditEvent surface. This blocks a
    // forbidden extra payload (raw output, input, ticket, env, credential,
    // argv, shell history, replay bytes, or arbitrary error stacks) from ever
    // entering the retained set.
    //
    // `projectID` is the single out-of-band key: it is NOT part of the
    // serialized AuditEvent (the schema forbids it), but the store accepts it
    // from the caller and resolves it into an out-of-band terminalID -> proj
    // map used only for snapshot filtering. It is never serialized.
    const allowed = new Set([
      "id",
      "terminalID",
      "generation",
      "revision",
      "time",
      "actor",
      "action",
      "outcome",
      "bytes",
      "correlationID",
      "reason",
      "projectID",
    ])
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        throw S.SharedTerminalError.create("terminal_missing", {
          message: `audit record rejected: unknown field '${key}' is not part of AuditEvent`,
        })
      }
    }

    // Validate the FULL shape BEFORE touching retained state. A schema failure
    // must throw and leave `events` byte-for-byte unchanged. The schema
    // rejects unknown fields (zod object is strict by default), malformed
    // enums, NaN/Infinity/negative timestamps, and non-actor objects.
    const parsed = S.AuditEvent.zod.safeParse(candidate)
    if (!parsed.success) {
      throw S.SharedTerminalError.create("terminal_missing", {
        message: `audit record rejected: ${parsed.error.message}`,
      })
    }
    const event = parsed.data as S.AuditEvent

    // Out-of-band projectID resolution for snapshot filtering. We never store
    // the projectID inside the AuditEvent (the schema forbids it), but we do
    // keep an independent terminalID -> projectID lookup that the caller
    // supplies via projectID on the input. This is bare metadata only —
    // never a raw output/input/ticket/env/credential payload.
    const projectID = input.projectID
    if (typeof projectID === "string" && projectID.length > 0) {
      // Only set the first time we see a terminal; future events for an
      // already-indexed terminal keep the original projectID (terminals do not
      // migrate between projects).
      if (!this.projectIndex.has(event.terminalID)) {
        this.projectIndex.set(event.terminalID, projectID)
      }
    }

    const stored: StoredEvent = {
      ...event,
      actor: cloneActor(event.actor),
      projectID: this.projectIndex.get(event.terminalID) ?? "",
    }

    this.events.push(stored)
    // Bounded retention with deterministic oldest-first eviction. Eviction
    // is applied AFTER the new record is appended so the new record is never
    // itself evicted when at-capacity.
    while (this.events.length > this.limit) {
      this.events.shift()
    }
    return snapshotOf(stored)
  }

  size(): number {
    return this.events.length
  }

  clear(): void {
    this.events.length = 0
    this.projectIndex.clear()
  }

  snapshot(filter?: SnapshotFilter): S.AuditEvent[] {
    if (!filter) return this.events.map((e) => snapshotOf(e))
    return this.events
      .filter((e) => {
        if (filter.terminalID !== undefined && e.terminalID !== filter.terminalID) return false
        if (filter.generation !== undefined && e.generation !== filter.generation) return false
        if (filter.projectID !== undefined && this.projectIndex.get(e.terminalID) !== filter.projectID) return false
        return true
      })
      .map((e) => snapshotOf(e))
  }

  serialize(): S.AuditEvent[] {
    return this.events.map((e) => snapshotOf(e))
  }
}

function cloneActor(a: S.Actor): S.Actor {
  switch (a.type) {
    case "human":
      return { type: "human", clientID: a.clientID }
    case "agent":
      return { type: "agent", sessionID: a.sessionID, agentID: a.agentID, callID: a.callID }
    case "system":
      return { type: "system", reason: a.reason }
  }
}

// Produce an independent shallow copy of an event for a snapshot. Optional
// fields that were undefined on the stored event are OMITTED from the copy so
// the serialized form never carries `null` or explicit-undefined payloads.
function snapshotOf(e: StoredEvent): S.AuditEvent {
  const out: S.AuditEvent = {
    id: e.id,
    terminalID: e.terminalID,
    generation: e.generation,
    revision: e.revision,
    time: e.time,
    actor: cloneActor(e.actor),
    action: e.action,
    outcome: e.outcome,
  }
  if (e.bytes !== undefined) out.bytes = e.bytes
  if (e.correlationID !== undefined) out.correlationID = e.correlationID
  if (e.reason !== undefined) out.reason = e.reason
  return out
}
