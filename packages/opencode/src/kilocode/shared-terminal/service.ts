import { SharedTerminalSchema as S } from "./schema"
import { OutputRing, StreamingEncoder } from "./buffer"
import type { RingReadResult } from "./buffer"
import { LeaseState } from "./lease"
import { SharedTerminalEnv } from "./env"
import { Reap } from "./reap"
import type { Ownership } from "./reap"
import { AuditStore } from "./audit"
import { TicketState } from "./ticket"
import type { IPty } from "bun-pty"

export namespace SharedTerminalService {
  export type Platform = "win32" | "linux" | "darwin" | "aix" | "sunos" | "freebsd" | "openbsd" | "android"

  // Immutable ownership reference handed back to a caller at create time and
  // required on every mutating/subscription operation. The stored handle is
  // built ONCE after a successful spawn; live handles are reconstructed from
  // current state for comparison. A stale generation, a rebound PID, or a
  // mismatched platform fails closed before any PTY I/O or lease validation.
  export interface TerminalRef {
    readonly terminalID: string
    readonly generation: number
    readonly rootPID: number
    readonly platform: Platform
  }

  export interface CreateTerminalInput {
    file: string
    args: string[]
    scope: { projectID: string; directory: string; worktree: string }
    createdBy: S.Actor
    title: string
    cols: number
    rows: number
  }

  export interface WriteHumanInput {
    clientID: string
    data: string
    now: number
  }

  export interface WriteAgentInput {
    ref: TerminalRef
    leaseID: string
    revision: number
    actor: Extract<S.Actor, { type: "agent" }>
    data: string
    now: number
  }

  export interface AcquireLeaseInput {
    ref: TerminalRef
    actor: Extract<S.Actor, { type: "agent" }>
    now: number
  }

  export interface RefreshLeaseInput {
    ref: TerminalRef
    leaseID: string
    actor: Extract<S.Actor, { type: "agent" }>
    revision: number
    now: number
  }

  export interface ReadCursorInput {
    from: number
    maxBytes?: number
  }

  // A subscriber frame carries explicit replay metadata: the absolute cursor
  // the subscriber should resume from (`next`), whether this frame is a replay
  // of retained history versus a live frame, gap/truncated status, and the
  // retained-start offset where applicable. The cursor never advances past
  // bytes that were not delivered.
  export interface SubscriberFrame {
    from: number
    next: number
    end: number
    bytes: Uint8Array
    replay: boolean
    gap: boolean
    gapStart?: number
    gapEnd?: number
    truncated: boolean
    retainedStart?: number
    privateBytes: number
  }

  export interface SubscriberOpts {
    onFrame: (frame: SubscriberFrame) => void
    onError: (err: unknown) => void
  }

  export type ServiceEvent =
    | { type: "lease.acquired"; terminalID: string; generation: number; leaseID: string }
    | { type: "lease.revoked"; terminalID: string; generation: number; leaseID?: string; reason: string }
    | { type: "private.begin"; terminalID: string; generation: number }
    | { type: "private.end"; terminalID: string; generation: number }
    | { type: "exit"; terminalID: string; generation: number; exitCode: number }
    | { type: "cleanup"; terminalID: string; generation: number; status: string }
    | { type: "resize"; terminalID: string; generation: number; cols: number; rows: number }

  export interface AttachCallbacks {
    onFrame: (frame: SubscriberFrame) => void
    onEvent: (event: ServiceEvent) => void
    onError: (err: unknown) => void
  }

  export interface Attachment {
    attachmentID: string
    terminalID: string
    generation: number
    mode: "read" | "write"
    callbacks: AttachCallbacks
    closed: boolean
  }

  export interface AttachWithTicketInput {
    rawTicket: string
    cursor?: number
    callbacks: AttachCallbacks
  }

  export interface SubscribeInput {
    ref: TerminalRef
    from?: number
    opts: SubscriberOpts
  }

  export interface PrivateModeInput {
    ref: TerminalRef
    active: boolean
    now: number
  }

  export interface InterruptInput {
    ref: TerminalRef
    leaseID: string
    revision: number
    actor: Extract<S.Actor, { type: "agent" }>
    now: number
  }

  export type SpawnFn = (
    file: string,
    args: string[],
    options: {
      name: string
      cols?: number
      rows?: number
      cwd?: string
      env?: Record<string, string>
    },
  ) => IPty

  export type ReapFn = (input: {
    expected: Ownership
    live: Ownership
    adapter: (pid: number) => Promise<{ ok: boolean }>
    exited: boolean
    alreadyCleaned: boolean
  }) => Promise<{ status: string }>

  export type AliveFn = (pid: number) => Promise<boolean>

  export interface Options {
    clock: () => number
    audit: AuditStore
    tickets: TicketState
    platform: Platform
    spawn: SpawnFn
    envSource: Record<string, string>
    isolatedPaths: Record<string, string>
    ringBytes?: number
    reap?: ReapFn
    aliveCheck?: AliveFn
    // kilocode_change - test-only seam: awaited before each attachWithTicket.
    // Never set by production runtime code. Used by shared-terminal WebSocket
    // integration tests to force attachWithTicket to remain pending.
    _attachHook?: { beforeAttach?: () => Promise<void> }
    // kilocode_change - test-only seam: reads internal service state.
    // Wired up by the service on first create(). Never set by production code.
    _inspectHook?: { attachmentCount?: (terminalID: string) => number }
  }

  export interface Instance {
    create(input: CreateTerminalInput): Promise<{ info: S.Info; ref: TerminalRef }>
    info(id: string): S.Info | undefined
    list(): S.Info[]
    readHuman(id: string, input: ReadCursorInput): RingReadResult
    readAgent(id: string, input: ReadCursorInput): RingReadResult
    subscribe(id: string, input: SubscribeInput): Promise<void>
    unsubscribe(id: string, cb: (frame: SubscriberFrame) => void): Promise<void>
    acquireLease(id: string, input: AcquireLeaseInput): Promise<S.Lease>
    refreshLease(id: string, input: RefreshLeaseInput): Promise<S.Lease>
    writeAgent(id: string, input: WriteAgentInput): Promise<void>
    writeHuman(id: string, input: WriteHumanInput): Promise<void>
    privateMode(id: string, input: PrivateModeInput): Promise<void>
    resize(id: string, ref: TerminalRef, cols: number, rows: number): Promise<void>
    interrupt(id: string, input: InterruptInput): Promise<void>
    terminate(id: string, ref: TerminalRef): Promise<void>
    disposeTerminal(id: string): Promise<void>
    disposeInstance(projectID: string): Promise<void>
    attachWithTicket(id: string, input: AttachWithTicketInput): Promise<Attachment>
    detach(id: string, attachmentID: string): Promise<void>
    submitHuman(id: string, attachmentID: string, data: string, now: number): Promise<void>
    resizeAttachment(id: string, attachmentID: string, cols: number, rows: number): Promise<void>
    setAttachmentPrivate(id: string, attachmentID: string, active: boolean, now: number): Promise<void>
  }

  export function create(opts: Options): Instance {
    const clock = opts.clock
    const audit = opts.audit
    const tickets = opts.tickets
    const platform = opts.platform
    const spawnFn = opts.spawn
    const reapFn = opts.reap ?? Reap.reap
    const aliveCheckFn = opts.aliveCheck ?? Reap.alive
    const terminals = new Map<string, TerminalState>()
    const idCounter = { n: 0 }

    function getState(id: string): TerminalState {
      const s = terminals.get(id)
      if (!s)
        throw S.SharedTerminalError.create("terminal_missing", { message: `terminal ${id} not found`, terminalID: id })
      return s
    }

    function makeAuditRecord(
      state: TerminalState,
      over: {
        action: S.AuditEvent["action"]
        outcome: S.AuditEvent["outcome"]
        actor?: S.Actor
        bytes?: number
        correlationID?: string
        reason?: S.AuditReason
      },
    ): void {
      const record: Parameters<AuditStore["record"]>[0] = {
        terminalID: state.id,
        generation: state.generation,
        revision: 0,
        actor: over.actor ?? state.info.createdBy,
        action: over.action,
        outcome: over.outcome,
      }
      if (over.bytes !== undefined) record.bytes = over.bytes
      if (over.correlationID !== undefined) record.correlationID = over.correlationID
      if (over.reason !== undefined) record.reason = over.reason
      ;(record as Record<string, unknown>).projectID = state.info.scope.projectID
      audit.record(record)
    }

    // Build the live ownership handle from CURRENT state. The expected handle
    // stored at creation is immutable; this handle reflects the live PID and
    // generation. A mismatch (stale generation, rebound PID, platform change)
    // returns ownership_mismatch from Reap.reap and invokes no kill.
    function liveHandle(state: TerminalState): Ownership {
      return Reap.build({
        terminalID: state.id,
        generation: state.generation,
        rootPID: state.info.pid,
        platform,
      })
    }

    // Shared cleanup finalizer: used by terminate, disposeTerminal, exit, and
    // spawn-failure rollback. Records exactly ONE final audit event (success
    // or failure). Never records a premature applied event. On success bumps
    // generation exactly once via incGeneration.
    async function runCleanup(
      state: TerminalState,
      from: "terminate" | "dispose" | "exit" | "rollback",
    ): Promise<void> {
      if (state.cleanupStatus === "cleaned" || state.cleanupStatus === "cleanup_failed") return
      state.cleanupStatus = "cleaning"
      state.info.cleanup = "cleaning"

      if (state.info.lifecycle !== "terminated" && state.info.lifecycle !== "exited") {
        state.info.lifecycle = from === "exit" ? "exited" : "terminating"
      }

      // Invalid or reserved PID: no reap attempt. Mark cleaned (nothing to
      // kill) and increment generation.
      if (!validPid(state.info.pid)) {
        state.cleanupStatus = "cleaned"
        state.info.cleanup = "cleaned"
        state.info.lifecycle = "terminated"
        makeAuditRecord(state, { action: "cleanup", outcome: "applied", reason: "instance_dispose" })
        emitEvent(state, { type: "cleanup", terminalID: state.id, generation: state.generation, status: "cleaned" })
        incGeneration(state)
        return
      }

      const expected = state.ownership
      if (!expected) {
        // No stored ownership handle (spawn never completed). Nothing to reap.
        state.cleanupStatus = "cleaned"
        state.info.cleanup = "cleaned"
        state.info.lifecycle = "terminated"
        makeAuditRecord(state, { action: "cleanup", outcome: "applied", reason: "instance_dispose" })
        emitEvent(state, { type: "cleanup", terminalID: state.id, generation: state.generation, status: "cleaned" })
        incGeneration(state)
        return
      }

      try {
        const r = await reapFn({
          expected,
          live: liveHandle(state),
          adapter: async (pid) => runKillAdapter(pid),
          exited: state.exitObserved,
          alreadyCleaned: false,
        })
        if (r.status === "cleaned" || r.status === "already_exited") {
          state.cleanupStatus = "cleaned"
          state.info.cleanup = "cleaned"
          state.info.lifecycle = "terminated"
          makeAuditRecord(state, { action: "cleanup", outcome: "applied", reason: "instance_dispose" })
          emitEvent(state, { type: "cleanup", terminalID: state.id, generation: state.generation, status: "cleaned" })
          incGeneration(state)
        } else if (r.status === "ownership_mismatch" || r.status === "unsupported") {
          const alive = await aliveCheckFn(state.info.pid)
          if (!alive) {
            state.cleanupStatus = "cleaned"
            state.info.cleanup = "cleaned"
            state.info.lifecycle = "terminated"
            makeAuditRecord(state, { action: "cleanup", outcome: "applied", reason: "instance_dispose" })
            incGeneration(state)
          } else {
            state.cleanupStatus = "cleanup_failed"
            state.info.cleanup = "cleanup_failed"
            makeAuditRecord(state, { action: "cleanup", outcome: "failed", reason: "cleanup_failed" })
            emitEvent(state, {
              type: "cleanup",
              terminalID: state.id,
              generation: state.generation,
              status: "cleanup_failed",
            })
          }
        } else {
          const alive = await aliveCheckFn(state.info.pid)
          if (!alive) {
            state.cleanupStatus = "cleaned"
            state.info.cleanup = "cleaned"
            state.info.lifecycle = "terminated"
            makeAuditRecord(state, { action: "cleanup", outcome: "applied", reason: "instance_dispose" })
            incGeneration(state)
          } else {
            state.cleanupStatus = "cleanup_failed"
            state.info.cleanup = "cleanup_failed"
            makeAuditRecord(state, { action: "cleanup", outcome: "failed", reason: "cleanup_failed" })
            emitEvent(state, {
              type: "cleanup",
              terminalID: state.id,
              generation: state.generation,
              status: "cleanup_failed",
            })
          }
        }
      } catch {
        state.cleanupStatus = "cleanup_failed"
        state.info.cleanup = "cleanup_failed"
        makeAuditRecord(state, { action: "cleanup", outcome: "failed", reason: "cleanup_failed" })
        emitEvent(state, {
          type: "cleanup",
          terminalID: state.id,
          generation: state.generation,
          status: "cleanup_failed",
        })
      }
    }

    async function runKillAdapter(pid: number): Promise<{ ok: boolean }> {
      if (platform === "win32") {
        const argv = Reap.windowsArgv(pid)
        const { spawn } = await import("child_process")
        return new Promise<{ ok: boolean }>((resolve) => {
          const child = spawn(argv[0], argv.slice(1), { windowsHide: true })
          let code: number | null = null
          let err: Error | null = null
          child.on("exit", (c) => {
            code = c
          })
          child.on("error", (e) => {
            err = e
          })
          child.on("close", () => {
            // Non-zero exit means taskkill failed to terminate the target.
            if (err) resolve({ ok: false })
            else if (code !== null && code !== 0) resolve({ ok: false })
            else resolve({ ok: true })
          })
        })
      }
      try {
        process.kill(pid, "SIGTERM")
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }

    function handleOutputFromPty(state: TerminalState, chunk: string): void {
      if (state.exitObserved || state.info.lifecycle === "exited" || state.info.lifecycle === "terminated") return
      if (chunk.length === 0) return

      const privateMode = state.leaseState.isPrivateMode()
      const currentVis: "shared" | "human" = privateMode ? "human" : "shared"

      const hadPending = state.pendingFlushVisibility !== undefined
      const priorVis = state.pendingFlushVisibility

      const byteChunks = state.encoder.push(chunk)
      const cursor = state.encoder.cursor()

      if (hadPending && byteChunks.length > 0) {
        if (byteChunks.length === 1) {
          const resolvedVis: "shared" | "human" = priorVis === "human" || currentVis === "human" ? "human" : "shared"
          state.ring.append({ bytes: byteChunks[0], visibility: resolvedVis })
        } else {
          state.ring.append({ bytes: byteChunks[0], visibility: priorVis ?? "shared" })
          for (let i = 1; i < byteChunks.length; i++) {
            state.ring.append({ bytes: byteChunks[i], visibility: currentVis })
          }
        }
      } else {
        for (const bytes of byteChunks) {
          state.ring.append({ bytes, visibility: currentVis })
        }
      }

      const endsWithHigh = chunk.charCodeAt(chunk.length - 1) >= 0xd800 && chunk.charCodeAt(chunk.length - 1) <= 0xdbff
      state.pendingFlushVisibility = endsWithHigh ? currentVis : undefined

      state.info.end = state.encoder.cursor()
      const combined = concat(byteChunks)
      if (combined.length > 0) {
        for (const [, sub] of state.subs) {
          try {
            sub.onFrame({
              from: cursor - combined.length,
              next: cursor,
              end: cursor,
              bytes: combined,
              replay: false,
              gap: false,
              truncated: false,
              privateBytes: 0,
            })
          } catch (e) {
            sub.onError(e)
          }
        }
        for (const [, att] of state.attachments) {
          if (att.closed) continue
          try {
            att.callbacks.onFrame({
              from: cursor - combined.length,
              next: cursor,
              end: cursor,
              bytes: combined,
              replay: false,
              gap: false,
              truncated: false,
              privateBytes: 0,
            })
          } catch (e) {
            att.callbacks.onError(e)
          }
        }
      }
    }

    function handleExitFromPty(state: TerminalState, exitCode: number): void {
      if (state.exitObserved) return
      state.exitObserved = true
      state.exitCode = exitCode
      state.exitedAt = clock()
      // Flush the encoder tail. The visibility of any buffered surrogate was
      // recorded in pendingFlushVisibility when the surrogate entered the
      // encoder (in handleOutputFromPty), so it is correct even if private mode
      // has changed since then.
      const tail = state.encoder.flush()
      const flushVis: "shared" | "human" = state.pendingFlushVisibility ?? "shared"
      state.pendingFlushVisibility = undefined
      for (const bytes of tail) {
        state.ring.append({ bytes, visibility: flushVis })
      }
      state.info.end = state.encoder.cursor()
      state.info.exitedAt = state.exitedAt
      state.info.exitCode = exitCode
      state.info.lifecycle = state.terminationRequested ? "terminated" : "exited"
      makeAuditRecord(state, { action: "exit", outcome: "applied", actor: { type: "system", reason: "exit" } })
      emitEvent(state, { type: "exit", terminalID: state.id, generation: state.generation, exitCode })
      state.proc = undefined
    }

    // Deliver replay frames for a subscriber inside the queue. Reads the ring
    // in chunks up to READ_MAX_BYTES until all retained bytes from `from` are
    // delivered or the ring is exhausted. Each chunk carries explicit gap and
    // truncated metadata. The subscriber cursor equals exactly bytes delivered.
    function deliverReplay(state: TerminalState, key: symbol, opts: SubscriberOpts, from: number): void {
      let cursor = from
      const retainedEnd = state.ring.end()
      // Chunked replay: deliver up to READ_MAX_BYTES per frame until all
      // retained bytes from the requested cursor are delivered.
      while (cursor < retainedEnd) {
        const r = state.ring.readHuman({ from: cursor, maxBytes: S.LIMITS.READ_MAX_BYTES })
        // Reconstruct the gap metadata the ring returned. readHuman sets
        // gap/gapStart/gapEnd and truncated/privateBytes on the result.
        const frame: SubscriberFrame = {
          from: r.next - r.bytes.length,
          next: r.next,
          end: r.end,
          bytes: r.bytes,
          replay: true,
          gap: r.gap,
          gapStart: r.gapStart,
          gapEnd: r.gapEnd,
          truncated: r.truncated,
          retainedStart: state.ring.start(),
          privateBytes: r.privateBytes,
        }
        try {
          opts.onFrame(frame)
        } catch (e) {
          opts.onError(e)
        }
        // Advance the cursor by exactly the bytes delivered (visible + hidden).
        cursor = r.next
        // If this read was truncated only because of the visible budget (not
        // because we hit retainedEnd), keep delivering the next chunk.
        if (r.eof) break
        if (r.next <= frame.from) break // no progress guard
      }
    }

    function emitEvent(state: TerminalState, event: SharedTerminalService.ServiceEvent): void {
      for (const [, att] of state.attachments) {
        if (att.closed) continue
        try {
          att.callbacks.onEvent(event)
        } catch (e) {
          att.callbacks.onError(e)
        }
      }
    }

    function deliverReplayForAttachment(
      state: TerminalState,
      callbacks: SharedTerminalService.AttachCallbacks,
      from: number,
    ): void {
      let cursor = from
      const retainedEnd = state.ring.end()
      while (cursor < retainedEnd) {
        const r = state.ring.readHuman({ from: cursor, maxBytes: S.LIMITS.READ_MAX_BYTES })
        const frame: SubscriberFrame = {
          from: r.next - r.bytes.length,
          next: r.next,
          end: r.end,
          bytes: r.bytes,
          replay: true,
          gap: r.gap,
          gapStart: r.gapStart,
          gapEnd: r.gapEnd,
          truncated: r.truncated,
          retainedStart: state.ring.start(),
          privateBytes: r.privateBytes,
        }
        try {
          callbacks.onFrame(frame)
        } catch (e) {
          callbacks.onError(e)
        }
        cursor = r.next
        if (r.eof) break
        if (r.next <= frame.from) break
      }
    }

    const instance: Instance = {
      async create(input) {
        const id = nextID(idCounter)
        const generation = 1
        const now = clock()
        const scope = { ...input.scope }

        const built = SharedTerminalEnv.build({
          platform: platform as Parameters<typeof SharedTerminalEnv.build>[0]["platform"],
          source: opts.envSource,
          isolated: opts.isolatedPaths as unknown as Parameters<typeof SharedTerminalEnv.build>[0]["isolated"],
        })

        const info: S.Info = {
          id,
          generation,
          title: input.title,
          shell: input.file,
          pid: 0,
          scope,
          access: { human: "read-write", agent: "read-write", sessions: [] },
          lifecycle: "starting",
          cleanup: "pending",
          cols: input.cols,
          rows: input.rows,
          start: 0,
          end: 0,
          private: false,
          createdBy: cloneActor(input.createdBy),
          createdAt: now,
        }

        const encoder = new StreamingEncoder()
        const ring = opts.ringBytes !== undefined ? new OutputRing({ ringBytes: opts.ringBytes }) : new OutputRing()
        const leaseState = new LeaseState()
        const subs = new Map<symbol, SharedTerminalService.SubscriberOpts>()
        const attachments = new Map<string, SharedTerminalService.Attachment>()
        const state: TerminalState = {
          id,
          generation,
          info,
          proc: undefined,
          ownership: undefined,
          encoder,
          ring,
          leaseState,
          subs,
          attachments,
          chain: Promise.resolve(),
          exitObserved: false,
          exitCode: undefined,
          exitedAt: undefined,
          terminationRequested: false,
          cleanupRequested: false,
          cleanupStarted: false,
          cleanupStatus: "pending",
          generationBumped: false,
          pendingFlushVisibility: undefined,
        }

        // Provisional state: build everything but do NOT insert into the live
        // map or record create/applied until spawn succeeds and the PID is
        // validated as a positive safe integer.
        let proc: IPty
        try {
          proc = spawnFn(input.file, input.args, {
            name: "xterm-256color",
            cols: input.cols,
            rows: input.rows,
            cwd: scope.directory,
            env: built,
          })
        } catch (err) {
          // Spawn threw before returning a proc. Record create/failed (NOT
          // exit/failed). No proc exists, so no reap attempt. Throw after.
          state.info.lifecycle = "failed"
          state.info.cleanup = "cleaned"
          state.cleanupStatus = "cleaned"
          makeAuditRecord(state, { action: "create", outcome: "failed", actor: input.createdBy })
          incGeneration(state)
          throw S.SharedTerminalError.create("terminal_missing", {
            message: `spawn failed for terminal ${id}: ${err}`,
            terminalID: id,
          })
        }

        // Validate the PID: must be a positive safe integer. PID 0, negative,
        // NaN, Infinity, or non-integer are all invalid.
        if (!validPid(proc.pid)) {
          state.info.lifecycle = "failed"
          state.info.cleanup = "cleaned"
          state.cleanupStatus = "cleaned"
          makeAuditRecord(state, { action: "create", outcome: "failed", actor: input.createdBy })
          incGeneration(state)
          // If a real process somehow exists with an invalid PID, we cannot
          // safely reap it (do not target PID 0 or negative). Kill via proc if
          // available.
          try {
            proc.kill()
          } catch {}
          throw S.SharedTerminalError.create("terminal_missing", {
            message: `spawn returned invalid PID ${proc.pid} for terminal ${id}`,
            terminalID: id,
          })
        }

        // Register callbacks BEFORE inserting into the map. If callback
        // registration throws, roll back.
        try {
          proc.onData((chunk: string) => {
            enqueue(state, () => handleOutputFromPty(state, chunk))
          })
          proc.onExit((event: { exitCode: number }) => {
            enqueue(state, () => {
              handleExitFromPty(state, event.exitCode)
              // If cleanup was already requested (terminate/dispose), run it now.
              if (state.cleanupRequested) {
                return runCleanup(state, "exit")
              }
            })
          })
        } catch (err) {
          // Callback registration failed. A real process may exist; await
          // exact cleanup before throwing. Do NOT call Reap with an invalid PID
          // — proc.pid was already validated as positive above, so it is safe.
          state.info.pid = proc.pid
          state.proc = proc
          state.info.lifecycle = "failed"
          makeAuditRecord(state, { action: "create", outcome: "failed", actor: input.createdBy })
          // Build ownership for the real PID and run cleanup.
          state.ownership = Reap.build({
            terminalID: state.id,
            generation: state.generation,
            rootPID: proc.pid,
            platform,
          })
          try {
            proc.kill()
          } catch {}
          await runCleanup(state, "rollback")
          throw S.SharedTerminalError.create("terminal_missing", {
            message: `callback registration failed for terminal ${id}: ${err}`,
            terminalID: id,
          })
        }

        // Success: set PID, proc, ownership, insert into map, record
        // create/applied.
        state.proc = proc
        state.info.pid = proc.pid
        state.ownership = Reap.build({
          terminalID: state.id,
          generation: state.generation,
          rootPID: proc.pid,
          platform,
        })
        terminals.set(id, state)
        makeAuditRecord(state, { action: "create", outcome: "applied", actor: input.createdBy })

        // Deferred running transition so returned Info always starts as "starting".
        Promise.resolve().then(() => {
          enqueue(state, () => {
            if (state.info.lifecycle === "starting") {
              state.info.lifecycle = "running"
            }
          })
        })

        return { info: cloneInfo(state.info), ref: cloneRef(state.ownership) }
      },

      info(id) {
        const s = terminals.get(id)
        if (!s) return undefined
        return cloneInfo(s.info)
      },

      list() {
        const out: S.Info[] = []
        for (const s of terminals.values()) out.push(cloneInfo(s.info))
        return out
      },

      readHuman(id, input) {
        const s = getState(id)
        const r = s.ring.readHuman({ from: input.from, maxBytes: input.maxBytes })
        r.terminalID = id
        return r
      },

      readAgent(id, input) {
        const s = getState(id)
        const r = s.ring.readAgent({ from: input.from, maxBytes: input.maxBytes })
        r.terminalID = id
        return r
      },

      async subscribe(id, input) {
        const s = getState(id)
        const key = Symbol("sub")
        return enqueue(s, () => {
          // Validate the ref before installing the subscriber.
          validateRef(s, input.ref)
          const reqFrom = input.from ?? s.encoder.cursor()
          s.subs.set(key, input.opts)
          // Deliver replay inside the queue before any live frame can arrive.
          deliverReplay(s, key, input.opts, reqFrom)
        })
      },

      async unsubscribe(id, cb) {
        const s = terminals.get(id)
        if (!s) return
        // Queue the unsubscribe so subscriber-map mutation is ordered relative
        // to concurrent output frames.
        return enqueue(s, () => {
          const key = findSubKey(s.subs, cb)
          if (key) s.subs.delete(key)
        })
      },

      async acquireLease(id, input) {
        const s = getState(id)
        return enqueue(s, () => {
          validateRef(s, input.ref)
          if (isDisposed(s)) {
            makeAuditRecord(s, {
              action: "lease.acquire",
              outcome: "rejected",
              actor: input.actor,
              reason: "instance_dispose",
            })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "terminal is disposed", terminalID: id })
          }
          try {
            const lease = s.leaseState.acquire({
              terminalID: id,
              generation: s.generation,
              actor: input.actor,
              now: input.now,
            })
            makeAuditRecord(s, { action: "lease.acquire", outcome: "applied", actor: input.actor })
            emitEvent(s, { type: "lease.acquired", terminalID: id, generation: s.generation, leaseID: lease.id })
            return lease
          } catch (err) {
            makeAuditRecord(s, {
              action: "lease.acquire",
              outcome: "rejected",
              actor: input.actor,
              reason: leaseRejectReason(err),
            })
            throw err
          }
        })
      },

      async refreshLease(id, input) {
        const s = getState(id)
        return enqueue(s, () => {
          validateRef(s, input.ref)
          if (isDisposed(s)) {
            makeAuditRecord(s, {
              action: "lease.acquire",
              outcome: "rejected",
              actor: input.actor,
              reason: "instance_dispose",
            })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "terminal is disposed", terminalID: id })
          }
          try {
            const lease = s.leaseState.refresh({
              terminalID: id,
              generation: s.generation,
              leaseID: input.leaseID,
              actor: input.actor,
              revision: input.revision,
              now: input.now,
            })
            return lease
          } catch (err) {
            makeAuditRecord(s, {
              action: "lease.acquire",
              outcome: "rejected",
              actor: input.actor,
              reason: leaseRejectReason(err),
            })
            throw err
          }
        })
      },

      async writeAgent(id, input) {
        const s = getState(id)
        return enqueue(s, () => {
          validateRef(s, input.ref)
          if (isDisposed(s)) {
            makeAuditRecord(s, {
              action: "write",
              outcome: "rejected",
              actor: input.actor,
              correlationID: input.leaseID,
              reason: "instance_dispose",
            })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "terminal is disposed", terminalID: id })
          }
          try {
            s.leaseState.validate({
              terminalID: id,
              generation: s.generation,
              leaseID: input.leaseID,
              actor: input.actor,
              revision: input.revision,
              now: input.now,
            })
          } catch (err) {
            makeAuditRecord(s, {
              action: "write",
              outcome: "rejected",
              actor: input.actor,
              correlationID: input.leaseID,
              reason: leaseRejectReason(err),
            })
            throw err
          }
          if (!s.proc) {
            // Missing proc fails closed: do NOT record applied.
            makeAuditRecord(s, {
              action: "write",
              outcome: "failed",
              actor: input.actor,
              correlationID: input.leaseID,
              reason: "process_exit",
            })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "process not attached", terminalID: id })
          }
          try {
            s.proc.write(input.data)
          } catch (err) {
            makeAuditRecord(s, {
              action: "write",
              outcome: "failed",
              actor: input.actor,
              correlationID: input.leaseID,
              reason: "process_exit",
            })
            throw err
          }
          makeAuditRecord(s, {
            action: "write",
            outcome: "applied",
            actor: input.actor,
            correlationID: input.leaseID,
            bytes: input.data.length,
          })
        })
      },

      async writeHuman(id, input) {
        const s = getState(id)
        return enqueue(s, () => {
          if (isDisposed(s)) {
            makeAuditRecord(s, {
              action: "write",
              outcome: "rejected",
              actor: { type: "human", clientID: input.clientID },
              reason: "instance_dispose",
            })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "terminal is disposed", terminalID: id })
          }
          const preempt = s.leaseState.humanPreempt()
          if (preempt.revoked) {
            makeAuditRecord(s, {
              action: "lease.revoke",
              outcome: "applied",
              actor: { type: "human", clientID: input.clientID },
              reason: "human_preempted",
              correlationID: preempt.leaseID,
            })
            emitEvent(s, {
              type: "lease.revoked",
              terminalID: id,
              generation: s.generation,
              leaseID: preempt.leaseID,
              reason: "human_preempted",
            })
          }
          if (!s.proc) {
            makeAuditRecord(s, {
              action: "write",
              outcome: "failed",
              actor: { type: "human", clientID: input.clientID },
              reason: "process_exit",
            })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "process not attached", terminalID: id })
          }
          try {
            s.proc.write(input.data)
          } catch (err) {
            makeAuditRecord(s, {
              action: "write",
              outcome: "failed",
              actor: { type: "human", clientID: input.clientID },
              reason: "process_exit",
            })
            throw err
          }
          makeAuditRecord(s, {
            action: "write",
            outcome: "applied",
            actor: { type: "human", clientID: input.clientID },
            bytes: input.data.length,
          })
        })
      },

      async privateMode(id, input) {
        const s = getState(id)
        return enqueue(s, () => {
          validateRef(s, input.ref)
          if (isDisposed(s)) {
            throw S.SharedTerminalError.create("terminal_disposed", { message: "terminal is disposed", terminalID: id })
          }
          if (input.active) {
            const preempt = s.leaseState.setPrivateMode(true)
            s.info.private = true
            if (preempt.revoked) {
              makeAuditRecord(s, {
                action: "lease.revoke",
                outcome: "applied",
                actor: { type: "system", reason: "create" },
                reason: "private_mode",
                correlationID: preempt.leaseID,
              })
              emitEvent(s, {
                type: "lease.revoked",
                terminalID: id,
                generation: s.generation,
                leaseID: preempt.leaseID,
                reason: "private_mode",
              })
            }
            makeAuditRecord(s, { action: "private.begin", outcome: "applied" })
            emitEvent(s, { type: "private.begin", terminalID: id, generation: s.generation })
          } else {
            s.leaseState.setPrivateMode(false)
            s.info.private = false
            makeAuditRecord(s, { action: "private.end", outcome: "applied" })
            emitEvent(s, { type: "private.end", terminalID: id, generation: s.generation })
          }
        })
      },

      async resize(id, ref, cols, rows) {
        const s = getState(id)
        return enqueue(s, () => {
          validateRef(s, ref)
          if (isDisposed(s)) {
            makeAuditRecord(s, { action: "resize", outcome: "rejected", reason: "instance_dispose" })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "terminal is disposed", terminalID: id })
          }
          if (!s.proc) {
            // Missing proc: do NOT mutate Info.cols/rows. Record failed.
            makeAuditRecord(s, { action: "resize", outcome: "failed", bytes: cols * rows, reason: "process_exit" })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "process not attached", terminalID: id })
          }
          try {
            s.proc.resize(cols, rows)
          } catch (err) {
            makeAuditRecord(s, { action: "resize", outcome: "failed", bytes: cols * rows, reason: "process_exit" })
            throw err
          }
          // Only after successful PTY call commit the new dimensions.
          s.info.cols = cols
          s.info.rows = rows
          makeAuditRecord(s, { action: "resize", outcome: "applied", bytes: cols * rows })
          emitEvent(s, { type: "resize", terminalID: id, generation: s.generation, cols, rows })
        })
      },

      async interrupt(id, input) {
        const s = getState(id)
        return enqueue(s, () => {
          validateRef(s, input.ref)
          if (isDisposed(s)) {
            makeAuditRecord(s, {
              action: "interrupt",
              outcome: "rejected",
              actor: input.actor,
              reason: "instance_dispose",
            })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "terminal is disposed", terminalID: id })
          }
          try {
            s.leaseState.validate({
              terminalID: id,
              generation: s.generation,
              leaseID: input.leaseID,
              actor: input.actor,
              revision: input.revision,
              now: input.now,
            })
          } catch (err) {
            makeAuditRecord(s, {
              action: "interrupt",
              outcome: "rejected",
              actor: input.actor,
              correlationID: input.leaseID,
              reason: leaseRejectReason(err),
            })
            throw err
          }
          if (!s.proc) {
            makeAuditRecord(s, { action: "interrupt", outcome: "failed", actor: input.actor, reason: "process_exit" })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "process not attached", terminalID: id })
          }
          try {
            s.proc.write("\x03")
          } catch (err) {
            makeAuditRecord(s, { action: "interrupt", outcome: "failed", actor: input.actor, reason: "process_exit" })
            throw err
          }
          makeAuditRecord(s, { action: "interrupt", outcome: "applied", actor: input.actor })
        })
      },

      async terminate(id, ref) {
        const s = terminals.get(id)
        if (!s) return
        return enqueue(s, async () => {
          validateRef(s, ref)
          if (s.info.lifecycle === "terminated") return
          if (s.exitObserved || s.info.lifecycle === "exited") {
            s.terminationRequested = true
            s.cleanupRequested = true
            return runCleanup(s, "exit")
          }
          if (s.info.lifecycle === "terminating") return
          s.info.lifecycle = "terminating"
          s.terminationRequested = true
          s.cleanupRequested = true
          if (s.proc) {
            try {
              s.proc.kill()
            } catch {}
          }
          return runCleanup(s, "terminate")
        })
      },

      async disposeTerminal(id) {
        const s = terminals.get(id)
        if (!s) return
        return enqueue(s, async () => {
          if (s.cleanupStatus === "cleaned" || s.cleanupStatus === "cleanup_failed") return
          s.terminationRequested = true
          s.cleanupRequested = true
          if (!s.exitObserved && s.proc) {
            s.info.lifecycle = "terminating"
            try {
              s.proc.kill()
            } catch {}
          }
          return runCleanup(s, s.exitObserved ? "exit" : "dispose")
        })
      },

      async disposeInstance(projectID) {
        const targets: string[] = []
        for (const [id, s] of terminals) {
          if (s.info.scope.projectID === projectID) targets.push(id)
        }
        for (const id of targets) {
          await instance.disposeTerminal(id)
        }
      },

      async attachWithTicket(id, input) {
        const s = getState(id)
        // kilocode_change start — test-only seam
        await opts._attachHook?.beforeAttach?.()
        // kilocode_change end
        return enqueue(s, () => {
          if (isDisposed(s)) {
            throw S.SharedTerminalError.create("terminal_disposed", { message: "terminal is disposed", terminalID: id })
          }
          const consume = tickets.consumeMode({
            raw: input.rawTicket,
            terminalID: id,
            generation: s.generation,
            projectID: s.info.scope.projectID,
            now: clock(),
          })
          if (!consume.success) {
            const code = consume.error ?? "ticket_invalid"
            switch (code) {
              case "ticket_expired":
                throw S.SharedTerminalError.create("ticket_expired", { message: "ticket expired", terminalID: id })
              case "ticket_reused":
                throw S.SharedTerminalError.create("ticket_reused", {
                  message: "ticket already consumed",
                  terminalID: id,
                })
              default:
                throw S.SharedTerminalError.create("ticket_invalid", { message: "ticket invalid", terminalID: id })
            }
          }
          const attID = nextAttachmentID()
          const att: SharedTerminalService.Attachment = {
            attachmentID: attID,
            terminalID: id,
            generation: s.generation,
            mode: consume.mode!,
            callbacks: input.callbacks,
            closed: false,
          }
          s.attachments.set(attID, att)
          const reqFrom = input.cursor ?? s.encoder.cursor()
          deliverReplayForAttachment(s, input.callbacks, reqFrom)
          return att
        })
      },

      async detach(id, attachmentID) {
        const s = terminals.get(id)
        if (!s) return
        return enqueue(s, () => {
          const att = s.attachments.get(attachmentID)
          if (!att) return
          att.closed = true
          s.attachments.delete(attachmentID)
        })
      },

      async submitHuman(id, attachmentID, data, now) {
        const s = getState(id)
        return enqueue(s, () => {
          const att = s.attachments.get(attachmentID)
          if (!att || att.closed) {
            throw S.SharedTerminalError.create("terminal_disposed", {
              message: "attachment not found or closed",
              terminalID: id,
            })
          }
          if (isDisposed(s)) {
            makeAuditRecord(s, {
              action: "write",
              outcome: "rejected",
              actor: { type: "human", clientID: attachmentID },
              reason: "instance_dispose",
            })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "terminal is disposed", terminalID: id })
          }
          if (!s.proc) {
            makeAuditRecord(s, {
              action: "write",
              outcome: "failed",
              actor: { type: "human", clientID: attachmentID },
              reason: "process_exit",
            })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "process not attached", terminalID: id })
          }
          const preempt = s.leaseState.humanPreempt()
          if (preempt.revoked) {
            makeAuditRecord(s, {
              action: "lease.revoke",
              outcome: "applied",
              actor: { type: "human", clientID: attachmentID },
              reason: "human_preempted",
              correlationID: preempt.leaseID,
            })
            emitEvent(s, {
              type: "lease.revoked",
              terminalID: id,
              generation: s.generation,
              leaseID: preempt.leaseID,
              reason: "human_preempted",
            })
          }
          try {
            s.proc.write(data)
          } catch (err) {
            makeAuditRecord(s, {
              action: "write",
              outcome: "failed",
              actor: { type: "human", clientID: attachmentID },
              reason: "process_exit",
            })
            throw err
          }
          makeAuditRecord(s, {
            action: "write",
            outcome: "applied",
            actor: { type: "human", clientID: attachmentID },
            bytes: data.length,
          })
        })
      },

      async resizeAttachment(id, attachmentID, cols, rows) {
        const s = getState(id)
        return enqueue(s, () => {
          const att = s.attachments.get(attachmentID)
          if (!att || att.closed) {
            throw S.SharedTerminalError.create("terminal_disposed", {
              message: "attachment not found or closed",
              terminalID: id,
            })
          }
          if (isDisposed(s)) {
            makeAuditRecord(s, { action: "resize", outcome: "rejected", reason: "instance_dispose" })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "terminal is disposed", terminalID: id })
          }
          if (!s.proc) {
            makeAuditRecord(s, { action: "resize", outcome: "failed", bytes: cols * rows, reason: "process_exit" })
            throw S.SharedTerminalError.create("terminal_disposed", { message: "process not attached", terminalID: id })
          }
          try {
            s.proc.resize(cols, rows)
          } catch (err) {
            makeAuditRecord(s, { action: "resize", outcome: "failed", bytes: cols * rows, reason: "process_exit" })
            throw err
          }
          s.info.cols = cols
          s.info.rows = rows
          makeAuditRecord(s, { action: "resize", outcome: "applied", bytes: cols * rows })
          emitEvent(s, { type: "resize", terminalID: id, generation: s.generation, cols, rows })
        })
      },

      async setAttachmentPrivate(id, attachmentID, active, now) {
        const s = getState(id)
        return enqueue(s, () => {
          const att = s.attachments.get(attachmentID)
          if (!att || att.closed) {
            throw S.SharedTerminalError.create("terminal_disposed", {
              message: "attachment not found or closed",
              terminalID: id,
            })
          }
          if (isDisposed(s)) {
            throw S.SharedTerminalError.create("terminal_disposed", { message: "terminal is disposed", terminalID: id })
          }
          if (active) {
            const preempt = s.leaseState.setPrivateMode(true)
            s.info.private = true
            if (preempt.revoked) {
              makeAuditRecord(s, {
                action: "lease.revoke",
                outcome: "applied",
                actor: { type: "system", reason: "create" },
                reason: "private_mode",
                correlationID: preempt.leaseID,
              })
              emitEvent(s, {
                type: "lease.revoked",
                terminalID: id,
                generation: s.generation,
                leaseID: preempt.leaseID,
                reason: "private_mode",
              })
            }
            makeAuditRecord(s, { action: "private.begin", outcome: "applied" })
            emitEvent(s, { type: "private.begin", terminalID: id, generation: s.generation })
          } else {
            s.leaseState.setPrivateMode(false)
            s.info.private = false
            makeAuditRecord(s, { action: "private.end", outcome: "applied" })
            emitEvent(s, { type: "private.end", terminalID: id, generation: s.generation })
          }
        })
      },
    }

    // kilocode_change start — wire test inspection hooks
    if (opts._inspectHook) {
      opts._inspectHook.attachmentCount = (id: string) => {
        const s = terminals.get(id)
        return s ? s.attachments.size : 0
      }
    }
    // kilocode_change end

    return instance
  }
}

type TerminalState = {
  id: string
  generation: number
  info: S.Info
  proc: IPty | undefined
  ownership: Ownership | undefined
  encoder: StreamingEncoder
  ring: OutputRing
  leaseState: LeaseState
  subs: Map<symbol, SharedTerminalService.SubscriberOpts>
  attachments: Map<string, SharedTerminalService.Attachment>
  chain: Promise<void>
  exitObserved: boolean
  exitCode: number | undefined
  exitedAt: number | undefined
  terminationRequested: boolean
  cleanupRequested: boolean
  cleanupStarted: boolean
  cleanupStatus: S.Cleanup
  generationBumped: boolean
  pendingFlushVisibility: "shared" | "human" | undefined
}

function incGeneration(state: TerminalState): void {
  if (!state.generationBumped) {
    state.generationBumped = true
    state.generation += 1
    state.info.generation = state.generation
  }
}

function cloneInfo(i: S.Info): S.Info {
  return {
    ...i,
    createdBy: cloneActor(i.createdBy),
    scope: { ...i.scope },
    access: { ...i.access, sessions: [...i.access.sessions] },
  }
}

function cloneRef(o: Ownership): SharedTerminalService.TerminalRef {
  return { terminalID: o.terminalID, generation: o.generation, rootPID: o.rootPID, platform: o.platform }
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

function nextID(counter: { n: number }): string {
  counter.n += 1
  return `st-${counter.n}`
}

let attachmentCounter = 0
function nextAttachmentID(): string {
  attachmentCounter += 1
  return `att-${attachmentCounter}`
}

function enqueue<T>(state: TerminalState, fn: () => T | Promise<T>): Promise<T> {
  const p = state.chain.then(
    () => fn(),
    () => fn(),
  )
  state.chain = p.then(() => undefined as unknown as void).catch(() => {})
  return p
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0)
  let n = 0
  for (const c of chunks) n += c.length
  const out = new Uint8Array(n)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function findSubKey(
  subs: Map<symbol, SharedTerminalService.SubscriberOpts>,
  cb: (frame: SharedTerminalService.SubscriberFrame) => void,
): symbol | undefined {
  for (const [key, opts] of subs) {
    if (opts.onFrame === cb) return key
  }
  return undefined
}

// Validate a positive safe-integer PID. PID 0 is the System Idle Process
// (Windows) / scheduler (POSIX) and must never be targeted.
function validPid(pid: number): boolean {
  return (
    typeof pid === "number" &&
    Number.isFinite(pid) &&
    Number.isInteger(pid) &&
    pid > 0 &&
    pid <= Number.MAX_SAFE_INTEGER
  )
}

// Validate the caller-supplied TerminalRef against the stored ownership handle.
// A stale generation, rebound PID, mismatched terminalID, or platform change
// fails closed with terminal_disposed BEFORE any lease validation or PTY I/O.
function validateRef(state: TerminalState, ref: SharedTerminalService.TerminalRef): void {
  const own = state.ownership
  if (!own) {
    throw S.SharedTerminalError.create("terminal_disposed", {
      message: "terminal has no ownership handle",
      terminalID: state.id,
    })
  }
  if (
    ref.terminalID !== own.terminalID ||
    ref.generation !== own.generation ||
    ref.rootPID !== own.rootPID ||
    ref.platform !== own.platform
  ) {
    throw S.SharedTerminalError.create("terminal_disposed", {
      message: `stale generation or ownership mismatch for terminal ${state.id}`,
      terminalID: state.id,
    })
  }
}

function isDisposed(s: TerminalState): boolean {
  return s.info.lifecycle === "terminated" || s.info.lifecycle === "terminating" || s.info.lifecycle === "failed"
}

// Map a lease validation error code to an AuditReason for a rejected record.
function leaseRejectReason(err: unknown): S.AuditReason {
  const code = (err as { code?: string })?.code
  if (code === "lease_missing") return "lease_missing"
  if (code === "lease_stale") return "lease_stale"
  if (code === "lease_expired") return "lease_expired"
  if (code === "private_mode") return "private_mode"
  return "permission_denied"
}
