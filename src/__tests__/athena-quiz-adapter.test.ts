/**
 * Athena ↔ Quiz Studio adapter.
 *
 * What these pin down, in order of how badly a regression would hurt:
 *  1. changed=0 whenever an op cannot land — the panel reports applied:false from this,
 *     so a false success means Athena tells the professor it edited a blank canvas.
 *  2. Every skip carries its REASON in the summary, which is what lets the model correct
 *     itself on the next turn.
 *  3. The representation translation (clean arrays → the studio's comma-strings,
 *     {value}[] objects, id-bearing choices, inline blank tokens). Get this wrong and the
 *     autosave silently drops the edit.
 *  4. Purity — the studio applies ops inside a functional setState, so mutating the input
 *     array would corrupt a concurrent generation batch.
 */
import { describe, it, expect } from 'vitest'
import {
  applyQuizOps,
  applyQuizSettings,
  serializeQuizForAthena,
  type QuizAthenaSettings,
} from '@/lib/quiz/athena-quiz-adapter'
import { createBlankQuestion, type WizardQuestion } from '@/components/professor/quizzes/wizard/QuestionEditorCard'
import type { QuizOp } from '@/lib/ai/assignment-assistant/templates/registry'
import type { QuizItemType } from '@/lib/validations/quiz'

/** A saved question of `type` (dbId set = persisted, which is what locks its type). */
function saved(type: QuizItemType, text: string, over: Partial<WizardQuestion> = {}): WizardQuestion {
  const q = createBlankQuestion(type)
  return { ...q, dbId: q.clientId, questionText: text, ...over }
}

const mcqFields = {
  questionType: 'multiple_choice' as const,
  questionText: 'What is 2 + 2?',
  choices: [
    { text: '4', isCorrect: true },
    { text: '5', isCorrect: false },
  ],
}

const SETTINGS: QuizAthenaSettings = {
  title: 'Midterm',
  description: '',
  timeLimitMinutes: null,
  maxAttempts: 1,
  passThreshold: 60,
  dueDate: null,
  shuffleQuestions: false,
  shuffleAnswers: false,
  showExplanations: 'after_submission',
  negativeMarking: false,
  negativeMarkingPenalty: 0.25,
  adaptiveMode: false,
}

describe('applyQuizOps', () => {
  it('inserts at the end, and after a given id', () => {
    const a = saved('true_false', 'A')
    const b = saved('true_false', 'B')

    const appended = applyQuizOps([a, b], [{ op: 'insert', question: mcqFields }])
    expect(appended.changed).toBe(1)
    expect(appended.questions.map((q) => q.questionText)).toEqual(['A', 'B', 'What is 2 + 2?'])
    expect(appended.touchedId).toBe(appended.questions[2].clientId)

    const between = applyQuizOps([a, b], [{ op: 'insert', afterId: a.clientId, question: mcqFields }])
    expect(between.questions.map((q) => q.questionText)).toEqual(['A', 'What is 2 + 2?', 'B'])
  })

  it('updates by id, removes by id, and reorders by id', () => {
    const a = saved('true_false', 'A')
    const b = saved('true_false', 'B')
    const c = saved('true_false', 'C')

    const updated = applyQuizOps([a, b], [{ op: 'update', id: b.clientId, question: { questionText: 'B2', points: 5 } }])
    expect(updated.changed).toBe(1)
    expect(updated.questions[1].questionText).toBe('B2')
    expect(updated.questions[1].points).toBe(5)
    expect(updated.questions[0].questionText).toBe('A')

    const removed = applyQuizOps([a, b, c], [{ op: 'remove', id: b.clientId }])
    expect(removed.changed).toBe(1)
    expect(removed.questions.map((q) => q.questionText)).toEqual(['A', 'C'])

    const moved = applyQuizOps([a, b, c], [{ op: 'reorder', id: c.clientId, afterId: a.clientId }])
    expect(moved.questions.map((q) => q.questionText)).toEqual(['A', 'C', 'B'])

    const toTop = applyQuizOps([a, b, c], [{ op: 'reorder', id: c.clientId }])
    expect(toTop.questions.map((q) => q.questionText)).toEqual(['C', 'A', 'B'])
  })

  it('never mutates the questions it was given', () => {
    const a = saved('multiple_choice', 'A')
    const input = [a]
    const before = JSON.stringify(input)

    applyQuizOps(input, [
      { op: 'update', id: a.clientId, question: { questionText: 'changed', tags: ['x'] } },
      { op: 'insert', question: mcqFields },
    ])

    expect(JSON.stringify(input)).toBe(before)
    expect(input).toHaveLength(1)
  })

  it('translates the model representation into the studio shape', () => {
    const res = applyQuizOps(
      [],
      [
        {
          op: 'insert',
          question: {
            ...mcqFields,
            tags: ['Recursion', 'Base Case'],
            bloomsLevel: 'apply',
            explanation: 'Because addition.',
          },
        },
        {
          op: 'insert',
          question: {
            questionType: 'short_answer',
            questionText: 'Name the capital of France.',
            acceptedAnswers: ['Paris', 'paris'],
          },
        },
      ],
    )
    expect(res.changed).toBe(2)

    const [mcq, sa] = res.questions
    // tags: string[] → comma string
    expect(mcq.tags).toBe('Recursion, Base Case')
    // choices gain stable ids the studio can key on
    expect(mcq.choices).toHaveLength(2)
    expect(mcq.choices.every((c) => !!c.id)).toBe(true)
    expect(mcq.choices.filter((c) => c.isCorrect).map((c) => c.text)).toEqual(['4'])
    // acceptedAnswers: string[] → {value}[]
    expect(sa.acceptedAnswers).toEqual([{ value: 'Paris' }, { value: 'paris' }])
    // never invents a dbId — only a confirmed insert may set one
    expect(mcq.dbId).toBeUndefined()
  })

  it('stores fill-in-blank answers inline and derives the blanks array from the text', () => {
    const res = applyQuizOps(
      [],
      [
        {
          op: 'insert',
          question: {
            questionType: 'fill_in_blank',
            questionText: 'The capital of France is _____ and of Spain is _____.',
            blanks: [{ acceptedAnswers: ['Paris'] }, { acceptedAnswers: ['Madrid'] }],
          },
        },
      ],
    )
    expect(res.changed).toBe(1)
    const q = res.questions[0]
    expect(q.questionText).toMatch(/\{\{blank:[^}]+:Paris\}\}/)
    expect(q.blanks).toHaveLength(2)
    expect(q.blanks.map((b) => b.acceptedAnswers)).toEqual(['Paris', 'Madrid'])
  })

  it('keeps existing blank answers when only the sentence is rewritten', () => {
    const built = applyQuizOps(
      [],
      [
        {
          op: 'insert',
          question: {
            questionType: 'fill_in_blank',
            questionText: 'The capitol of France is _____.',
            blanks: [{ acceptedAnswers: ['Paris'] }],
          },
        },
      ],
    ).questions[0]

    const fixed = applyQuizOps(
      [built],
      [{ op: 'update', id: built.clientId, question: { questionText: 'The capital of France is _____.' } }],
    )
    expect(fixed.changed).toBe(1)
    expect(fixed.questions[0].blanks.map((b) => b.acceptedAnswers)).toEqual(['Paris'])
    expect(fixed.questions[0].questionText).toContain('capital')
  })

  it('tokenizes a NEW _____ marker added to a question that already has blanks', () => {
    // The consultant caught this: guarding tokenization on "no tokens yet" left a newly
    // added raw marker untokenized, so the marker count and the blanks array disagreed and
    // the studio flagged the question unsavable. Adding a blank to an existing FIB is the
    // normal case, not an exotic one.
    const built = applyQuizOps(
      [],
      [
        {
          op: 'insert',
          question: {
            questionType: 'fill_in_blank',
            questionText: 'The capital of France is _____.',
            blanks: [{ acceptedAnswers: ['Paris'] }],
          },
        },
      ],
    ).questions[0]

    const extended = applyQuizOps(
      [built],
      [
        {
          op: 'update',
          id: built.clientId,
          question: {
            // first blank already tokenized in the stored text; the second is a raw marker
            questionText: `${built.questionText} The capital of Spain is _____.`,
            blanks: [{ acceptedAnswers: ['Paris'] }, { acceptedAnswers: ['Madrid'] }],
          },
        },
      ],
    )
    expect(extended.changed).toBe(1)
    const q = extended.questions[0]
    expect(q.blanks.map((b) => b.acceptedAnswers)).toEqual(['Paris', 'Madrid'])
    // no raw markers survive, and the two tokens have distinct ids
    expect(q.questionText).not.toMatch(/_{3,}/)
    const ids = [...q.questionText.matchAll(/\{\{blank:([^:}]+)/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(2)
  })

  describe('skips without counting, and says why', () => {
    it('an unknown target id', () => {
      const res = applyQuizOps([saved('true_false', 'A')], [{ op: 'update', id: 'nope', question: { points: 3 } }])
      expect(res.changed).toBe(0)
      expect(res.summary).toMatch(/no question with that id/i)
    })

    it('an insert with no question type', () => {
      const res = applyQuizOps([], [{ op: 'insert', question: { questionText: 'orphan' } }])
      expect(res.changed).toBe(0)
      expect(res.summary).toMatch(/needs a question type/i)
    })

    it('a multiple-choice question without two choices or without a correct one', () => {
      const thin = applyQuizOps(
        [],
        [{ op: 'insert', question: { questionType: 'multiple_choice', questionText: 'q', choices: [{ text: 'only', isCorrect: true }] } }],
      )
      expect(thin.changed).toBe(0)
      expect(thin.summary).toMatch(/at least 2 choices with one marked correct/i)

      const noCorrect = applyQuizOps(
        [],
        [
          {
            op: 'insert',
            question: {
              questionType: 'multiple_choice',
              questionText: 'q',
              choices: [
                { text: 'a', isCorrect: false },
                { text: 'b', isCorrect: false },
              ],
            },
          },
        ],
      )
      expect(noCorrect.changed).toBe(0)
      expect(noCorrect.summary).toMatch(/at least 2 choices with one marked correct/i)
    })

    it('warns in the summary when an AI-graded question needs Adaptive mode on', () => {
      // The studio REFUSES to publish an explanation/walkthrough item while Adaptive is
      // off. Athena may still add one (the professor may be about to turn Adaptive on),
      // but staying silent left them holding an unpublishable quiz with no hint why — QA
      // caught her adding one with the whole reply being "Added an explanation question."
      const withAdaptiveOff = applyQuizOps(
        [],
        [
          {
            op: 'insert',
            question: {
              questionType: 'explanation',
              questionText: 'Explain positional encoding.',
              rubric: [{ concept: 'order information' }],
            },
          },
        ],
        { adaptiveMode: false },
      )
      expect(withAdaptiveOff.changed).toBe(1)
      expect(withAdaptiveOff.summary).toMatch(/Adaptive mode must be turned on/i)

      // Adaptive on: it lands with no warning to relay.
      const withAdaptiveOn = applyQuizOps(
        [],
        [
          {
            op: 'insert',
            question: {
              questionType: 'explanation',
              questionText: 'Explain positional encoding.',
              rubric: [{ concept: 'order information' }],
            },
          },
        ],
        { adaptiveMode: true },
      )
      expect(withAdaptiveOn.changed).toBe(1)
      expect(withAdaptiveOn.summary).not.toMatch(/Adaptive/i)

      // A closed-answer question never triggers it, whatever Adaptive says.
      const mcq = applyQuizOps([], [{ op: 'insert', question: mcqFields }], { adaptiveMode: false })
      expect(mcq.summary).not.toMatch(/Adaptive/i)
    })

    it('an explanation or walkthrough question with no rubric concept', () => {
      for (const questionType of ['explanation', 'walkthrough'] as const) {
        const res = applyQuizOps([], [{ op: 'insert', question: { questionType, questionText: 'Explain X.' } }])
        expect(res.changed).toBe(0)
        expect(res.summary).toMatch(/needs at least one rubric concept/i)
      }
    })

    it('a type change on a question that is already saved', () => {
      const q = saved('multiple_choice', 'A')
      const res = applyQuizOps([q], [{ op: 'update', id: q.clientId, question: { questionType: 'short_answer' } }])
      expect(res.changed).toBe(0)
      expect(res.summary).toMatch(/already saved cannot change type/i)
    })

    it('but DOES retype a question that has not been saved yet', () => {
      const fresh = createBlankQuestion('multiple_choice')
      const res = applyQuizOps(
        [fresh],
        [
          {
            op: 'update',
            id: fresh.clientId,
            question: { questionType: 'short_answer', questionText: 'Capital of France?', acceptedAnswers: ['Paris'] },
          },
        ],
      )
      expect(res.changed).toBe(1)
      expect(res.questions[0].questionType).toBe('short_answer')
      expect(res.questions[0].clientId).toBe(fresh.clientId)
    })

    it('a fill-in-blank whose marker count does not match its blanks', () => {
      const res = applyQuizOps(
        [],
        [
          {
            op: 'insert',
            question: {
              questionType: 'fill_in_blank',
              questionText: 'A _____ and a _____.',
              blanks: [{ acceptedAnswers: ['one'] }],
            },
          },
        ],
      )
      expect(res.changed).toBe(0)
      expect(res.summary).toMatch(/markers must match the number of blanks/i)
    })

    it('a fill-in-blank with no marker at all', () => {
      const res = applyQuizOps(
        [],
        [{ op: 'insert', question: { questionType: 'fill_in_blank', questionText: 'No blank here.' } }],
      )
      expect(res.changed).toBe(0)
      expect(res.summary).toMatch(/needs a _____ marker/i)
    })

    it('reports changed=0 with no false success for a whole batch that lands nothing', () => {
      const a = saved('true_false', 'A')
      const ops: QuizOp[] = [
        { op: 'update', id: 'ghost', question: { points: 2 } },
        { op: 'remove', id: 'ghost' },
        { op: 'insert', question: { questionText: 'typeless' } },
      ]
      const res = applyQuizOps([a], ops)
      expect(res.changed).toBe(0)
      expect(res.questions).toEqual([a])
      expect(res.touchedId).toBeNull()
      expect(res.summary).toMatch(/^Nothing changed —/)
    })

    it('still applies the good ops in a mixed batch and counts only those', () => {
      const a = saved('true_false', 'A')
      const res = applyQuizOps([a], [
        { op: 'insert', question: mcqFields },
        { op: 'remove', id: 'ghost' },
      ])
      expect(res.changed).toBe(1)
      expect(res.questions).toHaveLength(2)
      expect(res.summary).toMatch(/Added 1 question · skipped 1: no question with that id/i)
    })
  })
})

describe('applyQuizSettings', () => {
  it('sets only what it was given and names it', () => {
    const res = applyQuizSettings(SETTINGS, { timeLimitMinutes: 60, maxAttempts: 2, shuffleQuestions: true })
    expect(res.changed).toBe(3)
    expect(res.values.timeLimitMinutes).toBe(60)
    expect(res.values.maxAttempts).toBe(2)
    expect(res.values.shuffleQuestions).toBe(true)
    expect(res.values.passThreshold).toBe(60)
    expect(res.summary).toBe('Set time limit, attempts, question shuffling')
    expect(SETTINGS.timeLimitMinutes).toBeNull()
  })

  it('translates the 0 / empty-string sentinels back into null', () => {
    const withLimits = applyQuizSettings(SETTINGS, { timeLimitMinutes: 45, dueDate: '2026-08-14' }).values
    expect(withLimits.timeLimitMinutes).toBe(45)
    expect(withLimits.dueDate).toBe('2026-08-14')

    // 0 / '' are how the model says "clear it" — a nullable schema field would render as
    // the anyOf union Gemini mishandles, so the translation lives here instead.
    const cleared = applyQuizSettings(withLimits, { timeLimitMinutes: 0, dueDate: '' })
    expect(cleared.changed).toBe(2)
    expect(cleared.values.timeLimitMinutes).toBeNull()
    expect(cleared.values.dueDate).toBeNull()

    // maxAttempts joined the sentinel list: 0 means "no limit", stored as null (#43)
    const unlimited = applyQuizSettings({ ...SETTINGS, maxAttempts: 3 }, { maxAttempts: 0 })
    expect(unlimited.changed).toBe(1)
    expect(unlimited.values.maxAttempts).toBeNull()
    // and a value well past the old ceiling of 10 goes through untouched
    expect(applyQuizSettings(SETTINGS, { maxAttempts: 99 }).values.maxAttempts).toBe(99)
  })

  it('counts nothing when the values already match', () => {
    const res = applyQuizSettings(SETTINGS, { maxAttempts: 1, passThreshold: 60 })
    expect(res.changed).toBe(0)
    expect(res.summary).toMatch(/already set that way/i)
  })
})

describe('serializeQuizForAthena', () => {
  it('renders the full stem and answer key per question', () => {
    const mcq = applyQuizOps([], [{ op: 'insert', question: { ...mcqFields, tags: ['math'] } }]).questions[0]
    const state = serializeQuizForAthena([mcq], SETTINGS, { isGenerating: false })

    expect(state.kind).toBe('quiz')
    expect(state.components?.[0]).toMatchObject({ id: mcq.clientId, type: 'multiple_choice' })
    const content = state.components?.[0].content ?? ''
    expect(content).toContain('What is 2 + 2?')
    expect(content).toContain('1. 4  ✓')
    expect(content).toContain('tags: math')
    // not persisted yet, and the model needs to know
    expect(content).toContain('[not yet saved]')
  })

  // Issue #43: null maxAttempts is a real setting (unlimited retakes), not an unset
  // field. The other nullables drop out of the snapshot when null, so this one is
  // spelled out — omitting it would let Athena tell the professor attempts are unset.
  it('spells out an unlimited attempt count instead of dropping it', () => {
    const unlimited = serializeQuizForAthena([], { ...SETTINGS, maxAttempts: null }, { isGenerating: false })
    expect(unlimited.meta?.maxAttempts).toBe('no limit')

    const capped = serializeQuizForAthena([], { ...SETTINGS, maxAttempts: 99 }, { isGenerating: false })
    expect(capped.meta?.maxAttempts).toBe(99)
  })

  it('flags a missing rubric as the publish blocker it is', () => {
    const q = saved('explanation', 'Explain gradient descent.')
    const content = serializeQuizForAthena([q], SETTINGS, { isGenerating: false }).components?.[0].content ?? ''
    expect(content).toMatch(/rubric: NONE YET/)
    expect(content).toMatch(/cannot be published/)
  })

  it('shows fill-in-blank text as plain markers, never raw tokens', () => {
    const q = applyQuizOps(
      [],
      [
        {
          op: 'insert',
          question: {
            questionType: 'fill_in_blank',
            questionText: 'Water boils at _____ degrees.',
            blanks: [{ acceptedAnswers: ['100'] }],
          },
        },
      ],
    ).questions[0]
    const content = serializeQuizForAthena([q], SETTINGS, { isGenerating: false }).components?.[0].content ?? ''
    expect(content).toContain('Water boils at _____ degrees.')
    expect(content).not.toContain('{{blank')
    expect(content).toContain('blank 1: 100')
  })

  it('reports a generation in flight, and omits the counters when idle', () => {
    const running = serializeQuizForAthena([], SETTINGS, { isGenerating: true, generatedSoFar: 7, requested: 20 })
    expect(running.meta).toMatchObject({ isGenerating: true, generatedSoFar: 7, requested: 20 })

    const idle = serializeQuizForAthena([], SETTINGS, { isGenerating: false })
    expect(idle.meta?.isGenerating).toBe(false)
    expect(idle.meta?.generatedSoFar).toBeUndefined()
    // null settings are omitted rather than sent as null (meta takes scalars only)
    expect(idle.meta?.timeLimitMinutes).toBeUndefined()
    expect(idle.meta?.dueDate).toBeUndefined()
  })

  it('surfaces the last run ONLY when it came up short', () => {
    // A shortfall is the one thing Athena has to volunteer unprompted (the shortfall banner
    // is gone, so this snapshot is the professor's only route to hearing about it). The
    // inverse matters just as much: reporting a run that delivered in full would have her
    // apologising for a quiz that is exactly what was asked for.
    const short = serializeQuizForAthena([], SETTINGS, {
      isGenerating: false,
      lastRun: { requested: 30, delivered: 22 },
    })
    expect(short.meta).toMatchObject({ lastRunRequested: 30, lastRunDelivered: 22 })

    const full = serializeQuizForAthena([], SETTINGS, {
      isGenerating: false,
      lastRun: { requested: 30, delivered: 30 },
    })
    expect(full.meta?.lastRunRequested).toBeUndefined()
    expect(full.meta?.lastRunDelivered).toBeUndefined()
  })
})
