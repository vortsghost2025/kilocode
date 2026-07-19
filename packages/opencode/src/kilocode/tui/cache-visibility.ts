export type CacheCost = {
  input: number
  cache: {
    read: number
  }
  experimentalOver200K?: {
    input: number
    cache: {
      read: number
    }
  }
}

export type CacheMetrics = {
  share: string | undefined
  savings: number | undefined
}

export function formatCacheMetrics(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  cost?: CacheCost,
): CacheMetrics {
  const total = input + cacheRead + cacheWrite
  const share = total > 0 && cacheRead + cacheWrite > 0 ? `${Math.round((cacheRead / total) * 100)}%` : undefined

  let savings: number | undefined
  if (cost && cacheRead > 0) {
    const sel = cost.experimentalOver200K && input + cacheRead > 200_000 ? cost.experimentalOver200K : cost
    const diff = sel.input - sel.cache.read
    if (Number.isFinite(diff) && diff > 0) {
      savings = (cacheRead * diff) / 1_000_000
    }
  }

  return { share, savings }
}
