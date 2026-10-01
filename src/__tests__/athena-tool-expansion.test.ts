import { describe, it, expect } from 'vitest'
import {
  challengeDraftSchema,
  assignmentDraftSchema,
  rubricDraftSchema,
  feedbackDraftSchema,
  differentiatedDraftSchema,
} from '@/lib/ai/professor-assistant/schemas'
import {
  toChallengeInput,
  toAssignmentInput,
  rubricToMarkdown,
  feedbackToMessage,
} from '@/lib/ai/professor-assistant/translate'

// These tools became real DB writes only through the approve adapters, which
// re-validate against the strict server schemas. The load-bearing guarantees
// worth testing are (a) the loose draft schema accepts a sane draft and rejects
// a malformed one, and (b) the pure translator maps the draft into the exact
// server-action shape — including the two safety invariants the design pins:
// draft_challenge never carries a badge_id, and draft_feedback never carries a score.

describe('challengeDraftSchema + toChallengeInput', () => {
  it('accepts a complete draft and applies enum/number defaults', () => {
    const parsed = challengeDraftSchema.parse({ title: 'Refactor sprint' })
    expect(parsed.type).toBe('general')
    expect(parsed.difficulty).toBe('medium')
    expect(parsed.points).toBe(10)
    expect(parsed.bonusPoints).toBe(0)
  })

  it('rejects an out-of-range difficulty', () => {
    expect(challengeDraftSchema.safeParse({ title: 'X', difficulty: 'impossible' }).success).toBe(false)
  })

  it('translates camelCase → snake_case and NEVER sets badge_id', () => {
    const draft = challengeDraftSchema.parse({
      title: 'Big-O Challenge',
      description: 'Beat the baseline',
      type: 'coding',
      difficulty: 'hard',
      points: 25,
      bonusPoints: 5,
      maxClaims: 10,
      dueDate: '2026-07-01',
    })
    const input = toChallengeInput(draft)
    expect(input).toMatchObject({
      title: 'Big-O Challenge',
      type: 'coding',
      difficulty: 'hard',
      points: 25,
      bonus_points: 5,
      max_claims: 10,
      due_at: '2026-07-01',
    })
    // The model can't know real badge UUIDs — a badge must never be auto-assigned.
    expect('badge_id' in input).toBe(false)
  })

  it('maps an absent due date / claim cap to null and an omitted description to ""', () => {
    const input = toChallengeInput(challengeDraftSchema.parse({ title: 'X' }))
    expect(input.due_at).toBeNull()
    expect(input.max_claims).toBeNull()
    // Deliberate undefined → '' mapping (the server schema also defaults '').
    expect(input.description).toBe('')
  })
})

describe('assignmentDraftSchema + toAssignmentInput', () => {
  it('applies defaults and accepts a text-only assignment', () => {
    const parsed = assignmentDraftSchema.parse({ title: 'Reflection paper' })
    expect(parsed.points).toBe(100)
    expect(parsed.fileTypes).toEqual([])
  })

  it('rejects an unknown file type', () => {
    expect(assignmentDraftSchema.safeParse({ title: 'X', fileTypes: ['mp4'] }).success).toBe(false)
  })

  it('maps dueDate → dueAt and passes through points + fileTypes', () => {
    const draft = assignmentDraftSchema.parse({
      title: 'Lab Report 3',
      instructions: 'Write up the experiment and submit your analysis.',
      points: 50,
      dueDate: '2026-07-15',
      fileTypes: ['pdf', 'doc'],
    })
    const input = toAssignmentInput(draft)
    expect(input).toMatchObject({
      title: 'Lab Report 3',
      instructions: 'Write up the experiment and submit your analysis.',
      points: 50,
      dueAt: '2026-07-15',
      fileTypes: ['pdf', 'doc'],
    })
  })

  it('maps an absent due date to null and omitted instructions to ""', () => {
    const input = toAssignmentInput(assignmentDraftSchema.parse({ title: 'X' }))
    expect(input.dueAt).toBeNull()
    expect(input.instructions).toBe('')
  })
})

describe('rubricDraftSchema + rubricToMarkdown', () => {
  it('requires at least 2 levels per criterion', () => {
    const bad = rubricDraftSchema.safeParse({
      title: 'R',
      criteria: [{ name: 'Thesis', levels: [{ label: 'Good', points: 10, description: 'ok' }] }],
    })
    expect(bad.success).toBe(false)
  })

  it('renders each criterion and level into markdown', () => {
    const draft = rubricDraftSchema.parse({
      title: 'Essay Rubric',
      criteria: [
        {
          name: 'Argument',
          description: 'clarity of thesis',
          levels: [
            { label: 'Excellent', points: 10, description: 'clear and defended' },
            { label: 'Developing', points: 5, description: 'unclear' },
          ],
        },
      ],
    })
    const md = rubricToMarkdown(draft)
    expect(md).toContain('## Essay Rubric')
    expect(md).toContain('### Argument — clarity of thesis')
    expect(md).toContain('**Excellent** (10 pts): clear and defended')
    expect(md).toContain('**Developing** (5 pts): unclear')
  })

  it('renders a criterion heading with no em-dash when description is omitted', () => {
    const draft = rubricDraftSchema.parse({
      title: 'R',
      criteria: [{ name: 'Clarity', levels: [
        { label: 'Good', points: 10, description: 'ok' },
        { label: 'Poor', points: 0, description: 'no' },
      ] }],
    })
    const md = rubricToMarkdown(draft)
    expect(md).toContain('### Clarity\n')
    expect(md).not.toContain('### Clarity —')
  })
})

describe('feedbackDraftSchema + feedbackToMessage', () => {
  it('rejects empty feedback', () => {
    expect(feedbackDraftSchema.safeParse({ feedback: '' }).success).toBe(false)
  })

  it('has NO score field and only ever emits the feedback text', () => {
    const parsed = feedbackDraftSchema.parse({
      studentName: 'Marcus',
      feedback: '  Strong intro; next, tighten your conclusion.  ',
      // A score must never survive into the pipeline even if the model emits one.
      score: 88,
    } as Record<string, unknown>)
    expect('score' in parsed).toBe(false)
    expect(feedbackToMessage(parsed)).toBe('Strong intro; next, tighten your conclusion.')
  })
})

describe('differentiatedDraftSchema', () => {
  it('accepts a known variant and rejects an unknown one', () => {
    expect(differentiatedDraftSchema.safeParse({ title: 'T', variant: 'ell', content: 'x' }).success).toBe(true)
    expect(differentiatedDraftSchema.safeParse({ title: 'T', variant: 'grade-3', content: 'x' }).success).toBe(false)
  })
})
