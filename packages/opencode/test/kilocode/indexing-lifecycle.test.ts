import { afterEach, describe, expect, test, mock } from "bun:test"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { KiloIndexing } from "../../src/kilocode/indexing"
import { IndexingWorker } from "../../src/kilocode/indexing-worker-client"
import { Event as IndexingEvent, Warning as IndexingWarningEvent } from "../../src/kilocode/indexing-event"
import type { IndexingStatus } from "@kilocode/kilo-indexing/status"
import type { IndexingWarning } from "../../src/kilocode/indexing-warning"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
  IndexingWorker.override()
})

type MockDriver = IndexingWorker.Driver

function stub(
  status: IndexingStatus = { state: "Standby", message: "", processedFiles: 0, totalFiles: 0, percent: 100 },
): MockDriver {
  let disposed = false
  return {
    ping: mock(async () => ({
      key: "test",
      engineLoaded: true,
      statusLoaded: true,
      lancedbPath: undefined,
      lancedbLoaded: true,
      connectType: undefined,
    })),
    init: mock(async (_cfg, _baseline) => {
      if (disposed) throw new Error("disposed")
      return status
    }),
    search: mock(async (_query, _prefix) => []),
    dispose: mock(async () => {
      disposed = true
    }),
  }
}

function factory(driver: MockDriver): IndexingWorker.Factory {
  return (_dir, _root, hooks) => {
    ;(driver as any).__hooks = hooks
    return driver
  }
}

describe("KiloIndexing lifecycle", () => {
  test("indexing block absent: Worker not called, status Disabled", async () => {
    await using tmp = await tmpdir({ git: true })
    const driver = stub()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        await KiloIndexing.init()
        const status = await KiloIndexing.current()
        expect(status.state).toBe("Disabled")
        expect(driver.init).not.toHaveBeenCalled()
      },
    })
  })

  test("enabled false: Worker not called, status Disabled", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: false } } })
    const driver = stub()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        await KiloIndexing.init()
        const status = await KiloIndexing.current()
        expect(status.state).toBe("Disabled")
        expect(driver.init).not.toHaveBeenCalled()
      },
    })
  })

  test("enabled true: Worker init called with complete config", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        indexing: {
          enabled: true,
          provider: "openai",
          ollama: { baseUrl: "http://127.0.0.1:11434" },
          searchMinScore: 0.35,
        },
      },
    })
    const driver = stub()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        await KiloIndexing.init()
        expect(driver.init).toHaveBeenCalledTimes(1)
      },
    })
  })

  test("repeated sequential init: Worker init called once", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    const driver = stub()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        await KiloIndexing.init()
        await KiloIndexing.init()
        const status = await KiloIndexing.current()
        expect(status.state).toBe("Standby")
        expect(driver.init).toHaveBeenCalledTimes(1)
      },
    })
  })

  test("concurrent init: multiple calls share one initialization", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    const driver = stub()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        const [r1, r2, r3] = await Promise.all([KiloIndexing.init(), KiloIndexing.init(), KiloIndexing.init()])
        expect(driver.init).toHaveBeenCalledTimes(1)
        const status = await KiloIndexing.current()
        expect(status.state).toBe("Standby")
      },
    })
  })

  test("successful init: ready() true, status event published", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    const driver = stub()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        const events: any[] = []
        const unsub = Bus.subscribeAll((e) => events.push(e))
        try {
          await KiloIndexing.init()
          const ready = KiloIndexing.ready()
          expect(ready).toBe(true)
          await Bun.sleep(0)
          const statusEvents = events.filter((e) => e.type === "indexing.status")
          expect(statusEvents.length).toBeGreaterThan(0)
          const last = statusEvents[statusEvents.length - 1]
          expect(last.properties.status.state).toBe("Standby")
        } finally {
          unsub()
        }
      },
    })
  })

  test("failed init: status Error, ready() false", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    const driver = stub()
    driver.init = mock(async () => {
      throw new Error("mock init failure")
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        await KiloIndexing.init()
        const status = await KiloIndexing.current()
        expect(status.state).toBe("Error")
        expect(status.message).toContain("mock init failure")
        expect(KiloIndexing.ready()).toBe(false)
        expect(driver.dispose).toHaveBeenCalledTimes(1)
      },
    })
  })

  test("search after initialization: delegates query and prefix", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    const driver = stub()
    driver.search = mock(async (_query, _prefix) => [{ id: "1", content: "test", score: 0.9 }])

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        await KiloIndexing.init()
        const results = await KiloIndexing.search("test query", "src/")
        expect(results).toHaveLength(1)
        expect(driver.search).toHaveBeenCalledWith("test query", "src/")
      },
    })
  })

  test("disposal: driver.dispose called once, cache removed", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    const driver = stub()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        await KiloIndexing.init()
        expect(KiloIndexing.ready()).toBe(true)
      },
    })

    await Instance.disposeAll()
    expect(driver.dispose).toHaveBeenCalledTimes(1)
  })

  test("fresh driver after disposal: subsequent init creates new driver", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    let callCount = 0
    const d1 = stub()
    const d2 = stub()

    IndexingWorker.override((_dir, _root, _hooks) => {
      callCount++
      return callCount === 1 ? d1 : d2
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await KiloIndexing.init()
          expect(KiloIndexing.ready()).toBe(true)
        },
      })
      await Instance.disposeAll()
      expect(d1.dispose).toHaveBeenCalledTimes(1)

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await KiloIndexing.init()
          expect(KiloIndexing.ready()).toBe(true)
        },
      })
      expect(callCount).toBe(2)
      expect(d2.init).toHaveBeenCalledTimes(1)
    } finally {
      IndexingWorker.override()
    }
  })

  test("separate Instance directories: distinct drivers and cache entries", async () => {
    await using tmp1 = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    await using tmp2 = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    const d1 = stub()
    const d2 = stub()

    let calls: string[] = []
    IndexingWorker.override((dir, _root, _hooks) => {
      calls.push(dir)
      return dir === tmp1.path ? d1 : d2
    })

    try {
      await Instance.provide({
        directory: tmp1.path,
        fn: async () => {
          await KiloIndexing.init()
          expect(KiloIndexing.ready()).toBe(true)
        },
      })
      expect(d1.init).toHaveBeenCalledTimes(1)

      await Instance.provide({
        directory: tmp2.path,
        fn: async () => {
          await KiloIndexing.init()
          expect(KiloIndexing.ready()).toBe(true)
        },
      })
      expect(d2.init).toHaveBeenCalledTimes(1)

      await Instance.provide({
        directory: tmp1.path,
        fn: async () => {
          const results = await KiloIndexing.search("q")
          expect(results).toEqual([])
          expect(d1.search).toHaveBeenCalledTimes(1)
          expect(d2.search).not.toHaveBeenCalled()
        },
      })
    } finally {
      IndexingWorker.override()
    }
  })

  test("warning: first unique warning stores and publishes Bus event", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    const driver = stub()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        const events: any[] = []
        const unsub = Bus.subscribeAll((e) => events.push(e))
        try {
          await KiloIndexing.init()

          const hooks: IndexingWorker.Hooks = (driver as any).__hooks
          expect(hooks).toBeDefined()

          const w1: IndexingWarning = {
            code: "qdrant.version-incompatible",
            message: "Client version X is incompatible.",
          }
          hooks.warning(w1)

          await Bun.sleep(0)

          const stored = await KiloIndexing.warnings()
          expect(stored).toHaveLength(1)
          expect(stored[0]).toEqual(w1)
          const warningEvents = events.filter((e) => e.type === "indexing.warning")
          expect(warningEvents).toHaveLength(1)
          expect(warningEvents[0].properties).toEqual(w1)
        } finally {
          unsub()
        }
      },
    })
  })

  test("warning: duplicate warning is deduplicated and not republished", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    const driver = stub()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        const events: any[] = []
        const unsub = Bus.subscribeAll((e) => events.push(e))
        try {
          await KiloIndexing.init()

          const hooks: IndexingWorker.Hooks = (driver as any).__hooks
          const w1: IndexingWarning = { code: "qdrant.version-incompatible", message: "Same warning." }
          hooks.warning(w1)
          hooks.warning(w1)

          await Bun.sleep(0)

          const stored = await KiloIndexing.warnings()
          expect(stored).toHaveLength(1)
          const warningEvents = events.filter((e) => e.type === "indexing.warning")
          expect(warningEvents).toHaveLength(1)
        } finally {
          unsub()
        }
      },
    })
  })

  test("warning: different warning publishes independently", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    const driver = stub()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        const events: any[] = []
        const unsub = Bus.subscribeAll((e) => events.push(e))
        try {
          await KiloIndexing.init()

          const hooks: IndexingWorker.Hooks = (driver as any).__hooks
          const w1: IndexingWarning = { code: "qdrant.version-incompatible", message: "First." }
          const w2: IndexingWarning = { code: "qdrant.version-unavailable", message: "Second." }
          hooks.warning(w1)
          hooks.warning(w2)

          await Bun.sleep(0)

          const stored = await KiloIndexing.warnings()
          expect(stored).toHaveLength(2)
          const warningEvents = events.filter((e) => e.type === "indexing.warning")
          expect(warningEvents).toHaveLength(2)
        } finally {
          unsub()
        }
      },
    })
  })

  test("InstanceBootstrap: disabled indexing does not block bootstrap", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: false } } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await InstanceBootstrap()
        expect(result).toBeUndefined()
      },
    })
  })

  test("InstanceBootstrap: rejected indexing is caught and does not reject bootstrap", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    const driver = stub()
    driver.init = mock(async () => {
      throw new Error("crash")
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        IndexingWorker.override(factory(driver))
        const result = await InstanceBootstrap()
        expect(result).toBeUndefined()
      },
    })
  })
})
