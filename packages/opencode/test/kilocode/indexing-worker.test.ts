import { test, expect, describe, mock, beforeAll } from "bun:test"
import { IndexingWorker } from "../../src/kilocode/indexing-worker-client"
import { LanceDBRuntime } from "../../src/kilocode/lancedb"

const testDir = "/tmp/test-indexing-worker"
const testRoot = "/tmp/test-indexing-root"

const noopHooks = {
  status: () => {},
  telemetry: () => {},
  warning: () => {},
  log: () => {},
  failure: () => {},
}

async function withWorker<T>(fn: (w: IndexingWorker.Driver) => Promise<T>): Promise<T> {
  const w = IndexingWorker.create(testDir, testRoot, noopHooks)
  try {
    return await fn(w)
  } finally {
    await w.dispose().catch(() => {})
  }
}

describe("IndexingWorker", () => {
  describe("readiness (ping)", () => {
    test("ping receives a valid response", async () => {
      await withWorker(async (w) => {
        const result = await w.ping()
        expect(result).toBeDefined()
        expect(typeof result.key).toBe("string")
      })
    }, 30000)

    test("ping reports engine and status modules loaded", async () => {
      await withWorker(async (w) => {
        const result = await w.ping()
        expect(result.engineLoaded).toBe(true)
        expect(result.statusLoaded).toBe(true)
      })
    })

    test("ping reports KILO_LANCEDB_PATH value", async () => {
      await LanceDBRuntime.ensure("lancedb")
      await withWorker(async (w) => {
        const result = await w.ping()
        expect(result.lancedbPath).toBeDefined()
      })
    })
  })

  describe("worker lifetime", () => {
    test("disposing first host leaves Worker alive for second host", async () => {
      const dir1 = `${testDir}/w1`
      const dir2 = `${testDir}/w2`

      const w1 = IndexingWorker.create(dir1, testRoot, noopHooks)
      const w2 = IndexingWorker.create(dir2, testRoot, noopHooks)

      const ping1 = await w1.ping()
      expect(ping1.key).toContain(dir1)

      await w1.dispose()

      const ping2 = await w2.ping()
      expect(ping2.key).toContain(dir2)

      await w2.dispose()
    })

    test("disposing final host terminates the shared Worker", async () => {
      const w = IndexingWorker.create(testDir, testRoot, noopHooks)

      await w.ping()
      await w.dispose()

      await expect(w.ping()).rejects.toThrow()
    })

    test("creating a new host after final disposal creates fresh Worker", async () => {
      const w1 = IndexingWorker.create(testDir, testRoot, noopHooks)
      await w1.ping()
      await w1.dispose()

      const w2 = IndexingWorker.create(testDir, testRoot, noopHooks)
      const ping = await w2.ping()
      expect(ping.engineLoaded).toBe(true)
      await w2.dispose()
    })

    test("repeated dispose is harmless", async () => {
      const w = IndexingWorker.create(testDir, testRoot, noopHooks)

      await w.dispose()
      await w.dispose()
      await w.dispose()
    })

    test("disposal completes within the existing timeout", async () => {
      const start = Date.now()
      const w = IndexingWorker.create(testDir, testRoot, noopHooks)
      await w.dispose()
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(10000)
    }, 15000)
  })

  describe("event routing", () => {
    test("two workspace hosts share one Worker and events route to matching key", async () => {
      const events1: string[] = []
      const events2: string[] = []

      const dir1 = `${testDir}/er1`
      const dir2 = `${testDir}/er2`

      const w1 = IndexingWorker.create(dir1, testRoot, {
        ...noopHooks,
        status: (s) => events1.push(`w1:${s.state}`),
      })
      const w2 = IndexingWorker.create(dir2, testRoot, {
        ...noopHooks,
        status: (s) => events2.push(`w2:${s.state}`),
      })

      const p1 = await w1.ping()
      const p2 = await w2.ping()
      expect(p1.key).toContain(dir1)
      expect(p2.key).toContain(dir2)

      await w1.dispose()
      await w2.dispose()
    })
  })

  describe("error handling", () => {
    test("Worker error rejects pending requests and calls failure hook", async () => {
      const failSpy = mock(() => {})
      const err = new Error("simulated worker error")
      IndexingWorker.override((_dir, _root, hooks) => {
        setTimeout(() => hooks.failure(err), 5)
        return {
          ping: () => Promise.reject(err),
          init: () => Promise.reject(err),
          search: () => Promise.reject(err),
          dispose: () => Promise.resolve(),
        }
      })

      try {
        const w2 = IndexingWorker.create(`${testDir}/override`, testRoot, {
          ...noopHooks,
          failure: failSpy,
        })

        await expect(w2.ping()).rejects.toThrow("simulated worker error")

        await new Promise((r) => setTimeout(r, 20))
        expect(failSpy).toHaveBeenCalledTimes(1)
      } finally {
        IndexingWorker.override(undefined)
      }
    })
  })

  describe("full sequence", () => {
    test("create → ping → LanceDB preflight → dispose → confirm terminated", async () => {
      await LanceDBRuntime.ensure("lancedb")

      const w = IndexingWorker.create(testDir, testRoot, noopHooks)
      const ping = await w.ping()

      expect(ping.engineLoaded).toBe(true)
      expect(ping.statusLoaded).toBe(true)
      expect(typeof ping.lancedbLoaded).toBe("boolean")

      await w.dispose()
      await expect(w.ping()).rejects.toThrow()
    })
  })
})
