// Tests for the node-key contract (the `?node=` deep link + journey-overlay
// join) and the two pure content helpers the node modal reads.
//
// The key→descriptor resolver these tests also covered (buildNodeIndex /
// resolveNodeDescriptor) retired with the old roadmap canvas — the redesigned
// canvas builds its cards from the prototype adapter instead.

import { describe, it, expect } from 'vitest'
import { questionNumbersForSkill, flattenRubricCriteria, nodeKey, parseNodeKey } from '@/lib/roadmap/node-drawer'
import { parseRubric } from '@/lib/validations/assignment'

describe('nodeKey / parseNodeKey round-trip (deep-link + selection contract)', () => {
  it('round-trips every node kind', () => {
    for (const type of ['module', 'module_item', 'quiz', 'assignment', 'live_session', 'live_poll', 'live_quiz'] as const) {
      expect(parseNodeKey(nodeKey(type, 'abc-123'))).toEqual({ type, id: 'abc-123' })
    }
  })
  it('splits on the first colon only (ids containing a colon are preserved)', () => {
    expect(parseNodeKey('quiz:a:b')).toEqual({ type: 'quiz', id: 'a:b' })
  })
})

describe('questionNumbersForSkill (quiz modal "Question N" anchor targets)', () => {
  const questions = [
    { tags: ['Word Vectors', 'N-grams'] }, // Q1
    { tags: ['Smoothing'] },               // Q2
    { tags: ['word vectors'] },            // Q3 (case-insensitive match)
    { tags: [] },                          // Q4
  ]
  it('returns 1-based positions of questions tagged with the skill', () => {
    expect(questionNumbersForSkill(questions, 'Word Vectors')).toEqual([1, 3])
    expect(questionNumbersForSkill(questions, 'Smoothing')).toEqual([2])
  })
  it('is case-insensitive and trims', () => {
    expect(questionNumbersForSkill(questions, '  n-GRAMS ')).toEqual([1])
  })
  it('returns [] for an untagged skill or empty input', () => {
    expect(questionNumbersForSkill(questions, 'Attention')).toEqual([])
    expect(questionNumbersForSkill([], 'Word Vectors')).toEqual([])
    expect(questionNumbersForSkill(questions, '')).toEqual([])
  })
  it('maps a live session’s children by their skills (Section N reuse)', () => {
    const children = [{ skills: ['Attention'] }, { skills: [] }, { skills: ['attention', 'MHA'] }]
    expect(questionNumbersForSkill(children.map((c) => ({ tags: c.skills })), 'Attention')).toEqual([1, 3])
  })
  it('matches a curated pool skill name against raw question tags canonically (issue #408)', () => {
    // Chips carry curated names from activity_skills; questions carry raw tags.
    // The same canonical rule that built that mapping must anchor the chips.
    expect(questionNumbersForSkill([{ tags: ['back-propagation'] }, { tags: ['backprop'] }], 'Backpropagation')).toEqual([1, 2])
    expect(questionNumbersForSkill(questions, 'word-vectors')).toEqual([1, 3])
    // Conservative: short fragments must not substring-match ("des" ⊄ "descent").
    expect(questionNumbersForSkill([{ tags: ['Gradient Descent'] }], 'des')).toEqual([])
  })
})

describe('flattenRubricCriteria (assignment left content)', () => {
  it('flattens questions[].criteria[].description in order, trimmed', () => {
    const rubric = {
      questions: [
        { label: 'Q1', criteria: [{ description: ' Correct encoder ', points: 5 }, { description: 'Attention wired', points: 5 }] },
        { label: 'Q2', criteria: [{ description: 'BLEU computed', points: 10 }] },
      ],
    }
    expect(flattenRubricCriteria(rubric)).toEqual(['Correct encoder', 'Attention wired', 'BLEU computed'])
  })
  it('drops empty/whitespace/non-string descriptions', () => {
    const rubric = { questions: [{ criteria: [{ description: '' }, { description: '   ' }, { description: 42 }, { description: 'ok' }] }] }
    expect(flattenRubricCriteria(rubric)).toEqual(['ok'])
  })
  it('returns [] for a missing or malformed rubric', () => {
    expect(flattenRubricCriteria(null)).toEqual([])
    expect(flattenRubricCriteria(undefined)).toEqual([])
    expect(flattenRubricCriteria({})).toEqual([])
    expect(flattenRubricCriteria({ questions: 'nope' })).toEqual([])
    expect(flattenRubricCriteria([])).toEqual([])
  })

  /* The flattener was always right; the DRAWER fed it the wrong thing. It read the
     `assignments.rubric` COLUMN, which nothing in the app writes — the
     professor-reviewed rubric is saved into `settings.rubric` (assignments actions),
     and every other consumer reads it through parseRubric. So the drawer's RUBRIC
     block could never render on a real assignment. These pin the composition the
     query now performs, using the row shape a real authored assignment has. */
  it('reads a real assignment row: settings.rubric populated, rubric column empty', () => {
    const row = {
      rubric: [],
      settings: {
        rubric: {
          questions: [
            { label: 'Q1', points: 5, criteria: [{ description: 'States the complexity class', points: 5 }] },
            { label: 'Q2', points: 5, criteria: [{ description: 'Justifies the bound', points: 5 }] },
          ],
        },
      },
    }
    expect(flattenRubricCriteria(parseRubric(row.settings)))
      .toEqual(['States the complexity class', 'Justifies the bound'])
    // The old source, for contrast: the column is empty on every real assignment.
    expect(flattenRubricCriteria(row.rubric)).toEqual([])
  })

  it('yields no criteria when the professor never authored a rubric', () => {
    expect(flattenRubricCriteria(parseRubric({}))).toEqual([])
    expect(flattenRubricCriteria(parseRubric({ rubric: { questions: [] } }))).toEqual([])
    expect(flattenRubricCriteria(parseRubric(null))).toEqual([])
  })
})
