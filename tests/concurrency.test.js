import { describe, it, expect } from 'vitest'
import { mapSettledWithLimit } from '../src/utils/concurrency.js'
import { timeoutSignal } from '../src/utils/http.js'

describe('mapSettledWithLimit', () => {
  it('never runs more than `limit` at once and keeps the order', async () => {
    let running = 0
    let peak = 0
    const results = await mapSettledWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async n => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 5))
      running--
      if (n === 4) throw new Error('boom')
      return n * 2
    })

    expect(peak).toBe(3)
    expect(results.map(r => r.status)).toEqual([
      'fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled',
    ])
    expect(results[6].value).toBe(14)
  })

  it('copes with an empty list', async () => {
    expect(await mapSettledWithLimit([], 4, async () => 1)).toEqual([])
  })
})

describe('timeoutSignal', () => {
  it('fires after the deadline', async () => {
    const t = timeoutSignal(5)
    await new Promise(r => setTimeout(r, 20))
    expect(t.signal.aborted).toBe(true)
  })

  it('follows the parent signal', () => {
    const parent = new AbortController()
    const t = timeoutSignal(10000, parent.signal)
    parent.abort()
    expect(t.signal.aborted).toBe(true)
    t.clear()
  })
})
