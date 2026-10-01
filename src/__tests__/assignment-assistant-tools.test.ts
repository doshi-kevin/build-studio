import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  fillFeedbackSchema,
  designNotesSchema,
  frontierRubricSchema,
  ASSIGNMENT_FILL_TOOLS,
} from '@/lib/ai/assignment-assistant/schemas'
import {
  TEMPLATE_REGISTRY,
  quizSettingsSchema,
  generateQuestionsSchema,
} from '@/lib/ai/assignment-assistant/templates/registry'
import { buildAssignmentAssistantTools } from '@/lib/ai/assignment-assistant/tools'

// The assignment-scoped Athena's safety rests on invariants worth pinning:
// (1) authoring mode exposes ONLY apply_edits (+ reads), grade exposes ONLY the grading
//     tools — a mode can never reach the other's tool; (2) no fill tool has a server
//     execute (fills are client-side only); (3) summarize_submission fails CLOSED for any
//     submission whose assignment is not in the route-verified section/tenant (IDOR guard);
// and (4) the per-kind op schemas shape what the model may emit (typed = reliable).

const SECTION = 'sec-verified'
const INSTITUTION = 'inst-verified'
const ASSIGNMENT = 'asg-verified'
const USER = 'user-verified'

/** Minimal chainable supabase-js double: from().select().eq().maybeSingle(). */
function mockDb(row: unknown, error: unknown = null) {
  const builder = {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve({ data: row, error }),
  }
  return builder
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizeTool(db: any, selectedSubmissionId?: string) {
  const tools = buildAssignmentAssistantTools({
    adminDb: db,
    sectionId: SECTION,
    institutionId: INSTITUTION, userId: USER,
    surface: 'grade',
    selectedSubmissionId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
  return tools.summarize_submission
}

describe('registry op schemas (flat, Gemini-reliable apply_edits payloads)', () => {
  // The op schemas are FLAT (op enum + optional fields, NO oneOf) so Gemini can emit them
  // reliably. The schema validates field TYPES (enums, numeric/format bounds); per-op
  // required-field semantics are enforced in the adapters (see the adapter test suites).
  const notebook = TEMPLATE_REGISTRY.notebook.opSchema
  const verbal = TEMPLATE_REGISTRY.verbal.opSchema
  const document = TEMPLATE_REGISTRY.document.opSchema
  const files = TEMPLATE_REGISTRY.files.opSchema
  const quiz = TEMPLATE_REGISTRY.quiz.opSchema

  it('the schemas contain NO oneOf/anyOf (the Gemini failure mode this fix removes)', () => {
    // quiz included: its question fields are NESTED, which is fine (the limitation is
    // union-of-variants, not depth) — this proves nesting didn't reintroduce a union.
    // designNotesSchema / frontierRubricSchema included: both nest arrays of objects, so
    // this proves the Frontier fills didn't reintroduce the union shape Gemini mishandles.
    for (const s of [
      notebook,
      verbal,
      document,
      files,
      quiz,
      TEMPLATE_REGISTRY.project.opSchema,
      quizSettingsSchema,
      generateQuestionsSchema,
      designNotesSchema,
      frontierRubricSchema,
    ]) {
      const json = JSON.stringify(z.toJSONSchema(s))
      expect(json).not.toContain('oneOf')
      expect(json).not.toContain('anyOf')
    }
  })

  // A rubric arriving from the model must be the SAME shape settings.rubric already
  // stores, because the grading screen keys saved grades by criterion position.
  it('the frontier rubric payload matches the shape the grading screen parses', () => {
    const ok = {
      questions: [
        { label: 'Q1', points: 10, criteria: [{ description: 'Cites the raw source', points: 4 }] },
      ],
    }
    expect(frontierRubricSchema.safeParse(ok).success).toBe(true)
    // an empty rubric is not a rubric — parseRubric() would read it back as "none"
    expect(frontierRubricSchema.safeParse({ questions: [] }).success).toBe(false)
    // the auto-vs-judgment tagging deliberately does NOT live here (it needs the design
    // row, which is written after the rubric) — it belongs to set_design_notes
    expect('tags' in (frontierRubricSchema.parse(ok) as object)).toBe(false)
  })

  it('design notes require the fields a freshness pass depends on', () => {
    const base = {
      spine: 'Normalisation to third normal form.',
      shell: "A messy open-data CSV from the student's own city portal.",
      individuationAxis: 'Their own city dataset, so a copied schema describes tables the data does not have.',
      verificationMode: 'raw_vs_processed' as const,
      failureModes: [
        { failure: 'The portal is down.', acceptanceClause: 'Submit the failed request and use the backup extract.' },
        { failure: 'The dataset moved.', acceptanceClause: 'Submit the 404 and pick any other city.' },
      ],
      rotNotes: 'City portals rename endpoints roughly yearly; re-check the URL each term.',
      referenceInvariants: ['Every table is in 3NF.'],
      gateReport: [{ property: 'individuation' as const, justification: 'The dataset is student-chosen.' }],
    }
    expect(designNotesSchema.safeParse(base).success).toBe(true)
    // rot notes are the entire point of the record — they cannot be omitted
    const noRot: Record<string, unknown> = { ...base }
    delete noRot.rotNotes
    expect(designNotesSchema.safeParse(noRot).success).toBe(false)
    // one failure mode is not "two to four"
    expect(designNotesSchema.safeParse({ ...base, failureModes: [base.failureModes[0]] }).success).toBe(false)
    expect(designNotesSchema.safeParse({ ...base, verificationMode: 'vibes' }).success).toBe(false)
    // the criterion tagging lives here, and its tag is a closed enum
    expect(
      designNotesSchema.safeParse({
        ...base,
        criterionTags: [{ question: 'Q1', criterion: 'Cites the raw source', tag: 'auto' }],
      }).success,
    ).toBe(true)
    expect(
      designNotesSchema.safeParse({ ...base, criterionTags: [{ question: 'Q1', criterion: 'x', tag: 'vibes' }] }).success,
    ).toBe(false)
  })

  it('notebook accepts every op shape and rejects a bad cell-type enum', () => {
    expect(
      notebook.safeParse({
        ops: [
          { op: 'insert', cellType: 'markdown', source: '# Intro' },
          { op: 'insert', cellType: 'code', source: 'x = 1', afterId: 'c1' },
          { op: 'update', id: 'c1', source: 'y = 2' },
          { op: 'remove', id: 'c2' },
          { op: 'reorder', id: 'c3', afterId: 'c1' },
          { op: 'setMeta', title: 'Lab 3' },
        ],
      }).success,
    ).toBe(true)
    expect(notebook.safeParse({ ops: [{ op: 'insert', cellType: 'sql', source: 'x' }] }).success).toBe(false)
    expect(notebook.safeParse({ ops: [{ op: 'frobnicate' }] }).success).toBe(false) // bad op enum
    expect(notebook.safeParse({ ops: [] }).success).toBe(false)
  })

  it('verbal accepts an mcq insert with options + a topic, and rejects a bad cell-type enum', () => {
    expect(
      verbal.safeParse({
        ops: [
          { op: 'setMeta', topic: 'Tokenization' },
          { op: 'insert', cellType: 'question', prompt: 'Explain BPE.', answerType: 'long' },
          { op: 'insert', cellType: 'mcq', prompt: 'Which is subword?', options: ['BPE', 'Whitespace'], correctOptionIndex: 0 },
          { op: 'update', id: 'v1', prompt: 'Reworded.' },
          { op: 'remove', id: 'v2' },
        ],
      }).success,
    ).toBe(true)
    expect(verbal.safeParse({ ops: [{ op: 'insert', cellType: 'essay' }] }).success).toBe(false)
    expect(verbal.safeParse({ ops: [{ op: 'insert', answerType: 'medium' }] }).success).toBe(false) // bad enum
  })

  it('document accepts every op shape', () => {
    expect(
      document.safeParse({
        ops: [
          { op: 'setDocument', html: '<h1>Lab</h1><p>Do it.</p>' },
          { op: 'appendSection', html: '<h2>Refs</h2>' },
          { op: 'replaceSection', headingId: 's0', html: '<h1>New</h1>' },
          { op: 'setMeta', title: 'Lab report' },
        ],
      }).success,
    ).toBe(true)
    expect(document.safeParse({ ops: [{ op: 'nuke' }] }).success).toBe(false) // bad op enum
  })

  it('files setMeta enforces numeric/format/file-type bounds the model must respect', () => {
    expect(files.safeParse({ ops: [{ op: 'setMeta', points: 50 }] }).success).toBe(true)
    expect(files.safeParse({ ops: [{ op: 'setMeta' }] }).success).toBe(true) // empty surgical edit
    expect(files.safeParse({ ops: [{ op: 'setMeta', fileTypes: ['exe'] }] }).success).toBe(false)
    expect(files.safeParse({ ops: [{ op: 'setMeta', dueDate: 'next friday' }] }).success).toBe(false)
    expect(files.safeParse({ ops: [{ op: 'setMeta', points: 1001 }] }).success).toBe(false)
    expect(files.safeParse({ ops: [{ op: 'setMeta', points: 12.5 }] }).success).toBe(false)
    expect(files.safeParse({ ops: [{ op: 'setMeta', dueTime: '9:5' }] }).success).toBe(false)
  })

  it('every kind caps the batch at 40 ops', () => {
    const one = { op: 'insert' as const, cellType: 'markdown' as const, source: 'x' }
    expect(notebook.safeParse({ ops: Array(40).fill(one) }).success).toBe(true)
    expect(notebook.safeParse({ ops: Array(41).fill(one) }).success).toBe(false)
  })

  it('feedback requires non-empty prose', () => {
    expect(fillFeedbackSchema.safeParse({ feedback: '' }).success).toBe(false)
    expect(fillFeedbackSchema.safeParse({ feedback: 'Strong thesis; add sources.' }).success).toBe(true)
  })
})

describe('quiz schemas', () => {
  const quiz = TEMPLATE_REGISTRY.quiz.opSchema

  it('accepts a full batch of question ops', () => {
    expect(
      quiz.safeParse({
        ops: [
          {
            op: 'insert',
            question: {
              questionType: 'multiple_choice',
              questionText: 'Which is O(n log n)?',
              choices: [
                { text: 'merge sort', isCorrect: true },
                { text: 'bubble sort', isCorrect: false },
              ],
              difficulty: 'medium',
              bloomsLevel: 'analyze',
              tags: ['sorting'],
              points: 2,
              explanation: 'Merge sort halves and merges.',
            },
          },
          { op: 'update', id: 'q1', question: { points: 3 } },
          { op: 'remove', id: 'q2' },
          { op: 'reorder', id: 'q3', afterId: 'q1' },
          {
            op: 'insert',
            question: {
              questionType: 'walkthrough',
              questionText: 'Walk me through backprop.',
              rubric: [{ concept: 'chain rule', match: ['derivative'] }],
              opening: 'Where does the gradient start?',
              maxTurns: 4,
            },
          },
        ],
      }).success,
    ).toBe(true)
  })

  it('rejects bad enums and out-of-range values', () => {
    expect(quiz.safeParse({ ops: [{ op: 'rewrite', id: 'q1' }] }).success).toBe(false)
    expect(quiz.safeParse({ ops: [{ op: 'insert', question: { questionType: 'essay' } }] }).success).toBe(false)
    expect(quiz.safeParse({ ops: [{ op: 'update', id: 'q', question: { difficulty: 'brutal' } }] }).success).toBe(false)
    expect(quiz.safeParse({ ops: [{ op: 'update', id: 'q', question: { points: 0 } }] }).success).toBe(false)
    expect(quiz.safeParse({ ops: [{ op: 'update', id: 'q', question: { points: 2.5 } }] }).success).toBe(false)
    expect(quiz.safeParse({ ops: [{ op: 'update', id: 'q', question: { maxTurns: 99 } }] }).success).toBe(false)
    expect(quiz.safeParse({ ops: [] }).success).toBe(false)
  })

  it('caps the batch at 40 ops like every other kind', () => {
    const op = { op: 'remove' as const, id: 'q' }
    expect(quiz.safeParse({ ops: Array(40).fill(op) }).success).toBe(true)
    expect(quiz.safeParse({ ops: Array(41).fill(op) }).success).toBe(false)
  })

  it('settings accept the whitelist and REFUSE publish/scheduling/proctoring/IRT', () => {
    expect(
      quizSettingsSchema.safeParse({
        title: 'Midterm',
        timeLimitMinutes: 60,
        maxAttempts: 2,
        passThreshold: 70,
        dueDate: '2026-08-14',
        shuffleQuestions: true,
        showExplanations: 'after_due_date',
        negativeMarking: true,
        negativeMarkingPenalty: 0.25,
        adaptiveMode: true,
      }).success,
    ).toBe(true)
    // 0 / '' are the "clear it" sentinels — NOT null, because a nullable field renders as
    // the anyOf union Gemini mishandles (the adapter maps these back to null)
    expect(quizSettingsSchema.safeParse({ timeLimitMinutes: 0, dueDate: '' }).success).toBe(true)
    expect(quizSettingsSchema.safeParse({ timeLimitMinutes: null }).success).toBe(false)
    // a loose date string is not a date
    expect(quizSettingsSchema.safeParse({ dueDate: 'next friday' }).success).toBe(false)
    // maxAttempts has no ceiling (#43) and takes 0 as the "no limit" sentinel
    expect(quizSettingsSchema.safeParse({ maxAttempts: 99 }).success).toBe(true)
    expect(quizSettingsSchema.safeParse({ maxAttempts: 0 }).success).toBe(true)
    expect(quizSettingsSchema.safeParse({ maxAttempts: -1 }).success).toBe(false)
    expect(quizSettingsSchema.safeParse({ maxAttempts: null }).success).toBe(false)
    // the fields Athena must never reach are absent from the schema, so a strict parse
    // proves they cannot arrive at all
    for (const forbidden of [
      { publishMode: 'published' },
      { scheduledPublishAt: '2026-08-14T10:00:00Z' },
      { proctoringEnabled: true },
      { videoProctoringEnabled: true },
      { formulaSheetUrl: 'https://x/y.pdf' },
      { selectLambda: 1 },
      { targetSe: 0.3 },
    ]) {
      const parsed = quizSettingsSchema.safeParse(forbidden)
      expect(Object.keys(parsed.success ? parsed.data : {})).toHaveLength(0)
    }
  })

  it('generate_questions caps count at 50 and requires ids it did not invent', () => {
    const ok = { moduleItemIds: ['mi-1'], count: 50 }
    expect(generateQuestionsSchema.safeParse(ok).success).toBe(true)
    expect(generateQuestionsSchema.safeParse({ ...ok, count: 51 }).success).toBe(false)
    expect(generateQuestionsSchema.safeParse({ ...ok, count: 0 }).success).toBe(false)
    expect(generateQuestionsSchema.safeParse({ moduleItemIds: [], count: 5 }).success).toBe(false)
    expect(generateQuestionsSchema.safeParse({ count: 5 }).success).toBe(false)
    expect(generateQuestionsSchema.safeParse({ ...ok, questionTypes: ['essay'] }).success).toBe(false)
    expect(generateQuestionsSchema.safeParse({ ...ok, beyondDocument: true }).success).toBe(true)
  })
})

// NOTE: the exact-set assertions below describe what this FACTORY returns, which is no
// longer the whole set the model receives — the route also attaches the provider's
// google_search tool (gated on a Google model). Read them as "the factory adds nothing
// else", not "Athena has only these tools"; the effective per-surface set is pinned in
// assignment-assistant-search-wiring.test.ts.
describe('mode tool isolation', () => {
  const buildAuthoring = (kind: string) =>
    buildAssignmentAssistantTools({ adminDb: mockDb(null), sectionId: SECTION, institutionId: INSTITUTION, userId: USER, surface: 'authoring', kind })

  /** Frontier mode on the authoring surface. assignmentId is passed EXPLICITLY at every
   *  call site — no default — because the fills are gated on it and a default parameter
   *  would swallow an explicit `undefined`, silently testing the wrong branch. */
  const buildFrontier = (kind: string, assignmentId?: string) =>
    buildAssignmentAssistantTools({
      adminDb: mockDb(null),
      sectionId: SECTION,
      institutionId: INSTITUTION, userId: USER,
      surface: 'authoring',
      mode: 'frontier',
      kind,
      assignmentId,
    })

  it.each(['files', 'notebook', 'verbal', 'document'])(
    'authoring/%s exposes apply_edits + read tools, never a grading tool',
    (kind) => {
      const tools = buildAuthoring(kind)
      expect(Object.keys(tools).sort()).toEqual(
        // show_outcome_coverage arrives from the shared accreditation module (#628):
        // authoring an assignment is when "does this close a gap?" is actionable.
        ['apply_edits', 'get_class_struggles', 'list_section_assignments', 'show_outcome_coverage'].sort(),
      )
      expect('summarize_submission' in tools).toBe(false)
      expect('fill_feedback' in tools).toBe(false)
      /* The analysis half must NOT follow it here. It enqueues a job that runs for
         minutes and reports through the console's progress chip and result card; this
         panel is ephemeral, so a job started here completes into a surface the professor
         has already left. */
      expect('analyze_outcome_alignment' in tools).toBe(false)
    },
  )

  // The quiz surface is the one authoring kind with its own tools. They are gated on
  // kind so no other surface pays their prompt tax — that gating is the assertion.
  it('authoring/quiz swaps list_section_assignments for the three quiz tools', () => {
    const tools = buildAuthoring('quiz')
    expect(Object.keys(tools).sort()).toEqual(
      [
        'apply_edits',
        'set_quiz_settings',
        'list_modules',
        'generate_questions',
        'get_class_struggles',
        // Read-only. Lets the model aim questions at indicators with no evidence yet.
        'show_outcome_coverage',
      ].sort(),
    )
    expect('list_section_assignments' in tools).toBe(false)
    expect('summarize_submission' in tools).toBe(false)
    expect('fill_feedback' in tools).toBe(false)
  })

  it('the quiz tools do not leak onto any other authoring kind', () => {
    for (const kind of ['files', 'notebook', 'verbal', 'document']) {
      const tools = buildAuthoring(kind)
      expect('set_quiz_settings' in tools).toBe(false)
      expect('generate_questions' in tools).toBe(false)
      expect('list_modules' in tools).toBe(false)
    }
  })

  it('an unknown/absent kind exposes only the read tools (no apply_edits), so Athena can still brainstorm', () => {
    const tools = buildAuthoring('cad-not-a-real-kind')
    expect('apply_edits' in tools).toBe(false)
    expect('get_class_struggles' in tools).toBe(true)
  })

  it('grade mode exposes summarize_submission + fill_feedback, never apply_edits', () => {
    const tools = buildAssignmentAssistantTools({
      adminDb: mockDb(null),
      sectionId: SECTION,
      institutionId: INSTITUTION, userId: USER,
      surface: 'grade',
    })
    /* show_outcome_coverage is read-only and course-level. Its grade-surface description
       forbids using it to justify a mark, and the grading-safety prompt block repeats that.
       It is here so a professor mid-grading who asks whether this assignment hits an
       outcome gets an answer rather than a surface that has never heard of ABET. */
    expect(Object.keys(tools).sort()).toEqual(
      ['fill_feedback', 'show_outcome_coverage', 'summarize_submission'].sort(),
    )
    expect('apply_edits' in tools).toBe(false)
    expect('analyze_outcome_alignment' in tools).toBe(false)
  })

  // ── Frontier: an ORTHOGONAL mode over authoring, not a third surface ──
  // The gating here is the load-bearing part. Frontier must ADD tools and never remove
  // one, or a mode change between turns could orphan a tool call the model already made.

  it('standard mode never exposes the frontier fills', () => {
    for (const kind of ['files', 'notebook', 'verbal', 'document', 'quiz']) {
      const tools = buildAuthoring(kind)
      expect('set_rubric' in tools).toBe(false)
      expect('set_design_notes' in tools).toBe(false)
    }
  })

  it('frontier on an assignment kind adds set_rubric + set_design_notes', () => {
    const tools = buildFrontier('notebook', ASSIGNMENT)
    expect('set_rubric' in tools).toBe(true)
    expect('set_design_notes' in tools).toBe(true)
  })

  it('frontier is purely ADDITIVE — it keeps every tool standard mode has', () => {
    for (const kind of ['files', 'notebook', 'verbal', 'document']) {
      const standard = Object.keys(buildAuthoring(kind))
      const frontier = Object.keys(buildFrontier(kind, ASSIGNMENT))
      for (const name of standard) expect(frontier).toContain(name)
    }
  })

  // The create wizard registers its surface BEFORE an assignment row exists, so a
  // frontier fill there would have no subject to persist against. Withholding the tools
  // is what makes that degrade gracefully instead of failing on a NULL uuid.
  it('frontier without an assignmentId withholds both fills', () => {
    const tools = buildFrontier('files')
    expect('set_rubric' in tools).toBe(false)
    expect('set_design_notes' in tools).toBe(false)
    // …but the rest of the surface still works, so Athena can still design out loud.
    expect('apply_edits' in tools).toBe(true)
  })

  // A quiz DOES get Frontier — but never set_rubric: it has no settings.rubric and no
  // assignment-level point budget, so there is nowhere for a rubric to land. Its design
  // record hangs off quiz_id instead (one-subject XOR in the table).
  it('frontier on the quiz kind adds notes but never a rubric', () => {
    const tools = buildFrontier('quiz', ASSIGNMENT)
    expect('set_design_notes' in tools).toBe(true)
    expect('set_rubric' in tools).toBe(false)
    // and the quiz surface keeps its own tools
    expect('generate_questions' in tools).toBe(true)
    expect('list_modules' in tools).toBe(true)
  })

  it('frontier never leaks onto the grade surface', () => {
    const tools = buildAssignmentAssistantTools({
      adminDb: mockDb(null),
      sectionId: SECTION,
      institutionId: INSTITUTION, userId: USER,
      surface: 'grade',
      mode: 'frontier',
      assignmentId: ASSIGNMENT,
    })
    expect(Object.keys(tools).sort()).toEqual(
      ['fill_feedback', 'show_outcome_coverage', 'summarize_submission'].sort(),
    )
    expect(tools.set_rubric).toBeUndefined()
    expect(tools.set_design_notes).toBeUndefined()
  })

  it('no fill tool has a server execute (fills happen client-side only)', () => {
    // Every surface that can define a fill tool, unioned — so each name in
    // ASSIGNMENT_FILL_TOOLS is genuinely reached and checked, including the quiz-only ones.
    const all: Record<string, { execute?: unknown }> = {
      ...buildAuthoring('notebook'),
      ...buildAuthoring('quiz'),
      // Frontier contributes set_rubric + set_design_notes; without it those two names
      // in ASSIGNMENT_FILL_TOOLS would never be reached and this test would pass vacuously.
      ...buildFrontier('notebook', ASSIGNMENT),
      ...buildAssignmentAssistantTools({ adminDb: mockDb(null), sectionId: SECTION, institutionId: INSTITUTION, userId: USER, surface: 'grade' }),
    }
    for (const name of ASSIGNMENT_FILL_TOOLS) {
      expect(all[name]).toBeDefined()
      expect(all[name].execute).toBeUndefined()
    }
  })

  it('list_modules is read-only server-side (it has an execute; the fills do not)', () => {
    const tools = buildAuthoring('quiz') as Record<string, { execute?: unknown }>
    expect(tools.list_modules.execute).toBeDefined()
  })
})

describe('summarize_submission IDOR guard', () => {
  it('fails closed when no submission is selected', async () => {
    const res = await summarizeTool(mockDb(null), undefined).execute({})
    expect(res.ok).toBe(false)
  })

  it('returns the submission when it belongs to the verified section + institution', async () => {
    const row = {
      id: 'sub-1',
      text_content: 'My essay argues that...',
      files: [{ name: 'essay.pdf' }],
      answers: [],
      status: 'submitted',
      assignment: { section_id: SECTION, institution_id: INSTITUTION, title: 'Essay 1' },
    }
    const res = await summarizeTool(mockDb(row), 'sub-1').execute({})
    expect(res.ok).toBe(true)
    expect(res.untrustedStudentText).toContain('<untrusted_student_content>')
    expect(res.assignmentTitle).toBe('Essay 1')
  })

  it('FAILS CLOSED for a submission whose assignment is in another section', async () => {
    const row = {
      id: 'sub-x',
      text_content: "another tenant's student work",
      files: [],
      answers: [],
      status: 'submitted',
      assignment: { section_id: 'sec-OTHER', institution_id: INSTITUTION, title: 'Foreign' },
    }
    const res = await summarizeTool(mockDb(row), 'sub-x').execute({})
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).not.toContain('another tenant')
  })

  it('FAILS CLOSED for a submission in another institution', async () => {
    const row = {
      id: 'sub-y',
      text_content: 'cross-tenant leak attempt',
      files: [],
      answers: [],
      status: 'submitted',
      assignment: { section_id: SECTION, institution_id: 'inst-OTHER', title: 'Foreign' },
    }
    const res = await summarizeTool(mockDb(row), 'sub-y').execute({})
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).not.toContain('cross-tenant leak')
  })
})

/*
 * This block used to be "exactly two tools, ever", pinning a prompt-tax budget: the About
 * surface carried apply_edits and get_course_data and nothing else, so it never paid for a
 * tool it would rarely use.
 *
 * That budget was spent in the wrong place. A professor on this page asked "ABET outcomes?"
 * and the model, having no tool that could answer, reached for the only actionable one it
 * did have and tried to EDIT THE PAGE — the fill was refused (the page was in preview) and
 * the turn ended with two error notices and no answer. Measured against real traffic the
 * third tool's description costs a few hundred input tokens on a Flash turn, on a surface
 * that saw 14 turns in 90 days. That does not buy the failure it caused.
 *
 * So the budget is now three, and the tests below pin the parts that still matter: the set
 * is CLOSED (nothing else creeps in), the accreditation tool is READ-ONLY here, and the
 * Frontier fills still never reach this kind.
 */
describe('about kind — a closed three-tool set', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aboutTools = (extra: Record<string, unknown> = {}): any =>
    buildAssignmentAssistantTools({
      adminDb: mockDb(null),
      sectionId: SECTION,
      institutionId: INSTITUTION, userId: USER,
      surface: 'authoring',
      kind: 'about',
      ...extra,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

  it('exposes apply_edits + get_course_data + show_outcome_coverage and nothing else', () => {
    const tools = aboutTools()
    expect(Object.keys(tools).sort()).toEqual([
      'apply_edits',
      'get_course_data',
      'show_outcome_coverage',
    ])
  })

  it('can read accreditation coverage but never start an analysis here', () => {
    /* The run takes minutes and its progress chip, completion watcher and result card all
       live in the console. Started from this panel it would be silent on success and on
       failure, so the read comes here and the starter stays there. */
    const tools = aboutTools()
    expect(typeof tools.show_outcome_coverage.execute).toBe('function')
    expect(tools.analyze_outcome_alignment).toBeUndefined()
  })

  it('apply_edits has no server execute (fills are client-applied only)', () => {
    const tools = aboutTools()
    expect(tools.apply_edits.execute).toBeUndefined()
    expect(typeof tools.get_course_data.execute).toBe('function')
  })

  it('frontier fills never leak onto the About kind, even with mode + assignmentId forced', () => {
    const tools = aboutTools({ mode: 'frontier', assignmentId: ASSIGNMENT })
    expect(tools.set_rubric).toBeUndefined()
    expect(tools.set_design_notes).toBeUndefined()
    expect(Object.keys(tools).sort()).toEqual([
      'apply_edits',
      'get_course_data',
      'show_outcome_coverage',
    ])
  })
})

describe('project kind — exactly two tools, ever', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projectTools = (extra: Record<string, unknown> = {}): any =>
    buildAssignmentAssistantTools({
      adminDb: mockDb(null),
      sectionId: SECTION,
      institutionId: INSTITUTION, userId: USER,
      surface: 'authoring',
      kind: 'project',
      ...extra,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

  it('exposes apply_edits + get_project_context and nothing else (prompt-tax budget)', () => {
    expect(Object.keys(projectTools()).sort()).toEqual(['apply_edits', 'get_project_context'])
  })

  it('apply_edits has no server execute — a project proposal is staged client-side', () => {
    const tools = projectTools()
    expect(tools.apply_edits.execute).toBeUndefined()
    expect(typeof tools.get_project_context.execute).toBe('function')
  })

  it('get_project_context fails closed when no project is open on screen', async () => {
    // assignmentId carries the project id on this surface; without it there is no
    // subject, and the tool must say so rather than read something arbitrary.
    const res = await projectTools().get_project_context.execute({})
    expect(res.error).toBeTruthy()
  })

  it('frontier fills never leak onto the project kind', () => {
    const tools = projectTools({ mode: 'frontier', assignmentId: 'proj-1' })
    expect(tools.set_rubric).toBeUndefined()
    expect(tools.set_design_notes).toBeUndefined()
    expect(Object.keys(tools).sort()).toEqual(['apply_edits', 'get_project_context'])
  })
})
