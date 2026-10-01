// `leave_study_artifact` is Athena's first WRITE. Everything the model sends is
// content it wrote itself; every identifier on the row has to come from the
// verified ctx, and the only thing it gets to point at — a module — arrives as
// a spoken label resolved against this section's own published modules. So the
// tests that matter are the ones that can tell "resolved a label" apart from
// "followed the model's finger":
//
//   1. the anchor cannot leave the section, or reach an unpublished module;
//   2. the stored row's tenancy/ownership columns come from ctx, not the input;
//   3. a refusal is silent — no row, and no directive telling the student the
//      app just opened something that does not exist.
//
// Row-aware Supabase double (same shape as student-tutor-tools.test.ts): the
// filters really filter, so deleting `.eq('section_id', …)` changes which module
// the tool resolves rather than passing vacuously.

import { describe, it, expect, vi } from 'vitest'
import { buildStudentTools, type AthenaStudentCtx } from '@/lib/ai/student-tutor/contract'
import { studentToolsFor } from '@/lib/ai/student-tutor/tools'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const SECTION = 'sec-1'
const STUDENT = 'student-1'
const INSTITUTION = 'inst-1'
const CONVERSATION = 'convo-1'
const NEW_ID = '9f1c0d2e-1111-4111-8111-aaaaaaaaaaaa'

type Row = Record<string, unknown>

const mod = (over: Row): Row => ({
  section_id: SECTION,
  is_published: true,
  system_kind: null,
  week_number: null,
  position: 0,
  ...over,
})

const MODULES: Row[] = [
  mod({ id: 'm-1', title: 'Tokenization', week_number: 1, position: 0 }),
  // The label the model says ("Week 6") is nowhere in this title — only the
  // week_number branch can find it.
  mod({ id: 'm-6', title: 'Attention and Transformers', week_number: 6, position: 5 }),
  // Rows the resolver must refuse to reach:
  mod({ id: 'm-draft', title: 'Ethics of NLP', week_number: 8, position: 7, is_published: false }),
  mod({ id: 'm-other', title: 'Decoding Strategies', week_number: 9, position: 0, section_id: 'sec-2' }),
]

/** Row-aware double with insert capture. `select(_, {head:true})` returns the
 *  count the cap check reads; everything else resolves to the filtered rows. */
function stubDb(tables: Record<string, Row[]>) {
  const inserted: Row[] = []
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    let head = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        head = !!opts?.head
        return chain
      },
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val)
        return chain
      },
      is: (col: string, val: unknown) => {
        rows = rows.filter((r) => (r[col] ?? null) === val)
        return chain
      },
      // The unlock gate (openModuleFilter). Fixtures carry no unlock_date, so
      // every published module reads as open — pass-through keeps the rows.
      or: () => chain,
      order: () => chain,
      limit: (n: number) => {
        rows = rows.slice(0, n)
        return chain
      },
      insert: (payload: Row) => {
        inserted.push(payload)
        rows = [{ id: NEW_ID }]
        return chain
      },
      single: async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: head ? null : rows, error: null, count: rows.length }).then(resolve),
    }
    return chain
  }
  return { from, inserted }
}

type Directive = { type: string; nodeKey?: string; title?: string }
type Result = { created: boolean; reason?: string; modules?: string[]; module?: string; summary?: string }

/** The pages the route "retrieved" this turn — the set an artifact is attributed
 *  against (§15.4). Carries page TEXT so the content-overlap fallback can assign a
 *  page when the model's cite is wrong. CARDS/QUESTION below cite valid pages, so
 *  the anchor and cap tests exercise their own logic, not attribution (which has
 *  its own block). Pass `[]` to a harness to simulate "nothing retrieved". */
const P6_TEXT = 'The softmax function normalizes attention scores into weights that sum to one.'
const P7_TEXT = 'Multi-head attention runs several independent attention subspaces in parallel.'
const CITABLE = [
  { material: 'Attention and Transformers', page: 6, text: P6_TEXT },
  { material: 'Attention and Transformers', page: 7, text: P7_TEXT },
]

function harness(artifacts: Row[] = [], modules: Row[] = MODULES, citablePages: { material: string; page: number; text?: string }[] = CITABLE) {
  const db = stubDb({ modules, athena_artifacts: artifacts })
  const directives: Directive[] = []
  const tools = buildStudentTools(
    {
      adminDb: db as unknown as AthenaStudentCtx['adminDb'],
      sectionId: SECTION,
      userId: STUDENT,
      institutionId: INSTITUTION,
      conversationId: CONVERSATION,
      citablePages,
      emit: (d) => directives.push(d as Directive),
    },
    studentToolsFor('copilot'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any
  return {
    db,
    directives,
    leave: (input: Record<string, unknown>) => tools.leave_study_artifact.execute(input, {}) as Promise<Result>,
  }
}

const cite6 = { material: 'Attention and Transformers', page: 6 }
const cite7 = { material: 'Attention and Transformers', page: 7 }

const CARDS = [
  { front: 'Query, key, value', back: 'The three projections attention scores with.', cite: cite6 },
  { front: 'Softmax', back: 'Normalizes the scores into weights that sum to 1.', cite: cite7 },
  { front: 'Head', back: 'One independent attention subspace.', cite: cite6 },
]

describe('leave_study_artifact — the anchor is resolved, not supplied', () => {
  it('stores the row against the module the spoken label names, with every id from ctx', async () => {
    const { db, directives, leave } = harness()

    const result = await leave({ kind: 'flashcards', title: 'Attention basics', module: 'week 6', cards: CARDS })

    expect(result).toMatchObject({ created: true, module: 'Attention and Transformers', summary: '3 cards' })
    // The model named a week; the row points at the module id the server looked
    // up, and at the student/tenant the request was already authorized for.
    expect(db.inserted).toHaveLength(1)
    expect(db.inserted[0]).toMatchObject({
      module_id: 'm-6',
      institution_id: INSTITUTION,
      section_id: SECTION,
      student_id: STUDENT,
      conversation_id: CONVERSATION,
      kind: 'flashcards',
      payload: { cards: CARDS },
    })
    // The student is sent to the note by a server-chosen key built from the id
    // the insert returned — the model never gets to write its own destination.
    expect(directives).toEqual([
      { type: 'goto_node', nodeKey: `athena_artifact:${NEW_ID}`, title: 'Attention basics' },
    ])
  })

  it('refuses to anchor to another section, or to a module the professor has not published', async () => {
    // Both labels match a real row in `modules` — only the query's own filters
    // keep them out of reach. Drop either and this test creates the artifact.
    const { db, directives, leave } = harness()

    const foreign = await leave({ kind: 'flashcards', title: 'x', module: 'Decoding Strategies', cards: CARDS })
    const unpublished = await leave({ kind: 'flashcards', title: 'x', module: 'Ethics of NLP', cards: CARDS })

    expect(foreign.created).toBe(false)
    expect(unpublished.created).toBe(false)
    // The refusal hands back this section's menu so the model can retry — and
    // that menu is itself proof of the scoping.
    expect(foreign.modules).toEqual(['Tokenization', 'Attention and Transformers'])
    expect(db.inserted).toHaveLength(0)
    expect(directives).toEqual([])
  })
})

// The substring fallback is what the model reaches when it paraphrases a module
// name instead of quoting it. It is deliberately narrow: a match must be a whole
// word, long enough to mean something, and name exactly ONE module — otherwise a
// note silently lands on the wrong week. These pin the guards apart from a bare
// `title.includes(label)`, which each case would defeat.
describe('leave_study_artifact — the substring fallback is guarded', () => {
  const mods = (rows: Row[]) => rows.map((r, i) => mod({ position: i, ...r }))

  it('resolves a genuine word-boundary paraphrase to the one module it names', async () => {
    const { db, leave } = harness([], mods([
      { id: 'm-a', title: 'Recurrent Neural Networks', week_number: 3 },
      { id: 'm-b', title: 'Sequence to Sequence Models', week_number: 4 },
    ]))

    // "Recurrent Neural" is a contiguous, word-boundary substring of the title —
    // the exact shape the fallback is meant to catch (and only this one module).
    const result = await leave({ kind: 'flashcards', title: 'x', module: 'Recurrent Neural', cards: CARDS })

    expect(result).toMatchObject({ created: true, module: 'Recurrent Neural Networks' })
    expect(db.inserted[0]).toMatchObject({ module_id: 'm-a' })
  })

  it('refuses a match that is not on a word boundary — "rate" is not "operator"', async () => {
    const { db, leave } = harness([], mods([{ id: 'm-op', title: 'Operators', week_number: 2 }]))

    const result = await leave({ kind: 'flashcards', title: 'x', module: 'rate', cards: CARDS })

    // A bare includes() would anchor "rate" inside "Operators" and create a note
    // on the wrong module; the word-boundary guard drops it.
    expect(result.created).toBe(false)
    expect(db.inserted).toHaveLength(0)
  })

  it('refuses a label shorter than the minimum, so a tiny fragment cannot coincidence-match', async () => {
    const { db, leave } = harness([], mods([{ id: 'm-ml', title: 'ML Foundations', week_number: 1 }]))

    const result = await leave({ kind: 'flashcards', title: 'x', module: 'ML', cards: CARDS })

    expect(result.created).toBe(false)
    expect(db.inserted).toHaveLength(0)
  })

  it('refuses an ambiguous label that names two modules rather than guessing', async () => {
    const { db, leave } = harness([], mods([
      { id: 'm-1', title: 'Attention Mechanisms', week_number: 5 },
      { id: 'm-2', title: 'Self-Attention and Heads', week_number: 6 },
    ]))

    const result = await leave({ kind: 'flashcards', title: 'x', module: 'attention', cards: CARDS })

    // Two modules contain the word — the resolver drops it rather than silently
    // anchoring to the first row, and hands back both names to pick from.
    expect(result.created).toBe(false)
    expect(result.modules).toEqual(['Attention Mechanisms', 'Self-Attention and Heads'])
    expect(db.inserted).toHaveLength(0)
  })
})

describe('leave_study_artifact — content the student would be graded wrong by', () => {
  const QUESTION = (opts: { text: string; correct?: boolean }[]) => ({
    prompt: 'Which layer normalizes attention scores?',
    options: opts,
    explanation: 'Softmax turns raw scores into a distribution.',
    cite: cite6,
  })

  it('rejects a practice set whose question has no single correct option, naming which one', async () => {
    const { db, leave } = harness()

    const none = await leave({
      kind: 'practice',
      title: 'Attention check',
      module: 'Tokenization',
      questions: [QUESTION([{ text: 'softmax', correct: true }]), QUESTION([{ text: 'a' }, { text: 'b' }])],
    })
    const two = await leave({
      kind: 'practice',
      title: 'Attention check',
      module: 'Tokenization',
      questions: [QUESTION([{ text: 'a', correct: true }, { text: 'b', correct: true }])],
    })

    // An unanswerable question is not a save-and-fix-later: the widget scores
    // the student against it, so a set with no key marks them wrong whatever
    // they pick. The message has to say which question to redo.
    expect(none).toMatchObject({ created: false })
    expect(none.reason).toMatch(/question 2/)
    expect(two.reason).toMatch(/question 1/)
    expect(db.inserted).toHaveLength(0)
  })

  it('stores a well-formed practice set, so the rejection above is the check and not the fixture', async () => {
    const { db, leave } = harness()

    const result = await leave({
      kind: 'practice',
      title: 'Attention check',
      module: 'Tokenization',
      questions: [QUESTION([{ text: 'softmax', correct: true }, { text: 'relu' }])],
    })

    expect(result).toMatchObject({ created: true, summary: '1 question' })
    expect(db.inserted).toHaveLength(1)
  })

  it('refuses the kind whose content is missing rather than storing an empty artifact', async () => {
    const { db, leave } = harness()

    const result = await leave({ kind: 'checklist', title: 'Plan', module: 'Tokenization', cards: CARDS })

    expect(result.created).toBe(false)
    expect(result.reason).toMatch(/steps/)
    expect(db.inserted).toHaveLength(0)
  })
})

// Cite-and-check (§15.4): a fact-bearing artifact is built ONLY from pages the
// route retrieved this turn. Every card/question/point names a page; the tool
// drops the ones whose page isn't in `citablePages` and declines when nothing is
// retrievable — the honesty rule (G1/G2) applied to generated study material.
describe('leave_study_artifact — grounded in cited pages (§15.4)', () => {
  it('drops a card that matches no retrieved page — bogus cite AND no content overlap', async () => {
    const { db, leave } = harness()

    const result = await leave({
      kind: 'flashcards',
      title: 'Attention basics',
      module: 'week 6',
      cards: [
        { front: 'QKV', back: 'the three projections', cite: cite6 },
        { front: 'Softmax', back: 'normalizes scores', cite: cite7 },
        // Bogus page AND wording that overlaps no retrieved page — content
        // attribution can't rescue it, so it's dropped (the two grounded stay).
        { front: 'Made up', back: 'nonsense unrelated gibberish elsewhere', cite: { material: 'Attention and Transformers', page: 99 } },
      ],
    })

    expect(result).toMatchObject({ created: true, summary: '2 cards' })
    expect((db.inserted[0].payload as { cards: unknown[] }).cards).toHaveLength(2)
  })

  it('re-stamps a mis-cited card with the page its content actually matches, instead of dropping it', async () => {
    // The model cited a page that was never retrieved (99), but the card's wording
    // overlaps the real page 6 text — content attribution (the quiz-gen engine)
    // assigns page 6 rather than throwing the card away.
    const { db, leave } = harness()

    const result = await leave({
      kind: 'flashcards',
      title: 'Attention basics',
      module: 'week 6',
      cards: [
        { front: 'Softmax', back: 'normalizes attention scores into weights', cite: { material: 'Attention and Transformers', page: 99 } },
        { front: 'Heads', back: 'independent attention subspaces in parallel', cite: cite7 },
      ],
    })

    expect(result).toMatchObject({ created: true, summary: '2 cards' })
    const cards = (db.inserted[0].payload as { cards: { cite: { page: number } }[] }).cards
    expect(cards[0].cite.page).toBe(6) // re-attributed from the bogus 99 to the real page
    expect(cards[1].cite.page).toBe(7) // a valid model cite is kept as-is
  })

  it('re-stamps a mis-cited practice question by content (same attribution path as cards)', async () => {
    const { db, leave } = harness()

    const result = await leave({
      kind: 'practice',
      title: 'Attention check',
      module: 'week 6',
      questions: [
        {
          prompt: 'Which function normalizes attention scores into weights?',
          options: [{ text: 'softmax', correct: true }, { text: 'relu' }],
          cite: { material: 'Attention and Transformers', page: 99 }, // bogus
        },
      ],
    })

    expect(result).toMatchObject({ created: true, summary: '1 question' })
    const qs = (db.inserted[0].payload as { questions: { cite: { page: number } }[] }).questions
    expect(qs[0].cite.page).toBe(6) // prompt+options overlap page 6, not the cited 99
  })

  it('drops a card that overlaps only ONE topic word — pinning the ≥2 content floor', async () => {
    const { db, leave } = harness()

    const result = await leave({
      kind: 'flashcards',
      title: 'x',
      module: 'week 6',
      cards: [
        { front: 'Softmax', back: 'normalizes attention scores into weights', cite: cite6 },
        { front: 'Heads', back: 'independent attention subspaces in parallel', cite: cite7 },
        // Shares only "attention" with any page (score 1) — below the 2-overlap
        // floor, so it drops even though the two valid-cited cards stay. If the
        // floor were ≥1 this would be a third card.
        { front: 'Aside', back: 'attention tangent otherwise unrelated', cite: { material: 'Attention and Transformers', page: 99 } },
      ],
    })

    expect(result).toMatchObject({ created: true, summary: '2 cards' })
    expect((db.inserted[0].payload as { cards: unknown[] }).cards).toHaveLength(2)
  })

  it('refuses when too few cards survive the cite check, rather than saving an ungrounded deck', async () => {
    const { db, leave } = harness()

    const result = await leave({
      kind: 'flashcards',
      title: 'Ungrounded',
      module: 'week 6',
      cards: [
        { front: 'a', back: 'b', cite: { material: 'Attention and Transformers', page: 99 } },
        { front: 'c', back: 'd', cite: { material: 'Nowhere', page: 1 } },
      ],
    })

    expect(result.created).toBe(false)
    expect(result.reason).toMatch(/cite|page/i)
    expect(db.inserted).toHaveLength(0)
  })

  it('declines a fact-bearing artifact when nothing was retrieved this turn', async () => {
    // Empty citable set = an out-of-corpus question or an un-indexed course.
    const { db, leave } = harness([], MODULES, [])

    const result = await leave({ kind: 'flashcards', title: 'x', module: 'week 6', cards: CARDS })

    expect(result.created).toBe(false)
    expect(result.reason).toMatch(/course|material|pages/i)
    expect(db.inserted).toHaveLength(0)
  })

  it('still builds a checklist with no retrieval — steps are study actions, not page facts', async () => {
    const { db, leave } = harness([], MODULES, [])

    const result = await leave({
      kind: 'checklist',
      title: 'Exam prep',
      module: 'week 6',
      steps: [
        { label: 'Re-derive scaled dot-product attention', minutes: 20 },
        { label: 'Do 5 practice questions', minutes: 30 },
      ],
    })

    expect(result.created).toBe(true)
    expect(db.inserted).toHaveLength(1)
  })

  it('builds a study_guide from cited points, dropping the uncited ones', async () => {
    const { db, leave } = harness()

    const result = await leave({
      kind: 'study_guide',
      title: 'Transformers in one page',
      module: 'week 6',
      sections: [
        {
          heading: 'Attention',
          points: [
            { text: 'Attention weights come from a softmax over query·key scores.', cite: cite6 },
            { text: 'Invented claim with no page.', cite: { material: 'Attention and Transformers', page: 99 } },
          ],
        },
      ],
    })

    expect(result).toMatchObject({ created: true, kind: 'study_guide', summary: '1 section · 1 point' })
    const sections = (db.inserted[0].payload as { sections: { points: unknown[] }[] }).sections
    expect(sections[0].points).toHaveLength(1)
  })

  it('re-stamps a mis-cited study_guide point by content (same attribution path as cards)', async () => {
    const { db, leave } = harness()

    const result = await leave({
      kind: 'study_guide',
      title: 'Transformers',
      module: 'week 6',
      sections: [
        {
          heading: 'Attention',
          points: [
            { text: 'The softmax normalizes attention scores into weights.', cite: { material: 'Attention and Transformers', page: 99 } },
          ],
        },
      ],
    })

    expect(result.created).toBe(true)
    const sections = (db.inserted[0].payload as { sections: { points: { cite: { page: number } }[] }[] }).sections
    expect(sections[0].points[0].cite.page).toBe(6) // re-attributed from bogus 99 to the real page
  })

  // Every other cite in this file quotes the page title verbatim, so the fuzzy
  // legs of citeInContext never decide anything — a `have === want` mutation of
  // the matcher would pass all of them. This is the one case that pins the
  // paraphrase behaviour the comment claims: the model shortens the title, and
  // the page number still has to be one that was actually retrieved.
  it('accepts a card whose cited title is a paraphrase of the retrieved page title', async () => {
    const { db, leave } = harness()

    const result = await leave({
      kind: 'flashcards',
      title: 'Attention basics',
      module: 'week 6',
      cards: [
        // Title is a substring of "Attention and Transformers" (have.includes(want)),
        // page 6 is in citablePages → kept.
        { front: 'QKV', back: 'the three projections', cite: { material: 'Attention', page: 6 } },
        // Model overshoots with the full lecture name (want.includes(have) if the
        // page marker were shorter); here it is the verbatim title on page 7 → kept.
        { front: 'Softmax', back: 'normalizes scores', cite: cite7 },
      ],
    })

    expect(result).toMatchObject({ created: true, summary: '2 cards' })
    expect((db.inserted[0].payload as { cards: unknown[] }).cards).toHaveLength(2)
  })

  it('drops a card that cites the right title on a page that was not retrieved', async () => {
    const { db, leave } = harness()

    // A plausible-but-wrong page (5, adjacent to the retrieved 6/7), not an
    // obviously-fake 99: proves the gate is `p.page === cite.page`, and that a
    // title matching SOME retrieved page does not license every page of it.
    const result = await leave({
      kind: 'flashcards',
      title: 'Attention basics',
      module: 'week 6',
      cards: [
        { front: 'QKV', back: 'the three projections', cite: cite6 },
        { front: 'Softmax', back: 'normalizes scores', cite: cite7 },
        { front: 'Positional encoding', back: 'sinusoids added to embeddings', cite: { material: 'Attention and Transformers', page: 5 } },
      ],
    })

    expect(result).toMatchObject({ created: true, summary: '2 cards' })
    expect((db.inserted[0].payload as { cards: unknown[] }).cards).toHaveLength(2)
  })
})

describe('leave_study_artifact — the per-section cap', () => {
  const full = Array.from({ length: 30 }, (_, i) => ({
    id: `a-${i}`,
    section_id: SECTION,
    student_id: STUDENT,
  }))

  it('stops at the cap without writing, and without telling the student the app moved', async () => {
    const { db, directives, leave } = harness(full)

    const result = await leave({ kind: 'flashcards', title: 'One more deck', module: 'week 6', cards: CARDS })

    expect(result.created).toBe(false)
    expect(result.reason).toMatch(/maximum/i)
    expect(db.inserted).toHaveLength(0)
    // Emitting here would navigate the student to a note that was never made.
    expect(directives).toEqual([])
  })

  it('counts only this student in this section — a full classmate must not block them', async () => {
    // The cap read is `count`-only: with the eq filters dropped, a busy
    // classmate silently locks everyone else out of the feature.
    const { db, leave } = harness([
      ...full.map((r) => ({ ...r, student_id: 'student-2' })),
      ...full.map((r) => ({ ...r, section_id: 'sec-2' })),
    ])

    const result = await leave({ kind: 'flashcards', title: 'Deck', module: 'week 6', cards: CARDS })

    expect(result.created).toBe(true)
    expect(db.inserted).toHaveLength(1)
  })
})
