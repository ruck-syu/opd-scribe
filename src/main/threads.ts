import { availableParallelism } from 'node:os'

/** A configured thread count, or automatic (all cores but one) when the setting is 0 or unset. */
export function threadCount(configured: number | undefined): number {
  return configured && configured > 0 ? Math.floor(configured) : Math.max(1, availableParallelism() - 1)
}
