// Pins the anonymous-author redaction on the intel (Course Alumni Intelligence) reads
// in src/lib/supabase/queries.ts.
//
// Incident: `is_anonymous` was only a DISPLAY flag. The cards hid the name, but the
// joined `author` profile and the raw `author_id` still rode along in the RSC payload,
// so any viewer could read the real author in DevTools. On the professor-facing intel
// page that identifies the students who reviewed that professor. The fix redacts on the
// way out of the query, which is the only place that covers every consumer at once.
//
// redactAnonymousAuthors() is module-private, so these exercise it through the five
// public getters that call it — which is also what actually matters: a regression here
// is far more likely to be "someone added a sixth getter / dropped the call from one"
// than "the helper's logic broke". Each getter is asserted separately for that reason.
//
// The second half of the invariant is just as load-bearing as the first: the VIEWER'S
// OWN anonymous rows must keep their identity, because the UI derives the edit/delete
// affordance (`isOwn`) from author_id. Over-redacting silently removes the author's
// ability to manage their own post.

import { describe, it, expect } from 'vitest'
import { intelQueries } from '@/lib/supabase/queries'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any

const VIEWER = 'viewer-user-id'
const OTHER = 'other-student-id'

/** Author profile as the `author:profiles!...` join returns it. */
const profile = (id: string, name: string) => ({ id, name, avatar_url: null })

/**
 * Minimal Supabase double. Every intel getter under test ends its chain on
 * `.order()`, so that is the one link that resolves.
 */
function fakeDb(rows: unknown[]): AnyDb {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = () => chain
  chain.order = async () => ({ data: rows, error: null })
  return { from: () => chain }
}

/** Three rows covering the whole decision table of the redaction. */
function threeRows(extra: Record<string, unknown> = {}) {
  return [
    {
      id: 'row-anon-other',
      body: 'anonymous post by someone else',
      is_anonymous: true,
      author_id: OTHER,
      author: profile(OTHER, 'Jane Student'),
      ...extra,
    },
    {
      id: 'row-anon-mine',
      body: 'anonymous post by the viewer',
      is_anonymous: true,
      author_id: VIEWER,
      author: profile(VIEWER, 'The Viewer'),
      ...extra,
    },
    {
      id: 'row-named',
      body: 'a signed post',
      is_anonymous: false,
      author_id: OTHER,
      author: profile(OTHER, 'Jane Student'),
      ...extra,
    },
  ]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const byId = (rows: any[], id: string) => rows.find((r) => r.id === id)

/**
 * The full invariant, asserted the same way for each getter.
 * Split into three named expectations so a failure says which half broke.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assertRedaction(rows: any[]) {
  const anonOther = byId(rows, 'row-anon-other')
  const anonMine = byId(rows, 'row-anon-mine')
  const named = byId(rows, 'row-named')

  // 1. Someone else's anonymous row: identity gone, content intact.
  expect(anonOther.author_id).toBeNull()
  expect(anonOther.author).toBeNull()
  expect(anonOther.body).toBe('anonymous post by someone else')
  expect(anonOther.is_anonymous).toBe(true)

  // 2. The viewer's OWN anonymous row: identity kept, or `isOwn` breaks.
  expect(anonMine.author_id).toBe(VIEWER)
  expect(anonMine.author).toEqual(profile(VIEWER, 'The Viewer'))

  // 3. A non-anonymous row is untouched.
  expect(named.author_id).toBe(OTHER)
  expect(named.author).toEqual(profile(OTHER, 'Jane Student'))

  // 4. Nothing anywhere in the payload still names the redacted author. This is the
  //    assertion that mirrors the actual attack (reading the RSC payload), rather
  //    than only the two properties we happened to think of.
  const serialized = JSON.stringify(rows.filter((r) => r.id === 'row-anon-other'))
  expect(serialized).not.toContain('Jane Student')
  expect(serialized).not.toContain(OTHER)
}

describe('intelQueries.getReviews — anonymous authors are redacted', () => {
  it('nulls the author of others\' anonymous reviews and keeps the viewer\'s own', async () => {
    const rows = await intelQueries.getReviews(fakeDb(threeRows()), 'course-1', VIEWER)
    assertRedaction(rows)
  })
})

describe('intelQueries.getQuestions — anonymous authors are redacted', () => {
  /* The embedded answers now carry `status`, because getQuestions selects the full
     answer rows so they can actually be rendered (#705) and counts only the active
     ones (#741). The fixture includes a hidden answer for exactly that reason: a
     count that includes soft-deleted rows is the bug, and a fixture with no statuses
     could not tell the two apart. */
  /* The answer author is a THIRD identity on purpose. Reusing OTHER would put that id
     in the payload legitimately — as the public author of a non-anonymous answer —
     and assertRedaction's "nothing names the redacted author" check could no longer
     tell that apart from an actual leak of the question's author. */
  const ANSWERER = 'answering-student-id'
  const answers = [
    { id: 'a1', status: 'active', is_anonymous: false, author_id: ANSWERER, author: profile(ANSWERER, 'Sam Answerer'), votes: [] },
    { id: 'a2', status: 'active', is_anonymous: false, author_id: ANSWERER, author: profile(ANSWERER, 'Sam Answerer'), votes: [] },
    { id: 'a3', status: 'hidden', is_anonymous: false, author_id: ANSWERER, author: profile(ANSWERER, 'Sam Answerer'), votes: [] },
  ]

  it('redacts while still deriving answer_count', async () => {
    const rows = await intelQueries.getQuestions(fakeDb(threeRows({ answers })), 'course-1', VIEWER)
    assertRedaction(rows)
    // The redaction is layered over the answer_count mapping — neither may eat the other.
    expect(byId(rows, 'row-anon-other').answer_count).toBe(2)
    expect(byId(rows, 'row-anon-other').answers).toBeUndefined()
  })

  it('excludes soft-deleted answers from both the count and the rendered list (#741, #705)', async () => {
    const rows = await intelQueries.getQuestions(fakeDb(threeRows({ answers })), 'course-1', VIEWER)
    const row = byId(rows, 'row-named')
    // Three answer rows exist, one is hidden — so the card must offer 2 and show 2.
    expect(row.answer_count).toBe(2)
    expect(row.loadedAnswers).toHaveLength(2)
    expect(row.loadedAnswers.map((a: { id: string }) => a.id)).not.toContain('a3')
  })

  it('redacts the author of an anonymous ANSWER, not just the question (#705)', async () => {
    const anonAnswer = {
      id: 'a-anon',
      status: 'active',
      is_anonymous: true,
      author_id: OTHER,
      author: profile(OTHER, 'Jane Student'),
      votes: [],
    }
    const rows = await intelQueries.getQuestions(
      fakeDb(threeRows({ answers: [anonAnswer] })),
      'course-1',
      VIEWER,
    )
    // Embedding the answers made a second identity leak reachable — the answer's own
    // author. course_answers.is_anonymous is a real, populated flag.
    const answer = byId(rows, 'row-named').loadedAnswers[0]
    expect(answer.author_id).toBeNull()
    expect(answer.author).toBeNull()
    expect(JSON.stringify(answer)).not.toContain('Jane Student')
  })
})

describe('intelQueries.getTips — anonymous authors are redacted', () => {
  it('redacts while still deriving vote_count and sorting by it', async () => {
    const rows = await intelQueries.getTips(
      fakeDb(threeRows({ votes: [{ id: 'v1' }] })),
      'course-1',
      VIEWER,
    )
    assertRedaction(rows)
    expect(byId(rows, 'row-anon-other').vote_count).toBe(1)
    expect(byId(rows, 'row-anon-other').votes).toBeUndefined()
  })
})

describe('intelQueries.getResources — anonymous authors are redacted', () => {
  it('nulls the author of others\' anonymous resources', async () => {
    const rows = await intelQueries.getResources(fakeDb(threeRows()), 'course-1', VIEWER)
    assertRedaction(rows)
  })
})

describe('intelQueries.getProfessorInsights — anonymous authors are redacted', () => {
  it('nulls the AUTHOR but never the professor the insight is about', async () => {
    const prof = profile('prof-1', 'Dr. Reviewed')
    const rows = await intelQueries.getProfessorInsights(
      fakeDb(threeRows({ professor_id: 'prof-1', professor: prof })),
      'course-1',
      VIEWER,
    )

    // The author side is the confidential one — this is the page where leaking it
    // tells a professor which students reviewed them.
    expect(byId(rows, 'row-anon-other').author_id).toBeNull()
    expect(byId(rows, 'row-anon-other').author).toBeNull()
    expect(byId(rows, 'row-anon-mine').author_id).toBe(VIEWER)

    // The professor join is the SUBJECT of the insight, not its author. Redacting it
    // too would empty the card — an over-broad "null every profile join" fix.
    for (const row of rows) {
      expect(row.professor).toEqual(prof)
      expect(row.professor_id).toBe('prof-1')
    }
  })
})

describe('intel redaction — edge cases', () => {
  it('returns [] on a query error without throwing', async () => {
    const errDb = {
      from: () => {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.order = async () => ({ data: null, error: { message: 'boom' } })
        return chain
      },
    } as AnyDb
    expect(await intelQueries.getReviews(errDb, 'course-1', VIEWER)).toEqual([])
  })

  it('handles an anonymous row with a null author_id (no viewer match to make)', async () => {
    const rows = await intelQueries.getReviews(
      fakeDb([{ id: 'r', is_anonymous: true, author_id: null, author: profile('x', 'X') }]),
      'course-1',
      VIEWER,
    )
    expect(rows[0].author).toBeNull()
    expect(rows[0].author_id).toBeNull()
  })

  it('redacts nothing when there is no viewer match and nothing is anonymous', async () => {
    const rows = await intelQueries.getReviews(
      fakeDb([{ id: 'r', is_anonymous: false, author_id: OTHER, author: profile(OTHER, 'Jane') }]),
      'course-1',
      VIEWER,
    )
    expect(rows[0].author_id).toBe(OTHER)
  })
})
