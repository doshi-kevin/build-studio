// Tests for buildEventColorMap — the professor calendar's course → color
// keying. The contracts that matter (and would silently break event coloring
// if they drift): the mapping is STABLE for a given input order, duplicate
// course ids collapse to one slot, the 5-token palette cycles by modulo past
// the 5th course, and the '__general__' fallback key is always present.

import { describe, it, expect } from 'vitest'
import { buildEventColorMap, GENERAL_EVENT_COLOR } from '@/components/professor/calendar/event-colors'

describe('buildEventColorMap', () => {
  it('assigns the palette in order for the first five courses', () => {
    const map = buildEventColorMap(['a', 'b', 'c', 'd', 'e'])
    expect(map['a'].dot).toBe('bg-chart-1')
    expect(map['b'].dot).toBe('bg-chart-2')
    expect(map['c'].dot).toBe('bg-chart-3')
    expect(map['d'].dot).toBe('bg-chart-4')
    expect(map['e'].dot).toBe('bg-chart-5')
  })

  it('cycles the 5-token palette by modulo for the sixth+ course', () => {
    const map = buildEventColorMap(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    // 6th wraps to chart-1, 7th to chart-2
    expect(map['f'].dot).toBe('bg-chart-1')
    expect(map['g'].dot).toBe('bg-chart-2')
  })

  it('collapses duplicate course ids to a single (first-seen) slot', () => {
    const map = buildEventColorMap(['a', 'a', 'b'])
    // 'a' keeps index 0, 'b' takes the next slot (index 1) — duplicates do not
    // consume a palette slot.
    expect(map['a'].dot).toBe('bg-chart-1')
    expect(map['b'].dot).toBe('bg-chart-2')
  })

  it('always includes the __general__ fallback color', () => {
    expect(buildEventColorMap([])['__general__']).toEqual(GENERAL_EVENT_COLOR)
    expect(buildEventColorMap(['a'])['__general__']).toEqual(GENERAL_EVENT_COLOR)
  })

  it('is stable: same input order yields the same mapping', () => {
    const ids = ['x', 'y', 'z']
    expect(buildEventColorMap(ids)).toEqual(buildEventColorMap(ids))
  })
})
