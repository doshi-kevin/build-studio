/**
 * Schema-bound tests for the studio + verbal-assessment validation schemas.
 *
 * These schemas are the SECURITY boundary for attacker-shaped JSON: an uploaded .ipynb
 * (parsed, then re-validated) and a stored verbal config read back out of settings JSONB.
 * Per the project convention we don't re-test trivial Zod built-ins — we test the bounds
 * that actually defend the boundary (MAX_CELLS / source size) and the custom parse helper.
 */
import { describe, it, expect } from 'vitest'
import { studioDocSchema } from '@/lib/validations/studio'
import {
  verbalAssessmentSchema,
  parseVerbalAssessment,
} from '@/lib/validations/verbal-assessment'
import { parseNotebookModel } from '@/lib/assignments/studio/notebook-model'

const MAX_CELLS = 1000
const MAX_SOURCE_CHARS = 200_000

function cell(source = '') {
  return { id: 'c1', cell_type: 'code' as const, source, metadata: {}, outputs: [], execution_count: null }
}
function doc(cells: ReturnType<typeof cell>[]) {
  return { version: 1, templateId: null, notebook: { cells, metadata: {}, nbformat: 4, nbformat_minor: 5 } }
}

describe('studioDocSchema — bounds that defend the .ipynb import boundary', () => {
  it('accepts a small, well-formed notebook', () => {
    expect(studioDocSchema.safeParse(doc([cell('print(1)')])).success).toBe(true)
  })

  it('rejects a notebook with more than MAX_CELLS cells', () => {
    const tooMany = Array.from({ length: MAX_CELLS + 1 }, () => cell())
    expect(studioDocSchema.safeParse(doc(tooMany)).success).toBe(false)
  })

  it('accepts exactly MAX_CELLS cells (boundary)', () => {
    const atLimit = Array.from({ length: MAX_CELLS }, () => cell())
    expect(studioDocSchema.safeParse(doc(atLimit)).success).toBe(true)
  })

  it('rejects a cell whose source exceeds MAX_SOURCE_CHARS', () => {
    expect(studioDocSchema.safeParse(doc([cell('x'.repeat(MAX_SOURCE_CHARS + 1))])).success).toBe(false)
  })

  it('rejects an invalid cell_type', () => {
    const bad = { ...cell(), cell_type: 'sql' }
    expect(studioDocSchema.safeParse(doc([bad as never])).success).toBe(false)
  })

  it('rejects a document that blows the total byte cap via oversized metadata (per-count bounds miss this)', () => {
    // One small cell that passes every per-count bound, but carries a >5MB metadata value.
    const d = doc([cell('x')])
    d.notebook.cells[0].metadata = { blob: 'a'.repeat(6 * 1024 * 1024) }
    expect(studioDocSchema.safeParse(d).success).toBe(false)
  })
})

describe('studioDocSchema — full parse → re-validate path (the upload action does exactly this)', () => {
  it('accepts a real parsed notebook wrapped as an upload doc', () => {
    const parsed = parseNotebookModel({
      cells: [{ cell_type: 'markdown', id: 'a', metadata: {}, source: '# Title' }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    })!
    const check = studioDocSchema.safeParse({ version: 1, templateId: 'upload', notebook: parsed })
    expect(check.success).toBe(true)
  })

  it('rejects an oversized parsed notebook (the bound stops a hostile import)', () => {
    const parsed = parseNotebookModel({
      cells: Array.from({ length: MAX_CELLS + 5 }, (_, i) => ({
        cell_type: 'code',
        id: `c${i}`,
        metadata: {},
        outputs: [],
        execution_count: null,
        source: 'x',
      })),
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    })!
    const check = studioDocSchema.safeParse({ version: 1, templateId: 'upload', notebook: parsed })
    expect(check.success).toBe(false)
  })
})

describe('verbalAssessmentSchema — bounds + clamps', () => {
  const base = { voiceId: 'v1', cells: [] }

  it('accepts a minimal config with required voiceId', () => {
    expect(verbalAssessmentSchema.safeParse(base).success).toBe(true)
  })

  it('rejects a missing voiceId (required, no default)', () => {
    expect(verbalAssessmentSchema.safeParse({ cells: [] }).success).toBe(false)
  })

  it('rejects maxFollowUpDepth above the allowed max (5)', () => {
    expect(verbalAssessmentSchema.safeParse({ ...base, maxFollowUpDepth: 6 }).success).toBe(false)
  })

  it('rejects timeLimitMinutes below the allowed min (1)', () => {
    expect(verbalAssessmentSchema.safeParse({ ...base, timeLimitMinutes: 0 }).success).toBe(false)
  })

  it('rejects more than 50 cells', () => {
    const cells = Array.from({ length: 51 }, (_, i) => ({ id: `q${i}`, type: 'question' as const }))
    expect(verbalAssessmentSchema.safeParse({ ...base, cells }).success).toBe(false)
  })

  it('accepts an MCQ cell with authored branch follow-ups', () => {
    const cells = [{ id: 'm1', type: 'mcq' as const, prompt: 'Pick one', correctOptionId: 'o1', followUps: { correct: 'Why?', incorrect: 'What went wrong?' } }]
    expect(verbalAssessmentSchema.safeParse({ ...base, cells }).success).toBe(true)
  })

  it('rejects a follow-up branch prompt over the 2000-char bound', () => {
    const cells = [{ id: 'm1', type: 'mcq' as const, followUps: { correct: 'x'.repeat(2001) } }]
    expect(verbalAssessmentSchema.safeParse({ ...base, cells }).success).toBe(false)
  })
})

describe('parseVerbalAssessment — reads stored config out of settings JSON', () => {
  it('returns null when the key is absent', () => {
    expect(parseVerbalAssessment({})).toBeNull()
    expect(parseVerbalAssessment(null)).toBeNull()
  })

  it('returns null when the stored config is malformed (missing voiceId)', () => {
    expect(parseVerbalAssessment({ verbalAssessment: { cells: [] } })).toBeNull()
  })

  it('parses a valid stored config', () => {
    const config = parseVerbalAssessment({ verbalAssessment: { voiceId: 'v1', cells: [] } })
    expect(config).not.toBeNull()
    expect(config!.voiceId).toBe('v1')
  })
})
