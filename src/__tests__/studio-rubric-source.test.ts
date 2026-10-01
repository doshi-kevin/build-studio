import { describe, it, expect } from 'vitest'
import {
  studioNotebookToRubricText,
  studioDocumentToRubricText,
} from '@/lib/assignments/studio/rubric-source'
import { setAuthoring } from '@/lib/assignments/studio/authoring'
import type { StudioCell, StudioNotebook } from '@/lib/assignments/studio/notebook-model'

function cell(partial: Partial<StudioCell>): StudioCell {
  return {
    id: partial.id ?? 'c1',
    cell_type: partial.cell_type ?? 'markdown',
    source: partial.source ?? '',
    metadata: partial.metadata ?? {},
    outputs: partial.outputs ?? [],
    execution_count: partial.execution_count ?? null,
  }
}

function notebook(cells: StudioCell[]): StudioNotebook {
  return { cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }
}

describe('studioNotebookToRubricText', () => {
  it('labels a cell by its first heading and includes the prompt', () => {
    const text = studioNotebookToRubricText(
      notebook([cell({ source: '# Question 1\nCompute the derivative of x^2.' })]),
    )
    expect(text).toContain('## Question 1')
    expect(text).toContain('Compute the derivative of x^2.')
  })

  it('includes points and the professor answer key when present', () => {
    const meta = setAuthoring({}, { points: 8, answerKey: '2x' })
    const text = studioNotebookToRubricText(
      notebook([cell({ source: '# Q1\nDerivative?', metadata: meta })]),
    )
    expect(text).toContain('## Q1 (8 points)')
    expect(text).toContain('Expected answer: 2x')
  })

  it('fences code cells so the source reads as code context', () => {
    const text = studioNotebookToRubricText(
      notebook([cell({ cell_type: 'code', source: 'def f(x):\n    return x' })]),
    )
    expect(text).toContain('```\ndef f(x):\n    return x\n```')
  })

  it('falls back to a positional label and skips fully empty cells', () => {
    const text = studioNotebookToRubricText(
      notebook([
        cell({ id: 'a', source: '' }), // empty, no answer key → skipped
        cell({ id: 'b', source: 'Just a prompt, no heading.' }),
      ]),
    )
    expect(text).not.toContain('Cell 1')
    expect(text).toContain('## Cell 2')
    expect(text).toContain('Just a prompt, no heading.')
  })

  it('keeps an answer-key-only cell (no source) in the text', () => {
    const meta = setAuthoring({}, { points: 5, answerKey: '42' })
    const text = studioNotebookToRubricText(notebook([cell({ source: '', metadata: meta })]))
    expect(text).toContain('## Cell 1 (5 points)')
    expect(text).toContain('Expected answer: 42')
  })

  it('returns an empty string for a notebook with no gradable content', () => {
    expect(studioNotebookToRubricText(notebook([cell({ source: '   ' })]))).toBe('')
    expect(studioNotebookToRubricText(notebook([]))).toBe('')
  })

  it('folds in the professor-authored pedagogy metadata', () => {
    const meta = setAuthoring(
      {},
      {
        difficulty: 'hard',
        bloom: 'analyze',
        conceptTags: ['derivatives', 'limits'],
        explanation: 'Apply the power rule.',
        hints: ['Start with the exponent', 'Then subtract one'],
      },
    )
    const text = studioNotebookToRubricText(notebook([cell({ source: '# Q1\nDerivative?', metadata: meta })]))
    expect(text).toContain('Difficulty: hard')
    expect(text).toContain('Bloom level: analyze')
    expect(text).toContain('Concepts: derivatives, limits')
    expect(text).toContain('Explanation: Apply the power rule.')
    expect(text).toContain('Hints:\n- Start with the exponent\n- Then subtract one')
  })
})

describe('studioDocumentToRubricText', () => {
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
  const heading = (text: string) => ({ type: 'heading', content: [{ type: 'text', text }] })
  const doc = (content: unknown[]) => ({ type: 'doc', content })

  it('flattens heading + paragraph text with a break between blocks', () => {
    const text = studioDocumentToRubricText(
      doc([heading('Question 1'), para('Compute the derivative of x^2.')]),
    )
    expect(text).toBe('Question 1\nCompute the derivative of x^2.')
  })

  it('walks nested list items and marks each as a block', () => {
    const text = studioDocumentToRubricText(
      doc([
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [para('first')] },
            { type: 'listItem', content: [para('second')] },
          ],
        },
      ]),
    )
    expect(text).toContain('first')
    expect(text).toContain('second')
    // list items and their paragraphs are both block-level, so the two entries stay separated
    expect(text).toMatch(/first[\s\S]*second/)
  })

  it('collapses 3+ consecutive blank lines to a single blank line and trims', () => {
    const text = studioDocumentToRubricText(
      doc([para('a'), { type: 'paragraph', content: [] }, { type: 'paragraph', content: [] }, para('b')]),
    )
    expect(text).not.toMatch(/\n{3,}/)
    expect(text.startsWith('\n')).toBe(false)
    expect(text.endsWith('\n')).toBe(false)
  })

  it('returns an empty string for null, non-object, or empty docs', () => {
    expect(studioDocumentToRubricText(null)).toBe('')
    expect(studioDocumentToRubricText('nope')).toBe('')
    expect(studioDocumentToRubricText(doc([]))).toBe('')
  })
})
