import { test, expect, describe } from "bun:test"
import { formatCacheMetrics } from "../../src/kilocode/tui/cache-visibility"

describe("formatCacheMetrics", () => {
  test("zero cache returns undefined share and savings", () => {
    const r = formatCacheMetrics(100, 0, 0)
    expect(r.share).toBeUndefined()
    expect(r.savings).toBeUndefined()
  })

  test("normal cached-input share", () => {
    const r = formatCacheMetrics(1000, 4000, 0)
    expect(r.share).toBe("80%")
  })

  test("cache write included in denominator", () => {
    const r = formatCacheMetrics(1000, 4000, 1000)
    expect(r.share).toBe("67%")
  })

  test("standard cache-read savings", () => {
    const r = formatCacheMetrics(1000, 4000, 0, {
      input: 3,
      cache: { read: 0.3 },
    })
    expect(r.share).toBe("80%")
    expect(r.savings).toBeCloseTo((4000 * (3 - 0.3)) / 1_000_000, 10)
  })

  test("no negative savings when cache-read rate exceeds input rate", () => {
    const r = formatCacheMetrics(1000, 4000, 0, {
      input: 1,
      cache: { read: 2 },
    })
    expect(r.savings).toBeUndefined()
  })

  test("missing pricing returns undefined savings", () => {
    const r = formatCacheMetrics(1000, 4000, 0, undefined)
    expect(r.share).toBe("80%")
    expect(r.savings).toBeUndefined()
  })

  test("experimental-over-200K pricing selection when threshold exceeded", () => {
    const r = formatCacheMetrics(180_000, 50_000, 0, {
      input: 3,
      cache: { read: 0.3 },
      experimentalOver200K: {
        input: 6,
        cache: { read: 0.6 },
      },
    })
    expect(r.savings).toBeCloseTo((50_000 * (6 - 0.6)) / 1_000_000, 10)
  })

  test("experimental-over-200K pricing selection when threshold not exceeded", () => {
    const r = formatCacheMetrics(10_000, 5_000, 0, {
      input: 3,
      cache: { read: 0.3 },
      experimentalOver200K: {
        input: 6,
        cache: { read: 0.6 },
      },
    })
    expect(r.savings).toBeCloseTo((5_000 * (3 - 0.3)) / 1_000_000, 10)
  })
})
