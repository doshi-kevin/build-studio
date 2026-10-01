import { describe, it, expect } from 'vitest'
import { parseRubric, parseRubricDraft, rubricPointIssues, rubricTotalPoints, areGradesPublished, reopenWindowSchema, resolveReopenUntil, gradeSubmissionSchema, splitRubricAi, mergeRubricAi, stripRubricAiFields, parseRubricAi } from '@/lib/validations/assignment'
import type { AssignmentRubric } from '@/lib/validations/assignment'

describe('areGradesPublished — student grade-visibility gate', () => {
  it('is true ONLY when settings.gradesPublished === true', () => {
    expect(areGradesPublished({ gradesPublished: true })).toBe(true)
  })

  it('is false when the flag is absent (private by default)', () => {
    expect(areGradesPublished({})).toBe(false)
    expect(areGradesPublished({ other: 'value' })).toBe(false)
  })

  it('is false when the flag is explicitly false', () => {
    expect(areGradesPublished({ gradesPublished: false })).toBe(false)
  })

  it('does not treat truthy-but-not-true values as published (strict ===)', () => {
    // Guards against an attacker/state shaping gradesPublished into a truthy non-boolean.
    expect(areGradesPublished({ gradesPublished: 'true' })).toBe(false)
    expect(areGradesPublished({ gradesPublished: 1 })).toBe(false)
  })

  it('is false for null / undefined / non-object settings (never crashes)', () => {
    expect(areGradesPublished(null)).toBe(false)
    expect(areGradesPublished(undefined)).toBe(false)
    expect(areGradesPublished('published')).toBe(false)
    expect(areGradesPublished(42)).toBe(false)
  })
})

const valid = {
  rubric: {
    questions: [
      { label: 'Q1', points: 10, criteria: [{ description: 'Correct algorithm', points: 6 }] },
    ],
  },
}

describe('parseRubric', () => {
  it('returns a valid rubric off settings', () => {
    const r = parseRubric(valid)
    expect(r?.questions).toHaveLength(1)
    expect(r?.questions[0].label).toBe('Q1')
    expect(r?.questions[0].criteria[0].points).toBe(6)
  })

  it('returns null when there are no questions', () => {
    expect(parseRubric({ rubric: { questions: [] } })).toBeNull()
  })

  it('returns null for missing / malformed rubric', () => {
    expect(parseRubric({})).toBeNull()
    expect(parseRubric(null)).toBeNull()
    expect(parseRubric({ rubric: { questions: [{ label: 'Q1' }] } })).toBeNull() // points missing
  })
})

describe('parseRubricDraft — lenient, mid-edit draft', () => {
  it('reads a well-formed draft off settings.rubricDraft', () => {
    const d = parseRubricDraft(valid.rubric ? { rubricDraft: valid.rubric } : {})
    expect(d?.questions).toHaveLength(1)
    expect(d?.questions[0].label).toBe('Q1')
  })

  it('accepts blank labels/descriptions that the strict parser rejects (leniency boundary)', () => {
    const draft = { rubricDraft: { questions: [{ label: '', points: 10, criteria: [{ description: '', points: 2 }] }] } }
    // Strict parseRubric rejects blank label/description; the draft parser keeps it.
    expect(parseRubric(draft.rubricDraft ? { rubric: draft.rubricDraft } : {})?.questions ?? null).toBeNull()
    expect(parseRubricDraft(draft)?.questions).toHaveLength(1)
  })

  it('accepts an over-budget draft (point checks are deferred to approval)', () => {
    const draft = { rubricDraft: { questions: [{ label: 'Q1', points: 9999, criteria: [] }] } }
    expect(parseRubricDraft(draft)?.questions[0].points).toBe(9999)
  })

  it('returns null for empty / absent / non-object settings', () => {
    expect(parseRubricDraft({ rubricDraft: { questions: [] } })).toBeNull()
    expect(parseRubricDraft({})).toBeNull()
    expect(parseRubricDraft(null)).toBeNull()
    expect(parseRubricDraft('nope')).toBeNull()
  })
})

describe('rubricPointIssues', () => {
  const q = (points: number, crit: number[], graded?: false) => ({
    points,
    criteria: crit.map((p) => ({ description: 'x', points: p })),
    graded,
  })

  it('passes when criteria fit their questions; gradedSum = sum of graded question points', () => {
    const r = rubricPointIssues([q(10, [6, 4]), q(5, [5])])
    expect(r.hasError).toBe(false)
    expect(r.perQuestion).toEqual([null, null])
    expect(r.gradedSum).toBe(15)
    expect(r.excludedCount).toBe(0)
  })

  it('no longer flags when question totals exceed the assignment points (rubric drives the total now)', () => {
    // Both lineages agree: the rubric sets assignment.points; there is no fixed cap to exceed.
    const r = rubricPointIssues([q(80, []), q(40, [])])
    expect(r.hasError).toBe(false)
    expect(r.gradedSum).toBe(120)
    expect(r.overall).toBeNull()
  })

  it('flags the specific question whose criteria exceed its points', () => {
    const r = rubricPointIssues([q(10, [8, 6]), q(5, [5])])
    expect(r.hasError).toBe(true)
    expect(r.perQuestion[0]).toMatch(/14 pts, over this question's 10/)
    expect(r.perQuestion[1]).toBeNull()
    expect(r.overall).toBeNull()
  })

  it('allows negative (deduction) criteria below the question budget', () => {
    const r = rubricPointIssues([q(10, [10, -3])])
    expect(r.hasError).toBe(false)
  })

  it('allows exact-fit budgets (boundary: sum === limit is not an error)', () => {
    const r = rubricPointIssues([q(60, [60]), q(40, [40])])
    expect(r.hasError).toBe(false) // criteria exactly fill each question
  })

  it('skips excluded (graded===false) questions in gradedSum, perQuestion, and warnings', () => {
    const r = rubricPointIssues([q(10, [6, 4]), q(5, [5], false)])
    expect(r.gradedSum).toBe(10)
    expect(r.excludedCount).toBe(1)
    expect(r.perQuestion).toEqual([null, null]) // excluded question returns null (no check)
    expect(r.perQuestionWarning).toEqual([null, null]) // excluded never warns either
    expect(r.hasError).toBe(false)
  })

  it('WARNS (non-blocking) when criteria are under a question\'s declared points', () => {
    // Q1 declares 20 but criteria only add to 15 → 5 pts are not grabbable. Advisory, not an error.
    const r = rubricPointIssues([q(20, [10, 5]), q(10, [10])])
    expect(r.hasError).toBe(false) // never blocks save
    expect(r.perQuestion).toEqual([null, null])
    expect(r.perQuestionWarning[0]).toMatch(/15 pts, under this question's 20/)
    expect(r.perQuestionWarning[1]).toBeNull() // 10 == 10, fully allocated
  })

  it('does not warn AND error for the same question (error wins)', () => {
    const r = rubricPointIssues([q(10, [8, 6])]) // over budget → error, not a warning
    expect(r.perQuestion[0]).toMatch(/over this question's 10/)
    expect(r.perQuestionWarning[0]).toBeNull()
  })
})

describe('rubricTotalPoints — assignment total is derived from the rubric', () => {
  const q = (points: number, crit: number[]) => ({
    label: 'Q',
    points,
    criteria: crit.map((p) => ({ description: 'x', points: p })),
  })

  it('sums every criterion across all questions', () => {
    expect(rubricTotalPoints([q(50, [30, 20]), q(20, [20])])).toBe(70)
  })

  it('goes over 100 when the rubric does (no cap)', () => {
    expect(rubricTotalPoints([q(80, [80]), q(40, [40])])).toBe(120)
  })

  it('falls back to 100 when the rubric has no points (all criteria 0/blank)', () => {
    expect(rubricTotalPoints([q(0, [0]), q(0, [])])).toBe(100)
    expect(rubricTotalPoints([])).toBe(100)
  })
})

describe('reopenWindowSchema', () => {
  const NOW = new Date('2026-07-21T12:00:00.000Z').getTime()

  it('accepts hours in [1, 720]', () => {
    expect(reopenWindowSchema.safeParse({ hours: 1 }).success).toBe(true)
    expect(reopenWindowSchema.safeParse({ hours: 24 }).success).toBe(true)
    expect(reopenWindowSchema.safeParse({ hours: 720 }).success).toBe(true)
  })

  it('rejects hours out of range', () => {
    expect(reopenWindowSchema.safeParse({ hours: 0 }).success).toBe(false)
    expect(reopenWindowSchema.safeParse({ hours: 721 }).success).toBe(false)
  })

  it('accepts a future UTC ISO datetime', () => {
    const future = new Date(Date.now() + 2 * 86400000).toISOString()
    expect(reopenWindowSchema.safeParse({ until: future }).success).toBe(true)
  })

  it('rejects a past datetime', () => {
    const past = new Date(Date.now() - 1000).toISOString()
    expect(reopenWindowSchema.safeParse({ until: past }).success).toBe(false)
  })

  it('accepts undefined (optional — defaults to 24h)', () => {
    expect(reopenWindowSchema.safeParse(undefined).success).toBe(true)
  })

  it('resolveReopenUntil with hours returns nowMs + hours*3600000', () => {
    const result = resolveReopenUntil({ hours: 24 }, NOW)
    expect(new Date(result).getTime()).toBe(NOW + 24 * 3600000)
  })

  it('resolveReopenUntil with until passthrough returns the same date string', () => {
    const until = new Date(NOW + 48 * 3600000).toISOString()
    const result = resolveReopenUntil({ until }, NOW)
    expect(new Date(result).getTime()).toBe(new Date(until).getTime())
  })

  it('resolveReopenUntil with undefined defaults to 24h', () => {
    const result = resolveReopenUntil(undefined, NOW)
    expect(new Date(result).getTime()).toBe(NOW + 24 * 3600000)
  })
})

describe('gradeSubmissionSchema — rubricComments', () => {
  const base = { submissionId: '12345678-1234-4234-b234-123456789abc', score: 85 }

  it('accepts valid rubricComments with numeric string keys', () => {
    const r = gradeSubmissionSchema.safeParse({ ...base, rubricComments: { '0': 'Great', '12': 'Check this' } })
    expect(r.success).toBe(true)
  })

  it('rejects non-numeric-string keys', () => {
    const r = gradeSubmissionSchema.safeParse({ ...base, rubricComments: { 'foo': 'text' } })
    expect(r.success).toBe(false)
  })

  it('rejects comment longer than 5000 chars', () => {
    const r = gradeSubmissionSchema.safeParse({ ...base, rubricComments: { '0': 'x'.repeat(5001) } })
    expect(r.success).toBe(false)
  })

  it('rubricComments is optional', () => {
    expect(gradeSubmissionSchema.safeParse(base).success).toBe(true)
  })
})

// ── splitRubricAi / mergeRubricAi — the answer-key data-model split (BLOCKER #1) ──
// The AI-grading fields ARE the answer key. They must not live in settings.rubric,
// which the student RLS SELECT policy exposes as a whole JSONB row (Postgres can't mask
// sub-keys). splitRubricAi peels them into a staff-only blob; mergeRubricAi grafts them
// back for staff editors + the grader. These pin two invariants that, if broken, leak the
// answer key: (1) split's publicRubric carries NO AI field, and (2) split then merge is a
// faithful round-trip so the split is lossless (never a reason to keep AI fields inline).

// A full rubric exercising EVERY AI field at both levels, plus the public fields that must
// survive: graded===false (kept), skills (kept), a negative-points deduction criterion.
const fullRubric: AssignmentRubric = {
  questions: [
    {
      label: 'Q1',
      points: 10,
      skills: [{ id: 'sk-1', name: 'Recursion' }],
      scoringRules: ['award 5 for a correct base case'],
      antiCriteria: ['do not penalize missing comments'],
      criteria: [
        {
          description: 'Explains recursion',
          points: 6,
          referenceAnswer: 'a function that calls itself with a smaller input',
          absoluteKeywords: ['base case'],
          paraphrases: ['self-referential function'],
          distractors: ['iteration', 'a loop'],
          keywordAliases: [{ term: 'base case', aliases: ['stopping condition'] }],
          checkMode: 'similarity',
        },
        { description: 'Penalty for plagiarism', points: -4 },
      ],
    },
    {
      // A graded===false (excluded) question with an AI field on its criterion — split must
      // still peel it (exclusion is a grading concern, not a "safe to expose" signal).
      label: 'Q2',
      points: 5,
      graded: false,
      criteria: [{ description: 'Bonus', points: 5, referenceAnswer: 'the bonus answer' }],
    },
  ],
}

const AI_CRITERION_KEYS = [
  'referenceAnswer',
  'absoluteKeywords',
  'paraphrases',
  'distractors',
  'keywordAliases',
  'checkMode',
] as const
const AI_QUESTION_KEYS = ['scoringRules', 'antiCriteria'] as const

describe('splitRubricAi — the public rubric leaks NO answer-key field', () => {
  it('produces a publicRubric with zero AI fields at either level (the leak guard)', () => {
    const { publicRubric } = splitRubricAi(fullRubric)
    for (const q of publicRubric.questions) {
      for (const k of AI_QUESTION_KEYS) expect(q[k]).toBeUndefined()
      for (const c of q.criteria) {
        for (const k of AI_CRITERION_KEYS) expect(c[k]).toBeUndefined()
      }
    }
  })

  it('publicRubric === stripRubricAiFields output (single source of truth for what is safe)', () => {
    const { publicRubric } = splitRubricAi(fullRubric)
    expect(publicRubric).toEqual(stripRubricAiFields(fullRubric))
  })

  it('keeps the student-safe fields: label, points (incl. negative), graded===false, skills', () => {
    const { publicRubric } = splitRubricAi(fullRubric)
    expect(publicRubric.questions[0].label).toBe('Q1')
    expect(publicRubric.questions[0].points).toBe(10)
    expect(publicRubric.questions[0].skills).toEqual([{ id: 'sk-1', name: 'Recursion' }])
    expect(publicRubric.questions[0].criteria[1].points).toBe(-4) // deduction survives
    expect(publicRubric.questions[1].graded).toBe(false) // exclusion survives
  })

  it('captures every AI field in the blob, index-aligned ("<q>" and "<q>:<c>")', () => {
    const { rubricAi } = splitRubricAi(fullRubric)
    // Question-level: Q1 (index 0) has scoringRules + antiCriteria; Q2 has none.
    expect(rubricAi.questions['0']).toEqual({
      scoringRules: ['award 5 for a correct base case'],
      antiCriteria: ['do not penalize missing comments'],
    })
    expect(rubricAi.questions['1']).toBeUndefined()
    // Criterion-level: Q1's first criterion (0:0) carries the full AI payload; the
    // deduction criterion (0:1) has none, so it is absent from the blob entirely.
    expect(rubricAi.criteria['0:0']).toEqual({
      referenceAnswer: 'a function that calls itself with a smaller input',
      absoluteKeywords: ['base case'],
      paraphrases: ['self-referential function'],
      distractors: ['iteration', 'a loop'],
      keywordAliases: [{ term: 'base case', aliases: ['stopping condition'] }],
      checkMode: 'similarity',
    })
    expect(rubricAi.criteria['0:1']).toBeUndefined()
    expect(rubricAi.criteria['1:0']).toEqual({ referenceAnswer: 'the bonus answer' })
  })
})

describe('mergeRubricAi — split then merge is a faithful round-trip', () => {
  it('reconstructs the ORIGINAL full rubric from publicRubric + blob (lossless split)', () => {
    const { publicRubric, rubricAi } = splitRubricAi(fullRubric)
    expect(mergeRubricAi(publicRubric, rubricAi)).toEqual(fullRubric)
  })

  it('survives a JSON round-trip of the blob (as it is stored in / read from JSONB)', () => {
    const { publicRubric, rubricAi } = splitRubricAi(fullRubric)
    const persisted = parseRubricAi(JSON.parse(JSON.stringify(rubricAi)))
    expect(mergeRubricAi(publicRubric, persisted)).toEqual(fullRubric)
  })

  it('is a no-op when the blob is null / undefined / empty (pre-migration + legacy rows)', () => {
    const { publicRubric } = splitRubricAi(fullRubric)
    expect(mergeRubricAi(publicRubric, null)).toEqual(publicRubric)
    expect(mergeRubricAi(publicRubric, undefined)).toEqual(publicRubric)
    expect(mergeRubricAi(publicRubric, { criteria: {}, questions: {} })).toEqual(publicRubric)
  })

  it('grafts back only the indexes present, leaving other criteria untouched', () => {
    const { publicRubric } = splitRubricAi(fullRubric)
    const partial = { criteria: { '0:0': { referenceAnswer: 'only this one' } }, questions: {} }
    const merged = mergeRubricAi(publicRubric, partial)
    expect(merged.questions[0].criteria[0].referenceAnswer).toBe('only this one')
    // Untouched criterion has no AI field grafted on.
    expect(merged.questions[0].criteria[1].referenceAnswer).toBeUndefined()
    expect(merged.questions[1].criteria[0].referenceAnswer).toBeUndefined()
  })
})

describe('parseRubricAi — coerces untrusted JSONB (DB default [] / legacy shapes)', () => {
  it('degrades the DB default [] and other non-objects to an empty blob (merge no-op)', () => {
    expect(parseRubricAi([])).toEqual({ criteria: {}, questions: {} })
    expect(parseRubricAi(null)).toEqual({ criteria: {}, questions: {} })
    expect(parseRubricAi('nonsense')).toEqual({ criteria: {}, questions: {} })
    expect(parseRubricAi(42)).toEqual({ criteria: {}, questions: {} })
  })

  it('drops malformed criteria/questions members but keeps a well-formed one', () => {
    const parsed = parseRubricAi({ criteria: { '0:0': { referenceAnswer: 'x' } }, questions: 'bad' })
    expect(parsed.criteria['0:0']).toEqual({ referenceAnswer: 'x' })
    expect(parsed.questions).toEqual({})
  })
})
