// Tests for the roadmap Archive's pure half (src/lib/roadmap/archive.ts).
//
// Archiving is a VIEW decision: nothing is deleted and no placement is touched,
// so the whole feature rests on two invariants these tests pin down.
//
//  1. CONSERVATION — for any set of archived keys, every keyed node in the input
//     ends up in exactly one of two places: the map (stripArchived) or the tray
//     (collectArchived). A node that falls out of both is silently gone from the
//     professor's course with no way to put it back; a node in both is drawn
//     twice. This is why collectArchived reads the UNFILTERED course.
//  2. REFERENTIAL IDENTITY — an empty (or irrelevant) Archive must return the
//     very same array, because the canvas feeds it straight into the
//     computeLayout / computeEdges useMemos. A fresh array there rebuilds the
//     whole node graph on every render and React Flow tears down its connectors.
//
// ARCHIVABLE_NODE_KEY is the untrusted-input gate on a value that gets persisted
// into course_sections.settings, so it is checked against the key shapes the
// adapter actually mints (via nodeKey) rather than against hand-written strings —
// a new node kind that starts appearing in the drawer must not be silently
// unarchivable.

import { describe, it, expect } from 'vitest'
import {
  ARCHIVABLE_NODE_KEY,
  MAX_ARCHIVED,
  ROADMAP_ARCHIVED_KEY,
  readArchivedKeys,
  stripArchived,
  collectArchived,
} from '@/lib/roadmap/archive'
import { nodeKey } from '@/lib/roadmap/node-drawer'
import type { CourseModule, Resource, Session } from '@/lib/roadmap/prototype-adapter'

// ── fixtures ─────────────────────────────────────────────────────
const UUID = '00000000-0000-4000-8000-000000000001'

const res = (key: string, t = key): Resource => ({ k: 'lecture', t, s: '', st: '', key })
const sess = (key: string, t = key): Session => ({ t, s: '', key })

function mod(o: Partial<CourseModule> & { title: string }): CourseModule {
  return { pct: 0, materials: [], quizzes: [], assignments: [], ...o }
}

/** Every keyed node in a course + unplaced pile, as `key` strings. */
function allKeys(course: CourseModule[], unplaced: Resource[] = []): string[] {
  const out = unplaced.map((r) => r.key).filter((k): k is string => !!k)
  for (const m of course) {
    for (const r of [...m.materials, ...m.quizzes, ...m.assignments]) if (r.key) out.push(r.key)
    for (const s of [...(m.sessions ?? []), ...(m.liveRoom ? [m.liveRoom] : [])]) if (s.key) out.push(s.key)
  }
  return out
}

/** A course touching every lane stripArchived/collectArchived have to walk. */
const COURSE: CourseModule[] = [
  mod({
    title: 'Week 1',
    materials: [res('module_item:m1'), res('module_item:m2')],
    quizzes: [res('quiz:q1')],
    assignments: [res('assignment:a1')],
    sessions: [sess('live_session:s1')],
  }),
  mod({
    title: 'Week 2',
    live: true,
    liveRoom: sess('live_session:room2'),
    materials: [res('module_item:m3')],
    sessions: [sess('live_session:s2')],
  }),
  mod({ title: 'Week 3', materials: [res('module_item:m4')] }),
]
const UNPLACED: Resource[] = [res('quiz:loose1'), res('assignment:loose2')]

describe('readArchivedKeys — tolerating whatever is in settings', () => {
  it('returns [] for every non-list shape settings can arrive in', () => {
    for (const settings of [
      undefined,
      null,
      {},
      { [ROADMAP_ARCHIVED_KEY]: null },
      { [ROADMAP_ARCHIVED_KEY]: 'quiz:q1' },     // a bare string, not a list
      { [ROADMAP_ARCHIVED_KEY]: 7 },
      { [ROADMAP_ARCHIVED_KEY]: { 'quiz:q1': true } },
    ]) {
      expect(readArchivedKeys(settings)).toEqual([])
    }
  })

  it('drops non-string entries instead of letting them reach the key Set', () => {
    // A Set built from these would hold numbers/objects that can never match a
    // node key, so a garbage row would quietly inflate the tray's size check.
    expect(readArchivedKeys({ [ROADMAP_ARCHIVED_KEY]: ['quiz:q1', 3, null, { k: 1 }, 'quiz:q2', undefined] }))
      .toEqual(['quiz:q1', 'quiz:q2'])
  })

  it('ignores the section\'s other settings keys', () => {
    const settings = { enabledFeatures: ['quizzes'], sidebarOrder: ['a'], [ROADMAP_ARCHIVED_KEY]: ['quiz:q1'] }
    expect(readArchivedKeys(settings)).toEqual(['quiz:q1'])
  })
})

describe('ARCHIVABLE_NODE_KEY — the persisted-input gate', () => {
  it('accepts every drawer node kind that can carry an archive action', () => {
    // These are the kinds detailForNode returns with a `key` on the PROFESSOR
    // map (module bands toggle instead of opening; athena artifacts are
    // student-only). If a kind is added to that list and not here, archiving it
    // fails with "That node can't be archived" and the button is dead.
    for (const type of ['module_item', 'quiz', 'assignment', 'live_session'] as const) {
      expect(ARCHIVABLE_NODE_KEY.test(nodeKey(type, UUID))).toBe(true)
    }
  })

  it('rejects keys whose id is not a 36-char uuid', () => {
    expect(ARCHIVABLE_NODE_KEY.test('quiz:')).toBe(false)
    expect(ARCHIVABLE_NODE_KEY.test(`quiz:${UUID.slice(0, 35)}`)).toBe(false)
    expect(ARCHIVABLE_NODE_KEY.test(`quiz:${UUID}0`)).toBe(false)
    expect(ARCHIVABLE_NODE_KEY.test('quiz:zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toBe(false)
  })

  it('rejects an unknown prefix, so a made-up kind cannot be stored', () => {
    expect(ARCHIVABLE_NODE_KEY.test(`athena_artifact:${UUID}`)).toBe(false)
    expect(ARCHIVABLE_NODE_KEY.test(`enabledFeatures:${UUID}`)).toBe(false)
    expect(ARCHIVABLE_NODE_KEY.test(UUID)).toBe(false)
  })

  it('is anchored, so no prefix/suffix can smuggle a payload past it', () => {
    // Unanchored, any of these would match — and each is a string that would
    // then be written verbatim into the section's settings jsonb.
    for (const bad of [
      `x quiz:${UUID}`,
      `quiz:${UUID} x`,
      `quiz:${UUID}\nquiz:${UUID}`,
      `<script>quiz:${UUID}`,
      `quiz:${UUID}/../..`,
    ]) {
      expect(ARCHIVABLE_NODE_KEY.test(bad)).toBe(false)
    }
  })

  it('MAX_ARCHIVED is a bounded ceiling on what settings can grow to', () => {
    expect(MAX_ARCHIVED).toBeGreaterThan(0)
    expect(Number.isFinite(MAX_ARCHIVED)).toBe(true)
  })
})

describe('stripArchived — referential identity (the layout-memo contract)', () => {
  it('returns the SAME array when nothing is archived', () => {
    expect(stripArchived(COURSE, new Set())).toBe(COURSE)
  })

  it('returns the SAME array when the archived keys match nothing on this map', () => {
    // e.g. only unplaced cards are archived — the course itself is untouched, so
    // computeLayout must not be handed a new array.
    expect(stripArchived(COURSE, new Set(['quiz:loose1', 'module_item:not-here']))).toBe(COURSE)
  })

  it('leaves the untouched modules identical by reference', () => {
    const out = stripArchived(COURSE, new Set(['module_item:m1']))
    expect(out).not.toBe(COURSE)
    expect(out[0]).not.toBe(COURSE[0])
    expect(out[1]).toBe(COURSE[1]) // no archived node in Week 2
    expect(out[2]).toBe(COURSE[2])
  })
})

describe('stripArchived — what leaves the map', () => {
  it('removes the archived card from its own lane and no other', () => {
    const out = stripArchived(COURSE, new Set(['module_item:m2', 'quiz:q1']))
    expect(out[0].materials.map((r) => r.key)).toEqual(['module_item:m1'])
    expect(out[0].quizzes).toEqual([])
    expect(out[0].assignments.map((r) => r.key)).toEqual(['assignment:a1'])
    expect(out[0].sessions?.map((s) => s.key)).toEqual(['live_session:s1'])
  })

  it('takes the `live` flag with the live room — the band must not draw a room that is gone', () => {
    // `live` is what renders the pulsing LIVE node; leaving it set after the
    // room has been archived draws a live class with nothing behind it.
    const out = stripArchived(COURSE, new Set(['live_session:room2']))
    expect(out[1].liveRoom).toBeUndefined()
    expect(out[1].live).toBe(false)
  })

  it('keeps `live` and the room when a DIFFERENT node in that module is archived', () => {
    const out = stripArchived(COURSE, new Set(['module_item:m3']))
    expect(out[1].live).toBe(true)
    expect(out[1].liveRoom).toBe(COURSE[1].liveRoom)
    expect(out[1].sessions?.map((s) => s.key)).toEqual(['live_session:s2'])
  })

  it('never mutates the input course', () => {
    const before = JSON.stringify(COURSE)
    stripArchived(COURSE, new Set(['module_item:m1', 'live_session:room2', 'quiz:q1']))
    expect(JSON.stringify(COURSE)).toBe(before)
  })
})

describe('collectArchived — what the tray shows', () => {
  it('returns [] for an empty Archive without walking the course', () => {
    expect(collectArchived(COURSE, UNPLACED, new Set(), [])).toEqual([])
  })

  it('finds an archived node in every lane it has to walk', () => {
    const keys = new Set(['module_item:m1', 'quiz:q1', 'assignment:a1', 'live_session:s1', 'live_session:room2', 'quiz:loose1'])
    const got = collectArchived(COURSE, UNPLACED, keys, [])
    expect(new Set(got.map((a) => a.key))).toEqual(keys)
  })

  it('labels an unplaced card "no week yet" and a placed one with its week', () => {
    const got = collectArchived(COURSE, UNPLACED, new Set(['quiz:loose1', 'module_item:m4']), [])
    expect(got.find((a) => a.key === 'quiz:loose1')?.where).toBe('no week yet')
    expect(got.find((a) => a.key === 'module_item:m4')?.where).toBe('Week 3')
  })

  it('prefers the professor-edited module title over the card\'s own', () => {
    // moduleTitles carries in-place renames; the tray sits outside the map's
    // context, so a stale title there is the only label the reader gets.
    const got = collectArchived(COURSE, [], new Set(['module_item:m1']), ['Renamed Week 1'])
    expect(got[0].where).toBe('Renamed Week 1')
    // …and falls back per-index when that title is absent.
    const partial = collectArchived(COURSE, [], new Set(['module_item:m4']), ['Renamed Week 1'])
    expect(partial[0].where).toBe('Week 3')
  })

  it('ignores keys that match nothing — no phantom card in the tray', () => {
    expect(collectArchived(COURSE, UNPLACED, new Set([`quiz:${UUID}`]), [])).toEqual([])
  })

  it('carries the node itself, tagged resource vs session', () => {
    const got = collectArchived(COURSE, [], new Set(['module_item:m1', 'live_session:s1']), [])
    const material = got.find((a) => a.key === 'module_item:m1')
    const session = got.find((a) => a.key === 'live_session:s1')
    expect(material && 'r' in material).toBe(true)
    expect(session && 's' in session).toBe(true)
    // isArchivedRes drives which card component renders, so the tag has to be
    // the real node, not a copy that lost its fields.
    expect(material && 'r' in material && material.r).toBe(COURSE[0].materials[0])
  })
})

describe('conservation — nothing vanishes between the map and the tray', () => {
  const every = allKeys(COURSE, UNPLACED)

  for (const key of allKeys(COURSE, UNPLACED)) {
    it(`archiving ${key} leaves it in the tray and off the map, everything else untouched`, () => {
      const keys = new Set([key])
      const onMap = allKeys(stripArchived(COURSE, keys), UNPLACED.filter((r) => r.key !== key))
      const inTray = collectArchived(COURSE, UNPLACED, keys, []).map((a) => a.key)

      expect(inTray).toEqual([key])
      expect(onMap).not.toContain(key)
      // union is still the whole course — no collateral removal
      expect([...onMap, ...inTray].sort()).toEqual([...every].sort())
    })
  }

  it('holds when EVERY node is archived at once', () => {
    const keys = new Set(every)
    const onMap = allKeys(stripArchived(COURSE, keys), [])
    const inTray = collectArchived(COURSE, UNPLACED, keys, []).map((a) => a.key)
    expect(onMap).toEqual([])
    expect(inTray.sort()).toEqual([...every].sort())
    // and the map still has all three bands — archiving a week's contents must
    // not delete the week.
    expect(stripArchived(COURSE, keys)).toHaveLength(3)
  })

  it('is why the tray reads the UNFILTERED course', () => {
    // Feeding the stripped course to collectArchived empties the tray, which is
    // the exact regression that would strand archived nodes with no way back.
    const keys = new Set(['module_item:m1'])
    expect(collectArchived(stripArchived(COURSE, keys), [], keys, [])).toEqual([])
    expect(collectArchived(COURSE, [], keys, [])).toHaveLength(1)
  })
})
