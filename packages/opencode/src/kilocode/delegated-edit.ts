import path from "path"
import { lstatSync } from "fs"
import z from "zod"
import { Permission } from "@/permission"
import { Instance } from "@/project/instance"
import type { SessionID } from "@/session/schema"
import { Filesystem } from "@/util/filesystem"

export namespace DelegatedEdit {
  export const Authorization = z
    .object({
      operation: z.literal("edit"),
      path: z.string().min(1),
    })
    .strict()

  export type Authorization = z.infer<typeof Authorization>
  export type Scope = Readonly<Authorization>

  export interface Lease {
    parent: SessionID
    child: SessionID
    call: string
    scope: Scope
  }

  export interface Reservation {
    parent: SessionID
    call: string
    scope: Scope
    token: symbol
  }

  export interface Binding {
    lease: Lease
    release(): void
  }

  interface Grant extends Lease {
    token: symbol
    consumed: boolean
  }

  const state = Instance.state(
    () => ({
      grants: new Map<SessionID, Grant>(),
      bindings: new Map<SessionID, string>(),
      reservations: new Map<string, Reservation>(),
      calls: new Set<string>(),
    }),
    async (current) => {
      current.grants.clear()
      current.bindings.clear()
      current.reservations.clear()
      current.calls.clear()
    },
  )

  const key = (lease: Lease) =>
    JSON.stringify([lease.parent, lease.child, lease.call, lease.scope.operation, lease.scope.path])
  const ticket = (lease: Pick<Lease, "parent" | "call">) => JSON.stringify([lease.parent, lease.call])
  const normalize = (value: string) => {
    const normalized = path.normalize(value)
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
  }
  const deny = (ruleset: Permission.Ruleset): never => {
    throw new Permission.DeniedError({ ruleset })
  }

  export function scope(input: Authorization): Scope {
    const target = path.resolve(
      Filesystem.windowsPath(path.isAbsolute(input.path) ? input.path : path.join(Instance.directory, input.path)),
    )
    const stat = (() => {
      try {
        return lstatSync(target)
      } catch (err) {
        if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
          throw new Error("Delegated edit target must already exist")
        }
        throw err
      }
    })()
    if (stat.isSymbolicLink()) throw new Error("Delegated edit target must not be a symbolic link")
    if (!stat.isFile()) throw new Error("Delegated edit target must be a regular file")

    const physical = Filesystem.resolve(target)
    const dir = Filesystem.resolve(Instance.directory)
    const root = Filesystem.resolve(Instance.worktree)
    const roots = root === path.parse(root).root ? [dir] : [dir, root]
    const inside = roots.some((base) => {
      const relative = path.relative(base, physical)
      return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    })
    if (!inside) throw new Error("Delegated edit target must remain physically inside the current project")

    const relative = path.relative(root, physical)
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("Delegated edit target must resolve to one file inside the current worktree")
    }
    return Object.freeze({ operation: input.operation, path: relative })
  }

  export function rules(lease: Lease): Permission.Ruleset {
    return [
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "edit", pattern: lease.scope.path, action: "allow" },
      { permission: "delegate_edit", pattern: key(lease), action: "allow" },
    ]
  }

  export function reserve(input: Pick<Lease, "parent" | "call" | "scope">): Reservation {
    const current = state()
    const id = ticket(input)
    if (current.calls.has(id)) throw new Error(`Delegated edit authorization already used by task call ${input.call}`)
    const reservation = {
      ...input,
      token: Symbol(input.call),
    } satisfies Reservation
    current.calls.add(id)
    current.reservations.set(id, reservation)
    return reservation
  }

  export function release(input: Reservation) {
    const current = state()
    const id = ticket(input)
    if (current.reservations.get(id)?.token !== input.token) return
    current.reservations.delete(id)
    current.calls.delete(id)
  }

  export function bind(input: Reservation, child: SessionID): Binding {
    const current = state()
    const id = ticket(input)
    if (current.reservations.get(id)?.token !== input.token) {
      throw new Error(`Delegated edit authorization is not reserved for task call ${input.call}`)
    }
    if (current.bindings.has(child)) throw new Error(`Delegated edit already registered for session ${child}`)

    const lease = { parent: input.parent, child, call: input.call, scope: input.scope }
    const grant: Grant = { ...lease, token: input.token, consumed: false }
    current.reservations.delete(id)
    current.bindings.set(child, key(grant))
    current.grants.set(child, grant)
    return {
      lease,
      release() {
        if (current.grants.get(child)?.token === grant.token) current.grants.delete(child)
      },
    }
  }

  export class EvidenceFailedError extends Error {
    readonly path: string
    constructor(path: string) {
      const message =
        "EVIDENCE_RECALL_FAILED\nsource: delegated-edit-lease\n" + `path: ${path}\nno_tool_call_executed: true`
      super(message)
      this.name = "EvidenceFailedError"
      this.path = path
    }
  }

  export class LeaseExhaustedError extends Error {
    readonly path: string
    readonly allowed: number
    readonly used: number
    constructor(path: string) {
      const message = `EDIT_LEASE_EXHAUSTED\npath: ${path}\nallowed: 1\nused: 1`
      super(message)
      this.name = "LeaseExhaustedError"
      this.path = path
      this.allowed = 1
      this.used = 1
    }
  }

  export const EvidenceRecall = z
    .object({
      source: z.literal("delegated-edit-lease"),
      exactText: z.string(),
      purpose: z.string(),
    })
    .strict()

  export type EvidenceRecall = z.infer<typeof EvidenceRecall>

  export function canonicalLeaseText(lease: Lease, usedEdits: 0 | 1 = 0): string {
    return (
      "Phase2F delegated edit lease:\n" +
      `path: ${lease.scope.path}\n` +
      "allowed edits: 1\n" +
      `used edits: ${usedEdits}`
    )
  }

  export function authorize(input: {
    sessionID: SessionID
    operation?: string
    permission: string
    patterns: string[]
    session: Permission.Ruleset
    evidence?: EvidenceRecall
  }): boolean {
    if (input.permission !== "edit") return false

    const current = state()
    const binding = current.bindings.get(input.sessionID)
    const marker = input.session.findLast(
      (rule) =>
        rule.permission === "delegate_edit" && rule.action === "allow" && (!binding || rule.pattern === binding),
    )
    if (!marker) {
      if (binding || input.session.some((r) => r.permission === "delegate_edit" && r.action === "allow")) {
        deny(input.session)
      }
      return false
    }
    if (!binding || marker.pattern !== binding) deny(input.session)
    const grant = current.grants.get(input.sessionID)
    if (!grant) return deny(input.session)
    if (grant.child !== input.sessionID || binding !== key(grant)) deny(input.session)
    if (input.operation !== grant.scope.operation) deny(input.session)
    if (input.patterns.length !== 1 || normalize(input.patterns[0] ?? "") !== normalize(grant.scope.path)) {
      deny(input.session)
    }
    if (grant.consumed) throw new LeaseExhaustedError(grant.scope.path)
    if (input.evidence === undefined) {
      throw new EvidenceFailedError(grant.scope.path)
    }
    if (input.evidence.source !== "delegated-edit-lease") {
      throw new EvidenceFailedError(grant.scope.path)
    }
    const expected = canonicalLeaseText(grant, 0)
    if (input.evidence.exactText !== expected) {
      throw new EvidenceFailedError(grant.scope.path)
    }
    grant.consumed = true
    return true
  }

  /** @internal Exposes immutable lease state for production-path security tests. */
  export function inspect(sessionID: SessionID) {
    const grant = state().grants.get(sessionID)
    if (!grant) return
    return Object.freeze({
      parent: grant.parent,
      child: grant.child,
      call: grant.call,
      scope: grant.scope,
      consumed: grant.consumed,
    })
  }
}
