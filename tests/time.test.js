import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { relativeTime } from '../src/utils/time.js'

const t = (key, params) => {
  const map = {
    'time.justNow': 'Gerade eben',
    'time.minutesAgo': `vor ${params?.n} Min.`,
    'time.hoursAgo': `vor ${params?.n} Std.`,
    'time.daysAgo': `vor ${params?.n} Tagen`,
  }
  return map[key] || key
}

describe('relativeTime', () => {
  it('returns "justNow" for < 1 minute', () => {
    const iso = new Date(Date.now() - 30_000).toISOString()
    expect(relativeTime(iso, t)).toBe('Gerade eben')
  })

  it('returns minutes for < 1 hour', () => {
    const iso = new Date(Date.now() - 10 * 60_000).toISOString()
    expect(relativeTime(iso, t)).toBe('vor 10 Min.')
  })

  it('returns hours for < 24 hours', () => {
    const iso = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
    expect(relativeTime(iso, t)).toBe('vor 3 Std.')
  })

  it('returns days for >= 24 hours', () => {
    const iso = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString()
    expect(relativeTime(iso, t)).toBe('vor 2 Tagen')
  })
})
