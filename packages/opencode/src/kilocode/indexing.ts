import z from "zod"
import path from "path"
import { toIndexingConfigInput, type IndexingConfig } from "@kilocode/kilo-indexing/config"
import { IndexingStatus, disabledIndexingStatus } from "@kilocode/kilo-indexing/status"
import type { VectorStoreSearchResult } from "@kilocode/kilo-indexing/engine"
import { Instance } from "@/project/instance"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { registerDisposer } from "@/effect/instance-registry"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { Event as IndexingEvent, Warning as IndexingWarningEvent } from "./indexing-event"
import { indexingWarningKey, type IndexingWarning } from "./indexing-warning"
import { IndexingWorker } from "./indexing-worker-client"
import { LanceDBRuntime } from "./lancedb"
import { primaryWorktree } from "./primary-worktree"

const log = Log.create({ service: "kilocode-indexing" })
const missing = () => disabledIndexingStatus("Indexing plugin is not enabled for this workspace.")

const baselineDirectory = async (dir: string) => {
  return primaryWorktree(dir)
}

function failed(err: unknown): z.infer<typeof IndexingStatus> {
  const msg = err instanceof Error ? err.message : String(err)
  const text = msg.startsWith("Failed to initialize:") ? msg : `Failed to initialize: ${msg}`

  return {
    state: "Error",
    message: text,
    processedFiles: 0,
    totalFiles: 0,
    percent: 0,
  }
}

function pending(): z.infer<typeof IndexingStatus> {
  return {
    state: "In Progress",
    message: "Indexing is initializing.",
    processedFiles: 0,
    totalFiles: 0,
    percent: 0,
  }
}

export namespace KiloIndexing {
  export const Status = IndexingStatus
  export type Status = z.infer<typeof Status>

  export function input(cfg?: IndexingConfig) {
    return toIndexingConfigInput({
      ...cfg,
      enabled: cfg?.enabled ?? false,
    })
  }

  type Entry = {
    engine?: IndexingWorker.Driver
    initialized?: boolean
    current(): Status
    warnings(): IndexingWarning[]
    publish(): Promise<void>
    dispose(): Promise<void>
  }

  type Cache = {
    promise: Promise<Entry>
    entry?: Entry
    disposed?: boolean
  }

  export const Event = IndexingEvent
  export const Warning = IndexingWarningEvent

  const cache = new Map<string, Cache>()

  const inert = async (current: () => Status): Promise<Entry> => {
    const publish = async () => {
      await Bus.publish(Event, { status: current() })
    }

    return {
      current,
      warnings: () => [],
      publish,
      async dispose() {},
    }
  }

  const boot = async (): Promise<Entry> => {
    const dir = Instance.directory
    const baseline = await baselineDirectory(dir)
    const cfg = await Config.get()
    if (process.env["KILO_DISABLE_CODEBASE_INDEXING"] === "vscode-no-workspace") {
      return inert(() =>
        disabledIndexingStatus("Codebase indexing is disabled because no workspace folder is open in VS Code."),
      )
    }
    if (!cfg.indexing?.enabled) {
      return inert(() => missing())
    }

    log.info("initializing project indexing", { workspacePath: dir, baselineDirectory: baseline })
    const root = path.join(Global.Path.state, "indexing")
    const cfgInput = input(cfg.indexing)

    const box = { status: pending() }
    const warnings = new Map<string, IndexingWarning>()
    let disposed = false

    const current = () => box.status

    const same = (left: Status | undefined, right: Status) =>
      left?.state === right.state &&
      left.message === right.message &&
      left.processedFiles === right.processedFiles &&
      left.totalFiles === right.totalFiles &&
      left.percent === right.percent
    const report = Instance.bind((next = current()) => {
      return Bus.publish(Event, { status: next }).catch((err) => {
        log.error("failed to publish indexing status", { err })
      })
    })
    const status = Instance.bind((next: Status) => {
      if (disposed) return
      const previous = current()
      box.status = next
      if (same(previous, next)) return
      void report(next)
    })
    const telemetry = Instance.bind(() => {})
    const warning = Instance.bind((item: IndexingWarning) => {
      if (disposed) return
      const key = indexingWarningKey(item)
      if (warnings.has(key)) return
      warnings.set(key, item)
      Bus.publish(IndexingWarningEvent, item).catch((err) => {
        log.error("failed to publish indexing warning", { err })
      })
    })
    const output = Instance.bind((event: Parameters<IndexingWorker.Hooks["log"]>[0]) => {
      if (disposed) return
      log[event.level](event.message, { source: "worker", workspacePath: dir })
    })
    const base: Entry = {
      current,
      warnings: () => [...warnings.values()],
      publish: () => report(),
      async dispose() {
        if (disposed) return
        disposed = true
        base.initialized = false
        await base.engine?.dispose().catch((err) => {
          log.warn("failed to dispose project indexing worker", { err, workspacePath: dir })
        })
      },
    }
    const failure = Instance.bind((err: unknown) => {
      if (disposed) return
      base.initialized = false
      log.error("project indexing worker failed", { err, workspacePath: dir })
      status(failed(err))
    })

    await report()

    if (!cfgInput.enabled) {
      box.status = disabledIndexingStatus()
      await report()
      return base
    }

    const err = await LanceDBRuntime.ensure(cfgInput.vectorStoreProvider)
      .then(async () => {
        if (disposed) return
        const engine = IndexingWorker.create(dir, root, { status, telemetry, warning, log: output, failure })
        base.engine = engine
        box.status = await engine.init(cfgInput, baseline)
        base.initialized = true
      })
      .then(
        () => undefined,
        (err) => err,
      )
    if (disposed) return base

    if (err) {
      await base.engine?.dispose().catch((disposeErr) => {
        log.warn("failed to dispose failed project indexing worker", { err: disposeErr, workspacePath: dir })
      })
      base.engine = undefined
      const next = failed(err)
      status(next)
      log.error("project indexing initialization failed", { err, workspacePath: dir })
      await report(next)
      return base
    }

    log.info("project indexing initialized", { workspacePath: dir, state: current().state })
    await report()

    return base
  }

  const hit = () => {
    const dir = Instance.directory
    const existing = cache.get(dir)
    if (existing) return existing

    const next: Cache = { promise: null as unknown as Promise<Entry> }
    next.promise = boot()
      .then(async (entry) => {
        if (next.disposed) {
          await entry.dispose()
          return entry
        }
        next.entry = entry
        return entry
      })
      .catch((err) => {
        if (cache.get(dir) === next) cache.delete(dir)
        throw err
      })
    cache.set(dir, next)
    return next
  }

  registerDisposer(async (dir) => {
    const hit = cache.get(dir)
    cache.delete(dir)
    if (hit) hit.disposed = true
    if (hit?.entry) {
      await hit.entry.dispose()
      return
    }
  })

  export async function init() {
    const current = hit()
    void current.promise.catch((err) => {
      log.error("failed to initialize indexing", { err })
    })
    await current.promise
  }

  export async function current(): Promise<Status> {
    const entry = await hit().promise
    return entry.current()
  }

  export async function warnings(): Promise<IndexingWarning[]> {
    const entry = await hit().promise
    return entry.warnings()
  }

  export function ready(): boolean {
    const entry = cache.get(Instance.directory)?.entry
    if (!entry?.initialized) return false
    return entry.current().state !== "Disabled"
  }

  export async function search(query: string, directoryPrefix?: string): Promise<VectorStoreSearchResult[]> {
    const entry = await hit().promise
    if (!entry.initialized || entry.current().state === "Disabled" || !entry.engine) return []
    return entry.engine.search(query, directoryPrefix)
  }
}
