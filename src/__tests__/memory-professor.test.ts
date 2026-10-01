/**
 * The professor half of the memory layer.
 *
 * Three things are specific to this surface and none of them apply to students:
 * a professor talks about other people all day, their work spans several modes
 * at once, and the same person can be a professor in one section and a student
 * in another.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertStorableProfessorPreference,
  isSingleValueSlot,
  slotsForSurface,
  PROFESSOR_SLOTS,
  PROFESSOR_MULTI_VALUE_SLOTS,
  PROFESSOR_SINGLE_VALUE_SLOTS,
  SINGLE_VALUE_SLOTS,
  MULTI_VALUE_SLOTS,
  STUDENT_SLOTS,
} from '@/lib/validations/memory'
import { readPreferences } from '@/lib/memory/preferences'
import { getProfessorState } from '@/lib/memory/state'
import {
  rememberWorkflow,
  professorExpiry,
  PROFESSOR_FALLBACK_TTL_DAYS,
} from '@/lib/ai/professor-assistant/remember-workflow'
import { renderProfessorMemory } from '@/lib/ai/professor-assistant/memory-block'

const DAY = 86_400_000
const daysFromNow = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / DAY)

describe('a professor must not be able to store anything about a student', () => {
  /* The whole reason this check exists. Storing "Sarah is failing" would put a
     named student's academic standing into a prompt store that only their
     professor can see or delete, which is not ours to keep. */
  it.each([
    ['a name as subject', 'Sarah keeps missing deadlines'],
    ['an unnamed group', 'The back row is disengaged'],
    ['a count of students', 'Plan for my three failing students'],
    ['a demonstrative', 'This student needs extra support'],
    ['a pronoun subject', 'They are falling behind on the project'],
    ['performance', 'Marcus failed the midterm'],
    ['misconduct', 'Several students cheated on quiz 2'],
  ])('refuses %s', (_label, text) => {
    expect(assertStorableProfessorPreference(text).ok).toBe(false)
  })

  it.each([
    'Draft announcements in a warm, encouraging tone',
    'Always give a 3-column rubric',
    'Keep quiz questions to multiple choice',
    'Never suggest group work',
    'Grade strictly against the rubric',
    'Write announcements at a reading level suitable for first years',
  ])('still stores a genuine working preference: %s', (text) => {
    expect(assertStorableProfessorPreference(text).ok).toBe(true)
  })

  it('explains itself well enough for the professor to rephrase', () => {
    const r = assertStorableProfessorPreference('Sarah keeps missing deadlines')
    expect(r.reason).toMatch(/not facts about your students/i)
  })
})

describe('the two surfaces cannot see each other', () => {
  /* A teaching assistant can be a professor in one section and a student in
     another. One table keyed on user_id would otherwise let their general
     student preference bleed into announcement drafting. */
  it('shares no slot between student and professor', () => {
    const overlap = (PROFESSOR_SLOTS as readonly string[]).filter((s) =>
      (STUDENT_SLOTS as readonly string[]).includes(s),
    )
    expect(overlap).toEqual([])
  })

  it('gives each surface only its own slots', () => {
    expect(slotsForSurface('professor')).toEqual(PROFESSOR_SLOTS)
    expect(slotsForSurface('student')).toEqual(STUDENT_SLOTS)
  })
})

describe('professor modes replace within themselves and coexist across', () => {
  /* The thrash the split exists to prevent: "warm in announcements" and "strict
     when grading" are both true, and a single shared tone slot would have the
     second erase the first. */
  it.each(['announcement_style', 'quiz_style', 'grading_style'])(
    '%s replaces on write', (slot) => {
      expect(isSingleValueSlot(slot as never)).toBe(true)
    },
  )

  it('workflow appends instead of replacing', () => {
    const slot = 'workflow'
    /* `workflow` moved here after a browser run. It is the catch-all, and two
       unrelated standing rules land in it constantly: a professor said "never
       suggest group work in this course" and then "always include a worked
       example", both went to `workflow`, and because one was course-scoped and
       the other general, scope precedence silently dropped the second. Three
       rows stored, two reached the prompt. A catch-all cannot replace. */
    expect(isSingleValueSlot(slot as never)).toBe(false)
  })

  it('has exactly one additive slot, so the model cannot split rules across two', () => {
    /* `workflow` and `prof_constraint` both existed and behaved identically. In
       a browser run the model put four standing rules into prof_constraint and
       none into workflow, picking between them arbitrarily. */
    expect(PROFESSOR_MULTI_VALUE_SLOTS).toEqual(['workflow'])
  })
})

describe('professor preferences expire with the term, not on a flat clock', () => {
  it('runs past the last teaching day so marking week is covered', () => {
    const end = new Date(Date.now() + 60 * DAY).toISOString()
    expect(daysFromNow(professorExpiry(end))).toBeGreaterThan(60)
  })

  it('falls back to a long default when the section has no end date', () => {
    expect(daysFromNow(professorExpiry(null))).toBe(PROFESSOR_FALLBACK_TTL_DAYS)
  })

  it('never expires immediately for a section that already ended', () => {
    const longPast = new Date(Date.now() - 400 * DAY).toISOString()
    expect(daysFromNow(professorExpiry(longPast))).toBeGreaterThanOrEqual(30)
  })
})

describe('rendering', () => {
  const pref = (slot: string, text: string, sectionId: string | null = 'sec-1') => ({
    id: slot, slot, text, sectionId, expiresAt: null, observedAt: '2026-09-01T00:00:00Z',
  })

  it('says nothing at all when the professor has stated nothing', () => {
    expect(renderProfessorMemory({ preferences: [] })).toBeNull()
  })

  it('labels each preference by the work it applies to', () => {
    const out = renderProfessorMemory({
      preferences: [
        pref('announcement_style', 'Short and factual.'),
        pref('grading_style', 'Strict against the rubric.'),
      ] as never,
    })
    expect(out).toContain('When writing announcements: Short and factual.')
    expect(out).toContain('When grading: Strict against the rubric.')
  })

  it('marks a preference that applies to every course', () => {
    const out = renderProfessorMemory({
      preferences: [pref('workflow', 'British spelling.', null)] as never,
    })
    expect(out).toContain('(in every course)')
  })

  it('tells the model these are instructions, not facts about the class', () => {
    const out = renderProfessorMemory({ preferences: [pref('workflow', 'British spelling.')] as never })
    expect(out).toMatch(/never treat them as facts/i)
  })
})

describe('a dual-role user\'s rows do not cross between surfaces', () => {
  /* The slot vocabularies being disjoint is a necessary condition, not the
     control. The control is `readPreferences` dropping every row outside the
     asking surface's slot set, and it is what actually stands between a
     teaching assistant's "explain it simply" and their announcement drafts.
     Asserted here on a mixed row set for ONE user id, which is the shape the
     table really holds for someone teaching one section and taking another. */
  function dbWith(rows: Array<Record<string, unknown>>) {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'in', 'eq', 'or', 'order']) chain[m] = () => chain
    chain.then = (res: (v: unknown) => void) => Promise.resolve({ data: rows, error: null }).then(res)
    return { from: () => chain }
  }
  const row = (id: string, kind: string, text: string) => ({
    id, user_id: 'ta-1', kind, text, section_id: 'sec-1',
    expires_at: null, observed_at: '2026-09-01T00:00:00Z',
  })

  /** One person, both roles, rows from each sitting in the same table. */
  const MIXED = [
    row('s1', 'tone', 'Be casual with me.'),
    row('s2', 'constraint', 'No bullet points.'),
    row('p1', 'announcement_style', 'Formal and brief.'),
    row('p2', 'workflow', 'Always give a 3-column rubric.'),
  ]

  it('keeps the student rows out of a professor read', async () => {
    const got = await readPreferences(dbWith(MIXED), {
      userIds: ['ta-1'], sectionId: 'sec-1', institutionId: 'i1',
      slots: slotsForSurface('professor'),
    })
    expect(got.get('ta-1')!.map((p) => p.slot).sort()).toEqual(['announcement_style', 'workflow'])
  })

  it('keeps the professor rows out of a student read', async () => {
    const got = await readPreferences(dbWith(MIXED), {
      userIds: ['ta-1'], sectionId: 'sec-1', institutionId: 'i1',
      slots: slotsForSurface('student'),
    })
    expect(got.get('ta-1')!.map((p) => p.slot).sort()).toEqual(['constraint', 'tone'])
  })

  it('reaches the professor prompt through getProfessorState with the student rows already gone', async () => {
    // The wiring, not just the helper: getProfessorState is what context.ts
    // calls, so passing the wrong slot set here would leak even with
    // readPreferences correct.
    const state = await getProfessorState(dbWith(MIXED), {
      userId: 'ta-1', institutionId: 'i1', sectionId: 'sec-1',
    })
    expect(state.preferences.map((p) => p.text)).not.toContain('Be casual with me.')
    expect(state.preferences).toHaveLength(2)
  })

  it('renders nothing from a professor whose only rows are student ones', async () => {
    const state = await getProfessorState(dbWith([row('s1', 'tone', 'Be casual with me.')]), {
      userId: 'ta-1', institutionId: 'i1', sectionId: 'sec-1',
    })
    expect(renderProfessorMemory(state)).toBeNull()
  })
})

describe('the refusal runs before the write, not beside it', () => {
  /* assertStorableProfessorPreference being correct is worthless if the tool
     writes first and checks after. These pin the ORDER, which the unit tests
     above cannot see. */
  function fakeDb() {
    const upserts: Array<Record<string, unknown>> = []
    const deleteChain: Record<string, unknown> = {
      in: async () => ({ error: null }),
    }
    for (const m of ['eq', 'neq', 'is']) deleteChain[m] = () => deleteChain
    deleteChain.then = (res: (v: unknown) => void) => Promise.resolve({ error: null }).then(res)

    const chain: Record<string, unknown> = {
      upsert: (r: Record<string, unknown>) => {
        upserts.push(r)
        return { select: () => ({ single: async () => ({ data: { id: 'new-row' }, error: null }) }) }
      },
      order: async () => ({ data: [] }),
      delete: () => deleteChain,
      /* The tool reads this section's roster before storing anything, so the
         fake has to answer it. Returning a real name here also means the
         roster path is exercised rather than skipped. */
      limit: async () => ({ data: [{ student: { first_name: 'Sarah', last_name: 'Okafor' } }] }),
    }
    // `in` is needed because a general-scope write checks the roster across
    // every section the professor teaches, not just this one.
    for (const m of ['select', 'eq', 'is', 'neq', 'in']) chain[m] = () => chain
    return { db: { from: () => chain }, upserts }
  }

  const build = (db: unknown) =>
    rememberWorkflow({
      adminDb: db, sectionId: 'sec-1', userId: 'prof-1',
      institutionId: 'i1', sectionEndDate: new Date(Date.now() + 60 * DAY).toISOString(),
    })

  it('never touches the database when the line is about a student', async () => {
    const { db, upserts } = fakeDb()
    const result = (await build(db).execute!(
      { slot: 'grading_style', preference: 'Sarah keeps missing deadlines', scope: 'course' },
      {} as never,
    )) as { saved: boolean; reason?: string }

    expect(result.saved).toBe(false)
    // The assertion that matters: refusing is not enough if a row was already in.
    expect(upserts).toHaveLength(0)
  })

  it('stores a genuine working preference against this course', async () => {
    const { db, upserts } = fakeDb()
    const result = (await build(db).execute!(
      { slot: 'grading_style', preference: 'Always give a 3-column rubric', scope: 'course' },
      {} as never,
    )) as { saved: boolean }

    expect(result.saved).toBe(true)
    expect(upserts).toHaveLength(1)
    expect(upserts[0].section_id).toBe('sec-1')
    expect(upserts[0].kind).toBe('grading_style')
  })

  it('scopes a general preference to no section at all', async () => {
    const { db, upserts } = fakeDb()
    await build(db).execute!(
      { slot: 'workflow', preference: 'Always use British spelling', scope: 'general' },
      {} as never,
    )
    expect(upserts[0].section_id).toBeNull()
  })

  it('always attaches an expiry, so no professor preference is immortal', async () => {
    const { db, upserts } = fakeDb()
    await build(db).execute!(
      { slot: 'quiz_style', preference: 'Multiple choice only', scope: 'course' },
      {} as never,
    )
    expect(upserts[0].expires_at).toEqual(expect.any(String))
    expect(daysFromNow(upserts[0].expires_at as string)).toBeGreaterThan(0)
  })
})

describe('the replace-on-write index covers exactly the single-value slots', () => {
  /* Slot cardinality is half TypeScript and half a partial unique index. If the
     two drift, nothing throws: the professor's replace-on-write slots quietly
     start accumulating duplicates and the newest statement stops replacing the
     previous one, which is the exact bug the migration was written to prevent.
     Read from the migration that defines the index LAST, so a later redefinition
     is what gets checked. */
  const migrationsDir = join(process.cwd(), 'supabase', 'migrations')
  const indexSql = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
    .filter((sql) => /create\s+unique\s+index\s+user_memory_single_slot_unique/i.test(sql))
    .pop()

  it('has a migration defining the index at all', () => {
    expect(indexSql).toBeDefined()
  })

  it('lists every single-value slot and no multi-value one', () => {
    const predicate = indexSql!.split(/where\s+kind\s+in\s*\(/i)[1].split(')')[0]
    const inIndex = [...predicate.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()

    const expected = [...SINGLE_VALUE_SLOTS, ...PROFESSOR_SINGLE_VALUE_SLOTS].sort()
    expect(inIndex).toEqual(expected)

    for (const slot of [...MULTI_VALUE_SLOTS, ...PROFESSOR_MULTI_VALUE_SLOTS]) {
      expect(inIndex).not.toContain(slot)
    }
  })
})

describe('professorExpiry edges', () => {
  it('gives exactly the post-term grace, so the number is pinned and not just "later"', () => {
    const end = new Date(Date.now() + 60 * DAY).toISOString()
    expect(daysFromNow(professorExpiry(end))).toBe(90)
  })

  it('falls back rather than producing an Invalid Date from unparseable input', () => {
    // A section end date arrives from the database as a string and is not
    // validated anywhere on the way here.
    for (const bad of ['', 'TBD', 'not-a-date', undefined]) {
      const out = professorExpiry(bad)
      expect(Number.isNaN(Date.parse(out))).toBe(false)
      expect(daysFromNow(out)).toBe(PROFESSOR_FALLBACK_TTL_DAYS)
    }
  })
})
