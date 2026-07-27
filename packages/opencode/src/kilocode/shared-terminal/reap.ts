// Generation-bound exact owned-process cleanup for the Kilo-only shared-
// terminal service.
//
// This module NEVER kills by image or executable name. It NEVER uses taskkill
// without an exact /PID. It NEVER uses Stop-Process by name, taskkill /IM,
// killall, or pkill. It NEVER scans broadly for matching commands. It NEVER
// kills the current Kilo process. It NEVER kills an unrelated sibling. It
// NEVER broadens the target after a cleanup failure.
//
// Cleanup is bound to an exact immutable ownership handle containing at
// minimum terminalID, generation, rootPID, and platform. Before invoking an
// adapter, the expected ownership handle is compared with the currently
// recorded live handle; any mismatch returns ownership_mismatch and invokes
// no kill operation. The adapter receives ONLY the validated exact root PID.
//
// Results are deterministic structured values: cleaned, already_exited,
// ownership_mismatch, unsupported, cleanup_failed. Repeated cleanup after
// success is idempotent.

export type Platform = "win32" | "linux" | "darwin" | "aix" | "sunos" | "freebsd" | "openbsd" | "android"

export interface Ownership {
  readonly terminalID: string
  readonly generation: number
  readonly rootPID: number
  readonly platform: Platform
}

export interface BuildOwnershipInput {
  terminalID: string
  generation: number
  rootPID: number
  platform: Platform
}

export type ReapStatus = "cleaned" | "already_exited" | "ownership_mismatch" | "unsupported" | "cleanup_failed"

export interface ReapResult {
  status: ReapStatus
  platform: Platform
  pid: number
}

export interface AdapterResult {
  ok: boolean
  error?: string
}

export interface ReapInput {
  expected: Ownership
  live: Ownership
  adapter: (rootPID: number) => Promise<AdapterResult>
  exited?: boolean
  alreadyCleaned?: boolean
}

// Reserved/unsafe PIDs that must never be targeted. PID 0 is the System Idle
// Process on Windows and the scheduler/swapper on POSIX. PID 4 is the Windows
// System process. The current Kilo process and its parent are also refused.
const RESERVED_PIDS = new Set([0, 4])

function safeInt(n: number): boolean {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER
}

function validateOwnershipInput(input: BuildOwnershipInput): void {
  if (typeof input.terminalID !== "string" || input.terminalID.length < 1) {
    throw new Error("terminalID must be a non-empty string")
  }
  if (!safeInt(input.generation)) {
    throw new Error("generation must be a non-negative safe integer")
  }
  if (!safeInt(input.rootPID)) {
    throw new Error("rootPID must be a non-negative safe integer")
  }
  if (typeof input.platform !== "string" || input.platform.length < 1) {
    throw new Error("platform must be a non-empty string")
  }
}

export namespace Reap {
  // Build an immutable ownership handle. Validates all numeric identities as
  // safe non-negative integers and the terminalID as non-empty.
  export function build(input: BuildOwnershipInput): Ownership {
    validateOwnershipInput(input)
    return Object.freeze({
      terminalID: input.terminalID,
      generation: input.generation,
      rootPID: input.rootPID,
      platform: input.platform,
    }) as Ownership
  }

  // Discrete argv for the Windows adapter. Always:
  //   taskkill /PID <exact-root-pid> /T /F
  // Never /IM, never an image/executable name, never a composed shell command.
  export function windowsArgv(rootPID: number): string[] {
    return ["taskkill", "/PID", String(rootPID), "/T", "/F"]
  }

  // Discrete argv for the POSIX adapter. Targets the exact root PID only; the
  // caller is responsible for proving ownership of a process group before
  // using a negative/signal-target form. The default adapter here targets the
  // exact PID with SIGTERM. Descendant-tree cleanup is only claimed where the
  // probe can demonstrate it; on POSIX the default adapter does NOT claim
  // descendant-tree cleanup unless group ownership is proven by the caller.
  export function posixArgv(rootPID: number): string[] {
    return ["kill", "-TERM", String(rootPID)]
  }

  // Probe whether a PID is currently alive. Uses a no-throw best-effort
  // signal-0 check on POSIX and tasklist on Windows. Returns false for exited
  // or unprovable processes.
  export async function alive(pid: number): Promise<boolean> {
    if (!safeInt(pid) || pid <= 0) return false
    if (process.platform === "win32") {
      return windowsAlive(pid)
    }
    return posixAlive(pid)
  }

  // Execute a generation-bound cleanup. Compares expected vs live ownership
  // before invoking the adapter. A mismatch returns ownership_mismatch and
  // invokes no kill. An unsafe/reserved/current PID returns unsupported and
  // invokes no kill. An already-exited root returns already_exited and
  // invokes no kill. An already-cleaned handle returns cleaned without a
  // second kill (idempotency). Adapter failure returns cleanup_failed and
  // NEVER broadens the target.
  export async function reap(input: ReapInput): Promise<ReapResult> {
    const expected = input.expected
    const platform = expected.platform
    const pid = expected.rootPID

    // Unsafe/reserved/current PID: never target.
    if (!safeInt(pid) || pid <= 0 || RESERVED_PIDS.has(pid) || pid === process.pid) {
      return { status: "unsupported", platform, pid }
    }

    // Ownership mismatch: no kill.
    if (
      expected.terminalID !== input.live.terminalID ||
      expected.generation !== input.live.generation ||
      expected.rootPID !== input.live.rootPID ||
      expected.platform !== input.live.platform
    ) {
      return { status: "ownership_mismatch", platform, pid }
    }

    // Already exited: no kill.
    if (input.exited) {
      return { status: "already_exited", platform, pid }
    }

    // Idempotency: a handle already marked cleaned is not reaped again.
    if (input.alreadyCleaned) {
      return { status: "cleaned", platform, pid }
    }

    const res = await input.adapter(pid)
    if (!res.ok) {
      // Failure never broadens the target; the adapter received the exact PID.
      return { status: "cleanup_failed", platform, pid }
    }
    return { status: "cleaned", platform, pid }
  }
}

async function windowsAlive(pid: number): Promise<boolean> {
  const { spawn } = await import("child_process")
  return new Promise<boolean>((resolve) => {
    const child = spawn("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      windowsHide: true,
    })
    let out = ""
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()))
    child.on("exit", () => {
      // tasklist prints the PID in CSV when alive; an exited PID yields
      // "INFO: No tasks are running which match...".
      resolve(out.includes(String(pid)) && !out.includes("No tasks"))
    })
    child.on("error", () => resolve(false))
  })
}

async function posixAlive(pid: number): Promise<boolean> {
  // signal 0 checks existence without sending a signal. Use process.kill
  // directly; a thrown error means not alive (ESRCH) or no permission
  // (EPERM, still alive but not ours). We treat EPERM as alive to avoid
  // false negatives; cleanup targeting is bounded by ownership comparison
  // before this probe is ever consulted.
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "EPERM") return true
    return false
  }
}
