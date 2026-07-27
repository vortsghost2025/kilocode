import { SharedTerminalSchema as S } from "./schema"

// Pure deterministic lease state for the Kilo-only shared-terminal service.
// No timers, background jobs, IO, or Date.now(). All time is injected.
// A lease grants exclusive agent input authority for one terminal+generation
// to one exact agent actor, tracked by a monotonically increasing revision.
// The actor is deep-cloned before storage and on every return so external
// mutation can never alter internal identity.
//
// Every public transition validates its full input shape before touching
// internal state. Runtime callers are not guaranteed to obey TypeScript types,
// so invalid actor shapes, negative/fractional/NaN timestamps, unsafe integers,
// and empty IDs all fail deterministically with a structured error code rather
// than a TypeError. No rejection may mutate lease state, clear an active lease,
// increment revision, or create/revoke a lease.

type AgentActor = Extract<S.Actor, { type: "agent" }>

export interface AcquireInput {
  terminalID: string
  generation: number
  actor: AgentActor
  now: number
}

export interface RefreshInput {
  terminalID: string
  generation: number
  leaseID: string
  actor: AgentActor
  revision: number
  now: number
}

export interface ValidateInput {
  terminalID: string
  generation: number
  leaseID: string
  actor: AgentActor
  revision: number
  now: number
}

export interface ReleaseInput {
  terminalID: string
  generation: number
  leaseID: string
  actor: AgentActor
  revision: number
}

export interface PreemptResult {
  revoked: boolean
  leaseID?: string
}

export class LeaseState {
  private lease: S.Lease | undefined
  private privateMode = false
  private counter = 0

  inspect(): S.Lease | undefined {
    return this.lease ? cloneLease(this.lease) : undefined
  }

  setPrivateMode(on: boolean): PreemptResult {
    this.privateMode = on
    // Entering private mode immediately revokes an active agent lease. Leaving
    // private mode does not restore it. No transition ever creates a lease.
    if (on && this.lease) {
      const id = this.lease.id
      this.lease = undefined
      return { revoked: true, leaseID: id }
    }
    return { revoked: false }
  }

  isPrivateMode(): boolean {
    return this.privateMode
  }

  acquire(input: AcquireInput): S.Lease {
    if (this.privateMode) {
      throw S.SharedTerminalError.create("private_mode", {
        message: "cannot acquire lease while private mode is active",
        terminalID: input.terminalID,
      })
    }
    validateLeaseInput(input.terminalID, input.generation, input.now)
    validateActor(input.actor, input.terminalID)
    if (this.lease && this.isActive(this.lease, input.now)) {
      throw S.SharedTerminalError.create("lease_missing", {
        message: "an active lease already exists",
        terminalID: input.terminalID,
      })
    }
    const maxAt = input.now + S.LIMITS.LEASE_MAX_MS
    if (maxAt > Number.MAX_SAFE_INTEGER) {
      throw S.SharedTerminalError.create("offset_overflow", {
        message: "maxAt would exceed safe integer range",
        terminalID: input.terminalID,
      })
    }
    const expiresAt = Math.min(input.now + S.LIMITS.LEASE_IDLE_MS, maxAt)
    const lease: S.Lease = {
      id: this.newID(),
      terminalID: input.terminalID,
      generation: input.generation,
      actor: cloneActor(input.actor),
      revision: 0,
      acquiredAt: input.now,
      expiresAt,
      maxAt,
    }
    const parsed = S.Lease.zod.safeParse(lease)
    if (!parsed.success) {
      throw S.SharedTerminalError.create("terminal_missing", {
        message: "constructed lease failed schema validation",
        terminalID: input.terminalID,
      })
    }
    this.lease = lease
    return cloneLease(lease)
  }

  refresh(input: RefreshInput): S.Lease {
    if (this.privateMode) {
      throw S.SharedTerminalError.create("private_mode", {
        message: "cannot refresh lease while private mode is active",
        terminalID: input.terminalID,
      })
    }
    validateLeaseInput(input.terminalID, input.generation, input.now)
    validateRevision(input.revision, input.terminalID)
    validateLeaseID(input.leaseID, input.terminalID)
    validateActor(input.actor, input.terminalID)
    const current = this.match(input.terminalID, input.generation, input.leaseID, input.actor)
    if (current.revision !== input.revision) {
      throw S.SharedTerminalError.create("lease_stale", {
        message: "stale revision",
        terminalID: input.terminalID,
      })
    }
    if (!this.isActive(current, input.now)) {
      throw S.SharedTerminalError.create("lease_expired", {
        message: "lease expired before refresh",
        terminalID: input.terminalID,
      })
    }
    const expiresAt = Math.min(input.now + S.LIMITS.LEASE_IDLE_MS, current.maxAt)
    const refreshed: S.Lease = {
      ...current,
      actor: cloneActor(current.actor),
      revision: current.revision + 1,
      expiresAt,
    }
    const parsed = S.Lease.zod.safeParse(refreshed)
    if (!parsed.success) {
      throw S.SharedTerminalError.create("terminal_missing", {
        message: "refreshed lease failed schema validation",
        terminalID: input.terminalID,
      })
    }
    this.lease = refreshed
    return cloneLease(refreshed)
  }

  validate(input: ValidateInput): void {
    // Private mode blocks all agent input authority, including validation.
    if (this.privateMode) {
      throw S.SharedTerminalError.create("private_mode", {
        message: "cannot validate lease while private mode is active",
        terminalID: input.terminalID,
      })
    }
    validateLeaseInput(input.terminalID, input.generation, input.now)
    validateRevision(input.revision, input.terminalID)
    validateLeaseID(input.leaseID, input.terminalID)
    validateActor(input.actor, input.terminalID)
    const current = this.match(input.terminalID, input.generation, input.leaseID, input.actor)
    if (current.revision !== input.revision) {
      throw S.SharedTerminalError.create("lease_stale", {
        message: "stale revision",
        terminalID: input.terminalID,
      })
    }
    if (!this.isActive(current, input.now)) {
      throw S.SharedTerminalError.create("lease_expired", {
        message: "lease expired",
        terminalID: input.terminalID,
      })
    }
  }

  release(input: ReleaseInput): void {
    validateLeaseInput(input.terminalID, input.generation, 0)
    validateRevision(input.revision, input.terminalID)
    validateLeaseID(input.leaseID, input.terminalID)
    validateActor(input.actor, input.terminalID)
    const current = this.match(input.terminalID, input.generation, input.leaseID, input.actor)
    if (current.revision !== input.revision) {
      throw S.SharedTerminalError.create("lease_stale", {
        message: "stale revision on release",
        terminalID: input.terminalID,
      })
    }
    this.lease = undefined
  }

  checkTimeout(now: number): void {
    validateNow(now, "<timeout>")
    if (this.lease && !this.isActive(this.lease, now)) {
      this.lease = undefined
    }
  }

  humanPreempt(): PreemptResult {
    if (!this.lease) return { revoked: false }
    const id = this.lease.id
    this.lease = undefined
    return { revoked: true, leaseID: id }
  }

  private isActive(lease: S.Lease, now: number): boolean {
    return now < lease.expiresAt && now < lease.maxAt
  }

  private match(terminalID: string, generation: number, leaseID: string, actor: AgentActor): S.Lease {
    if (!this.lease) {
      throw S.SharedTerminalError.create("lease_missing", {
        message: "no active lease",
        terminalID,
      })
    }
    const l = this.lease
    if (l.id !== leaseID || l.terminalID !== terminalID || l.generation !== generation) {
      throw S.SharedTerminalError.create("lease_missing", {
        message: "lease does not match terminal/generation/id",
        terminalID,
      })
    }
    if (!sameActor(l.actor, actor)) {
      throw S.SharedTerminalError.create("lease_missing", {
        message: "lease does not match actor",
        terminalID,
      })
    }
    return l
  }

  private newID(): string {
    this.counter += 1
    return `lease-${this.counter}`
  }
}

function sameActor(a: AgentActor, b: AgentActor): boolean {
  return a.type === b.type && a.sessionID === b.sessionID && a.agentID === b.agentID && a.callID === b.callID
}

function cloneActor(a: AgentActor): AgentActor {
  return { type: a.type, sessionID: a.sessionID, agentID: a.agentID, callID: a.callID }
}

function cloneLease(l: S.Lease): S.Lease {
  return { ...l, actor: cloneActor(l.actor) }
}

// Validate the non-actor scalar fields of a lease transition. `now` is
// required for acquire/refresh/validate; release passes 0 as a placeholder
// since it carries no timestamp (the 0 is still a safe non-negative integer).
function validateLeaseInput(terminalID: string, generation: number, now: number): void {
  if (!terminalID || terminalID.length < 1) {
    throw S.SharedTerminalError.create("terminal_missing", {
      message: "terminalID must be a non-empty string",
      terminalID,
    })
  }
  if (!Number.isInteger(generation) || generation < 0 || generation > Number.MAX_SAFE_INTEGER) {
    throw S.SharedTerminalError.create("terminal_missing", {
      message: "generation must be a non-negative safe integer",
      terminalID,
    })
  }
  validateNow(now, terminalID)
}

function validateNow(now: number, terminalID: string): void {
  // Reject NaN, Infinity, negative, fractional, and overflow. Number.isInteger
  // already returns false for NaN/Infinity, but we guard explicitly to give a
  // deterministic error code rather than relying on that quirk.
  if (
    typeof now !== "number" ||
    !Number.isFinite(now) ||
    !Number.isInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER
  ) {
    throw S.SharedTerminalError.create("terminal_missing", {
      message: "now must be a non-negative safe integer",
      terminalID,
    })
  }
}

function validateRevision(revision: number, terminalID: string): void {
  if (
    typeof revision !== "number" ||
    !Number.isFinite(revision) ||
    !Number.isInteger(revision) ||
    revision < 0 ||
    revision > Number.MAX_SAFE_INTEGER
  ) {
    throw S.SharedTerminalError.create("terminal_missing", {
      message: "revision must be a non-negative safe integer",
      terminalID,
    })
  }
}

function validateLeaseID(leaseID: string, terminalID: string): void {
  if (!leaseID || leaseID.length < 1) {
    throw S.SharedTerminalError.create("terminal_missing", {
      message: "leaseID must be a non-empty string",
      terminalID,
    })
  }
}

// Validate actor shape BEFORE cloneActor() runs. A missing, wrong-type, or
// malformed actor must produce a deterministic structured rejection, never a
// TypeError from cloneActor(). Human/system actors are rejected because leases
// are agent-only.
function validateActor(actor: unknown, terminalID: string): void {
  if (typeof actor !== "object" || actor === null || Array.isArray(actor)) {
    throw S.SharedTerminalError.create("terminal_missing", {
      message: "actor must be an agent object",
      terminalID,
    })
  }
  const a = actor as Record<string, unknown>
  if (a.type !== "agent") {
    throw S.SharedTerminalError.create("terminal_missing", {
      message: "actor must be an agent (human/system actors cannot hold leases)",
      terminalID,
    })
  }
  if (typeof a.sessionID !== "string" || a.sessionID.length < 1) {
    throw S.SharedTerminalError.create("terminal_missing", {
      message: "agent actor requires a non-empty sessionID",
      terminalID,
    })
  }
  if (typeof a.agentID !== "string" || a.agentID.length < 1) {
    throw S.SharedTerminalError.create("terminal_missing", {
      message: "agent actor requires a non-empty agentID",
      terminalID,
    })
  }
  if (typeof a.callID !== "string" || a.callID.length < 1) {
    throw S.SharedTerminalError.create("terminal_missing", {
      message: "agent actor requires a non-empty callID",
      terminalID,
    })
  }
}
