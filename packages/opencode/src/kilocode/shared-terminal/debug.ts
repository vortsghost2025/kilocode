import { appendFile, mkdir, open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises"
import { appendFileSync } from "node:fs"
import path from "node:path"
import type { KeyEvent } from "@opentui/core"

export namespace SharedTerminalDebug {
  export const file = "S:\\KILO-CLEAN-SOURCE\\profile\\state\\shared-terminal-enter.log"
  export const enabled = process.env.KILO_DEBUG_SHARED_TERMINAL_KEYS === "1"
  export const MAX_BYTES = 2 * 1024 * 1024
  export const MAX_RECORDS = 10_000

  export interface Meta {
    eventName?: string
    eventCode?: string
    eventSource?: string
    eventType?: string
    defaultPrevented?: boolean
    propagationStopped?: boolean
    bytes?: string
    attachmentID?: string
    terminalID?: string
    generation?: number
    attached?: boolean
    status?: string
    errorCode?: string
  }

  function missing(error: unknown) {
    return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"
  }

  async function optional(path: string) {
    return readFile(path, "utf8").catch((error) => {
      if (missing(error)) return ""
      throw error
    })
  }

  async function remove(path: string) {
    await unlink(path).catch((error) => {
      if (!missing(error)) throw error
    })
  }

  export class Writer {
    private state = { queue: Promise.resolve() as Promise<unknown>, last: "" }

    constructor(
      readonly path: string,
      readonly limits = { bytes: MAX_BYTES, records: MAX_RECORDS },
    ) {}

    private enqueue(fn: () => Promise<unknown>) {
      const task = this.state.queue.then(fn, fn)
      this.state.queue = task.catch((error) => {
        const code = errorCode(error)
        console.error(`shared terminal trace write failed (${code})`)
      })
      return task
    }

    private lock(attempt = 0): Promise<FileHandle> {
      return open(this.path + ".lock", "wx").catch(async (error) => {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
        if (attempt >= 400) throw new Error("shared terminal trace lock timed out")
        await Bun.sleep(5)
        return this.lock(attempt + 1)
      })
    }

    private async write(line: string) {
      const lock = await this.lock()
      try {
        const content = await optional(this.path)
        if (content.endsWith(line)) return
        const records = content ? content.split("\n").length - 1 : 0
        if (records >= this.limits.records) return
        if (Buffer.byteLength(content) + Buffer.byteLength(line) > this.limits.bytes) return
        await appendFile(this.path, line, "utf8")
      } finally {
        await lock.close()
        await remove(this.path + ".lock")
      }
    }

    append(line: string) {
      if (line === this.state.last) return Promise.resolve()
      this.state.last = line
      return this.enqueue(() => this.write(line))
    }

    async reset() {
      this.state.last = ""
      await mkdir(path.dirname(this.path), { recursive: true })
      await remove(this.path + ".lock")
      await writeFile(this.path, "", "utf8")
    }
  }

  const writer = new Writer(file)

  export function errorCode(error: unknown): string {
    if (!error || typeof error !== "object") return "unknown"
    if ("code" in error && typeof error.code === "string") return error.code
    if ("data" in error && error.data && typeof error.data === "object" && "code" in error.data) {
      const code = error.data.code
      if (typeof code === "string") return code
    }
    if ("name" in error && typeof error.name === "string") return error.name
    return "unknown"
  }

  export function submitBytes(value: string): string | undefined {
    if (value !== "\r" && value !== "\n" && value !== "\r\n") return
    return Array.from(Buffer.from(value), (byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("")
  }

  export function enter(event: KeyEvent): boolean {
    return ["enter", "return", "linefeed", "kpenter"].includes(event.name.toLowerCase())
  }

  export function key(event: KeyEvent): Meta {
    return {
      eventName: event.name,
      eventCode: event.code,
      eventSource: event.source,
      eventType: event.eventType,
      defaultPrevented: event.defaultPrevented,
      propagationStopped: event.propagationStopped,
    }
  }

  export function trace(stage: string, meta: Meta = {}): void {
    if (!enabled) return
    const line = JSON.stringify({ stage, ...meta }) + "\n"
    void writer.append(line)
  }

  export function traceKey(stage: string, event: KeyEvent, meta: Meta = {}): void {
    if (!enabled || !enter(event)) return
    trace(stage, { ...key(event), ...meta })
  }

  export function traceSubmit(stage: string, value: string, meta: Meta = {}): void {
    const bytes = submitBytes(value)
    if (!enabled || !bytes) return
    trace(stage, { ...meta, bytes })
  }

  export async function reset(): Promise<void> {
    if (process.env.KILO_DEBUG_SHARED_TERMINAL_KEYS !== "1") return
    await writer.reset()
  }

  const lifecycleCounters = new Map<string, number>()
  const lifecycleLog: string[] = []

  export function count(stage: string): void {
    if (process.env.KILO_DEBUG_SHARED_TERMINAL_KEYS !== "1") return
    const next = (lifecycleCounters.get(stage) ?? 0) + 1
    lifecycleCounters.set(stage, next)
    if (lifecycleLog.length < 20) lifecycleLog.push(`${stage}=${next}`)
    const line = JSON.stringify({ stage: "lifecycle_count", name: stage, count: next }) + "\n"
    try {
      appendFileSync(file, line, "utf8")
    } catch {}
  }

  export function counts(): Record<string, number> {
    return Object.fromEntries(lifecycleCounters)
  }

  export function lifecycleLogSnapshot(): string[] {
    return [...lifecycleLog]
  }

  export async function dumpCounts(): Promise<void> {
    if (process.env.KILO_DEBUG_SHARED_TERMINAL_KEYS !== "1") return
    const snapshot = lifecycleLogSnapshot()
    if (snapshot.length === 0) return
    const line = JSON.stringify({ stage: "lifecycle_counts", counts: counts(), log: snapshot }) + "\n"
    await writer.append(line)
  }
}
