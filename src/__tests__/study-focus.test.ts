// buildStudyFocus decides where a student is physically sent: the route takes
// focus[0] and pushes the roadmap to that node. So the ranking is not advisory
// text — it is navigation, and getting it backwards walks the student to the
// material they already know while their weakest lecture stays unopened.
//
// Two classes of failure worth pinning: the ORDER (weakest first, and within a
// state the lowest measured mastery first) and the FILTER (never send them
// somewhere there is nothing to do — mastered, checked off, dividers, or nodes
// that aren't material at all). The per-student lookup is here too: the score
// map is built for the whole section, so a dropped `.get(userId)` would hand one
// student another's standing.

import { describe, it, expect, vi } from 'vitest'

const SECTION = 'sec-1'
const STUDENT = 'student-1'
const OTHER = 'student-2'
/** Enrolled but never assessed — absent from both mastery maps. */
const UNASSESSED = 'student-3'

// The curated-mastery aggregation has its own suite; what matters here is that
// each student is looked up in the map by their own id. The mock honours
// buildStudentMastery's `studentId` narrowing (the old buildStudentSkillScores
// export it stubbed was retired by main's mastery refactor — this drifted).
const SCORES = new Map([
  [STUDENT, new Map([['attention', 20], ['tokenization', 45], ['n-grams', 60], ['bleu', 90]])],
  // Mirror image: this student is strong exactly where student-1 is weak.
  [OTHER, new Map([['attention', 95], ['tokenization', 90], ['n-grams', 88], ['bleu', 10]])],
])
/** Each student's course-wide roll-up, which `buildStudyFocus` now carries out
 *  alongside the ranking. Distinct values per student so a lookup that ignored
 *  the caller's id would return the wrong one visibly. */
const OVERALL = new Map([
  [STUDENT, 54],
  [OTHER, 71],
])
vi.mock('@/lib/skills/roadmap-mastery', () => ({
  buildStudentMastery: async (_db: unknown, _sectionId: string, studentId?: string) => ({
    scoresByStudent: new Map([...SCORES].filter(([sid]) => !studentId || sid === studentId)),
    overallByStudent: new Map([...OVERALL].filter(([sid]) => !studentId || sid === studentId)),
  }),
}))

const { buildStudyFocus } = await import('@/lib/roadmap/study-focus')

type Row = Record<string, unknown>

/** Row-aware Supabase double: `.eq()`/`.in()` really filter, so dropping the
 *  published/visible/student scoping changes the rows the ranking sees. */
function stubDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      order: () => chain,
      // The unlock gate (openModuleFilter). Fixtures carry no unlock_date, so
      // every module reads as open — a pass-through keeps the ranking's rows.
      or: () => chain,
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val)
        return chain
      },
      in: (col: string, vals: unknown[]) => {
        rows = rows.filter((r) => vals.includes(r[col]))
        return chain
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    }
    return chain
  }
  return { from }
}

const MODULES: Row[] = [
  { id: 'mod-1', section_id: SECTION, is_published: true },
  { id: 'mod-draft', section_id: SECTION, is_published: false },
]

const item = (over: Row): Row => ({
  module_id: 'mod-1',
  is_visible: true,
  item_type: 'lecture',
  content: {},
  ...over,
})

const ITEMS: Row[] = [
  item({ id: 'i-ngram', title: 'N-gram models', content: { topics: ['N-grams'] } }),
  item({ id: 'i-attn', title: 'Attention', content: { topics: ['Attention'] } }),
  item({ id: 'i-tok', title: 'Tokenization', content: { topics: ['Tokenization'] } }),
  item({ id: 'i-bleu', title: 'Evaluation with BLEU', content: { topics: ['BLEU'] } }),
  item({ id: 'i-new', title: 'Diffusion for text', content: { topics: ['Diffusion'] } }),
  // Not material: a divider is a heading, and there is nothing to open.
  item({ id: 'i-div', title: '— Unit 2 —', item_type: 'section_divider' }),
  // Draws on the map but has NO detail card, so `?node=` can't open it.
  item({ id: 'i-note', title: 'Reading list', item_type: 'note' }),
  // Legacy shape: assignments are their own nodes now, never a material card.
  item({ id: 'i-legacy', title: 'Homework 1', item_type: 'assignment', content: { topics: ['Attention'] } }),
  // Hidden from students, and drafted modules are not on their roadmap at all.
  item({ id: 'i-hidden', title: 'Solutions', is_visible: false, content: { topics: ['Attention'] } }),
  item({ id: 'i-draft', title: 'Next term', module_id: 'mod-draft', content: { topics: ['Attention'] } }),
]

function studyFocusFor(userId: string, progress: Row[] = [], limit?: number) {
  const db = stubDb({
    modules: MODULES,
    module_items: ITEMS,
    roadmap_progress: progress,
  })
  return limit === undefined
    ? buildStudyFocus(db, SECTION, userId)
    : buildStudyFocus(db, SECTION, userId, limit)
}

/** The ranking alone — what every test below asserts on. The course-wide
 *  standing that now rides along is covered by its own test. */
async function focusFor(userId: string, progress: Row[] = [], limit?: number) {
  return (await studyFocusFor(userId, progress, limit)).nodes
}

describe('buildStudyFocus — what the student is sent to', () => {
  it('ranks weakest first, and within a state by lowest mastery', async () => {
    const focus = await focusFor(STUDENT, [], 10)

    // 20 before 45 (both review_next) before 60 (in_progress) before the
    // unmeasured ones — fixture order in the DB is deliberately none of these.
    expect(focus.map((n) => n.title)).toEqual([
      'Attention',
      'Tokenization',
      'N-gram models',
      'Diffusion for text',
    ])
    expect(focus.map((n) => n.state)).toEqual([
      'review_next',
      'review_next',
      'in_progress',
      'not_started',
    ])
    expect(focus.map((n) => n.pct)).toEqual([20, 45, 60, null])
  })

  it('hands the route a node key the roadmap can open', async () => {
    const focus = await focusFor(STUDENT, [], 10)

    // focus[0] becomes `?node=` — the `${type}:${id}` canvas key, not a bare id.
    expect(focus[0].key).toBe('module_item:i-attn')
    expect(focus[0].topics).toEqual(['Attention'])
  })

  it('never sends them somewhere there is nothing to do', async () => {
    const focus = await focusFor(STUDENT, [], 10)
    const titles = focus.map((n) => n.title)

    expect(titles).not.toContain('Evaluation with BLEU') // mastered at 90
    expect(titles).not.toContain('— Unit 2 —') // a divider, not material
    // The two the canvas draws-or-stores but cannot open a card for. Ranking
    // either one sends the student to a `?node=` the roadmap answers with
    // "couldn't find that" — while Athena's reply says it opened the material.
    expect(titles).not.toContain('Reading list') // a note: on the map, no card
    expect(titles).not.toContain('Homework 1') // legacy assignment item
    expect(titles).not.toContain('Solutions') // hidden from students
    expect(titles).not.toContain('Next term') // unpublished module
  })

  it('drops material the student has checked off themselves', async () => {
    const focus = await focusFor(STUDENT, [
      {
        section_id: SECTION,
        student_id: STUDENT,
        progress: { nodeProgress: { 'i-attn': { checkedOff: true } } },
      },
    ], 10)

    // Their weakest node by score — but they have said they are done with it,
    // so the top of the list moves on rather than marching them back.
    expect(focus.map((n) => n.title)).not.toContain('Attention')
    expect(focus[0].key).toBe('module_item:i-tok')
  })

  it("reads THIS student's mastery, not the section's", async () => {
    // Same course, same nodes, inverted standing. If the per-student lookup were
    // dropped, both students would be told to study the same thing.
    const mine = await focusFor(STUDENT, [], 10)
    const theirs = await focusFor(OTHER, [], 10)

    expect(mine[0].title).toBe('Attention')
    expect(theirs[0].title).toBe('Evaluation with BLEU')
    expect(theirs.map((n) => n.title)).not.toContain('Attention')
  })

  it('ignores another student\'s check-offs', async () => {
    const focus = await focusFor(STUDENT, [
      {
        section_id: SECTION,
        student_id: OTHER,
        progress: { nodeProgress: { 'i-attn': { checkedOff: true } } },
      },
    ], 10)

    expect(focus[0].title).toBe('Attention')
  })

  it('returns a short list, weakest end first', async () => {
    // The default is what the tool ships to the model; an unbounded list would
    // bury the node the app is about to open.
    const focus = await focusFor(STUDENT)

    expect(focus.map((n) => n.title)).toEqual(['Attention', 'Tokenization', 'N-gram models'])
  })

  it('has nothing to say in an empty course', async () => {
    const empty = stubDb({ modules: [], module_items: [], roadmap_progress: [] })

    expect((await buildStudyFocus(empty, SECTION, STUDENT)).nodes).toEqual([])
  })

  // The student's course-wide standing rides out on this same read rather than
  // costing a second whole-section one. A course with no openable nodes returns
  // before the mastery read happens, so it must report null — never 0%, which a
  // student would read as "you have learned nothing".
  it('carries the course-wide standing, and reports null rather than 0 when unmeasured', async () => {
    // Their own roll-up, not the other student's (71).
    expect((await studyFocusFor(STUDENT, [], 10)).overall).toBe(54)
    expect((await studyFocusFor(OTHER, [], 10)).overall).toBe(71)
  })

  // Mastery is scored against the course's TOPICS, which outlive whether any
  // node is openable today — a student can be fully assessed on a week that is
  // now locked. Reporting null there would have Athena tell them nothing has
  // been assessed, which is a different (and false) statement.
  it('still reports a standing when the course has nothing openable', async () => {
    const empty = stubDb({ modules: [], module_items: [], roadmap_progress: [] })

    const focus = await buildStudyFocus(empty, SECTION, STUDENT)

    expect(focus.nodes).toEqual([])
    expect(focus.overall).toBe(54)
  })

  it('reserves null for a student with no aggregate at all', async () => {
    // UNASSESSED has no entry in either mastery map — null here means
    // "unassessed", and the tool description tells the model to say so plainly
    // rather than reporting 0%, which reads as "you have learned nothing".
    expect((await studyFocusFor(UNASSESSED, [], 10)).overall).toBeNull()
  })
})
