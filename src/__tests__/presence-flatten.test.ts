// The "N students present" count is derived from flattenPresenceState, which
// collapses Supabase's raw presence map to one entry per user. A regression
// here would over- or under-count students on the professor dashboard
// (e.g. counting every browser tab as a separate student).
import { describe, it, expect } from 'vitest'
import {
  flattenPresenceState,
  type PresenceState,
} from '@/lib/live-classroom/broadcast/use-presence'

const prof: PresenceState = { userId: 'p1', role: 'professor', name: 'Prof' }
const s1: PresenceState = { userId: 's1', role: 'student', name: 'Ann' }
const s2: PresenceState = { userId: 's2', role: 'student', name: 'Bo' }

describe('flattenPresenceState', () => {
  it('returns one entry per presence key', () => {
    const out = flattenPresenceState({ p1: [prof], s1: [s1], s2: [s2] })
    expect(out).toHaveLength(3)
    expect(out.map((u) => u.userId).sort()).toEqual(['p1', 's1', 's2'])
  })

  it('counts a multi-tab user once, keeping the most recent entry', () => {
    const s1OtherTab: PresenceState = { ...s1, name: 'Ann (tab 2)' }
    const out = flattenPresenceState({ s1: [s1, s1OtherTab] })
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Ann (tab 2)')
  })

  it('lets the caller derive a students-only count', () => {
    const out = flattenPresenceState({ p1: [prof], s1: [s1], s2: [s2] })
    expect(out.filter((u) => u.role === 'student')).toHaveLength(2)
  })

  it('skips empty or malformed key buckets without throwing', () => {
    const out = flattenPresenceState({ p1: [prof], empty: [], junk: [{}] })
    expect(out.map((u) => u.userId)).toEqual(['p1'])
  })

  it('returns an empty array when no one is present', () => {
    expect(flattenPresenceState({})).toEqual([])
  })
})
