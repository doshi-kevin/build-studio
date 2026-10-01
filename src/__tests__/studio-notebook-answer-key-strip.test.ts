// Pins stripNotebookAnswerKeys (src/lib/validations/studio.ts).
//
// Incident: a studio NOTEBOOK is handed whole to a 'use client' component on the
// student assignment page, so every cell's `metadata.studio.answerKey` was serialized
// into the RSC payload and readable in DevTools before the student submitted. The
// student view only hid it visually (showAnswerKey={false}). Hiding is not withholding.
//
// The two halves that must BOTH hold, and that a careless "just delete metadata.studio"
// rewrite would break in opposite directions:
//   1. answerKey is gone — from every cell, at any nesting the notebook uses.
//   2. hints / explanation / points / difficulty SURVIVE — PedagogyCorner deliberately
//      renders those to students, so over-stripping silently removes working features.

import { describe, it, expect } from 'vitest'
import { stripNotebookAnswerKeys } from '@/lib/validations/studio'

/** A notebook cell carrying the full AuthoringMeta surface. */
function cell(id: string, studio: Record<string, unknown> | undefined) {
  return {
    id,
    type: 'prompt',
    content: `body of ${id}`,
    ...(studio === undefined ? {} : { metadata: { studio, custom: 'keep-me' } }),
  }
}

const FULL_META = {
  answerKey: 'The answer is 42 — do not ship this to students',
  hints: ['try substitution', 'check the units'],
  explanation: 'Because the integral converges.',
  points: 10,
  difficulty: 'hard',
}

describe('stripNotebookAnswerKeys — removes the key', () => {
  it('drops answerKey from every cell that has one', () => {
    const out = stripNotebookAnswerKeys({
      cells: [cell('c1', { ...FULL_META }), cell('c2', { ...FULL_META })],
    })

    for (const c of out.cells as { metadata: { studio: Record<string, unknown> } }[]) {
      expect('answerKey' in c.metadata.studio).toBe(false)
    }
  })

  it('leaves no trace of the answer key anywhere in the serialized payload', () => {
    // The real failure mode is "readable in DevTools", i.e. present ANYWHERE in what
    // gets serialized — not merely absent from the one property we thought to check.
    const out = stripNotebookAnswerKeys({ cells: [cell('c1', { ...FULL_META })] })
    expect(JSON.stringify(out)).not.toContain('do not ship this to students')
  })

  it('does not mutate the caller\'s notebook (the professor view shares the object)', () => {
    const input = { cells: [cell('c1', { ...FULL_META })] }
    stripNotebookAnswerKeys(input)
    const original = input.cells[0] as { metadata: { studio: Record<string, unknown> } }
    expect(original.metadata.studio.answerKey).toBe(FULL_META.answerKey)
  })
})

describe('stripNotebookAnswerKeys — preserves everything else', () => {
  it('keeps hints, explanation, points and difficulty', () => {
    const out = stripNotebookAnswerKeys({ cells: [cell('c1', { ...FULL_META })] })
    const studio = (out.cells[0] as { metadata: { studio: Record<string, unknown> } })
      .metadata.studio

    expect(studio.hints).toEqual(['try substitution', 'check the units'])
    expect(studio.explanation).toBe('Because the integral converges.')
    expect(studio.points).toBe(10)
    expect(studio.difficulty).toBe('hard')
  })

  it('keeps non-studio metadata siblings and the cell body', () => {
    const out = stripNotebookAnswerKeys({ cells: [cell('c1', { ...FULL_META })] })
    const c = out.cells[0] as { content: string; metadata: { custom: string } }
    expect(c.metadata.custom).toBe('keep-me')
    expect(c.content).toBe('body of c1')
  })

  it('keeps top-level notebook fields outside `cells`', () => {
    const out = stripNotebookAnswerKeys({
      title: 'Week 3 Notebook',
      version: 2,
      cells: [cell('c1', { ...FULL_META })],
    })
    expect(out.title).toBe('Week 3 Notebook')
    expect(out.version).toBe(2)
  })
})

describe('stripNotebookAnswerKeys — shapes that must not throw', () => {
  it('passes through a cell with no metadata at all', () => {
    const out = stripNotebookAnswerKeys({ cells: [cell('c1', undefined)] })
    expect((out.cells[0] as { id: string }).id).toBe('c1')
  })

  it('passes through a cell whose studio meta has no answerKey', () => {
    const out = stripNotebookAnswerKeys({ cells: [cell('c1', { points: 5 })] })
    const studio = (out.cells[0] as { metadata: { studio: Record<string, unknown> } })
      .metadata.studio
    expect(studio.points).toBe(5)
  })

  it('tolerates a non-object studio value', () => {
    const out = stripNotebookAnswerKeys({ cells: [cell('c1', 'nonsense' as never)] })
    expect(out.cells).toHaveLength(1)
  })

  it('tolerates an empty cell list', () => {
    expect(stripNotebookAnswerKeys({ cells: [] }).cells).toEqual([])
  })

  it('returns a malformed notebook unchanged rather than throwing', () => {
    const bad = { cells: null } as unknown as { cells: unknown[] }
    expect(stripNotebookAnswerKeys(bad)).toBe(bad)
  })
})
