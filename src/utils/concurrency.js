/**
 * Runs `worker` over `items` with at most `limit` in flight — Promise.allSettled
 * semantics (never rejects, one result per item, in order). Fifty feeds fired at once
 * saturate a phone's connection pool and make every single one slower.
 */
export async function mapSettledWithLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0

  async function lane() {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}
