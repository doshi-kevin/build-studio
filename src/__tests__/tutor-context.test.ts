// Phase 4a — AI-tutor context now includes tables/figures/code with [Title, page N]
// citation markers (src/lib/document-parser getExtractionContextForLLM).
import { describe, it, expect } from 'vitest'
import { getExtractionContextForLLM } from '@/lib/document-parser'
import { buildAiTutorPrompt } from '@/lib/ai/student-tutor/prompt'

const pages = [
  { pageNumber: 14, text: 'Self-attention computes weighted sums of values.', headings: [] },
  { pageNumber: 15, text: '', headings: [] }, // empty + no units → skipped
]

describe('getExtractionContextForLLM', () => {
  it('tags each page with a citeable [Title, page N] marker and includes units', () => {
    const ctx = getExtractionContextForLLM('Transformers', pages, { pageCount: 2, wordCount: 7 }, {
      tables: [{ pageNumber: 14, html: '<table><tr><td>Year</td><td>N</td></tr><tr><td>2020</td><td>1200</td></tr></table>' }],
      figures: [{ pageNumber: 14, description: 'an encoder-decoder diagram with attention' }],
      code: [{ pageNumber: 14, code: 'def f(x):\n    return x + 1', language: 'python' }],
    })

    expect(ctx).toContain('[Transformers, page 14]')
    expect(ctx).toContain('Self-attention computes weighted sums')
    // table compacted to pipe rows
    expect(ctx).toContain('Year | N')
    expect(ctx).toContain('2020 | 1200')
    // figure flagged AI-described; code labeled with language
    expect(ctx).toContain('Figure (AI-described): an encoder-decoder diagram with attention')
    expect(ctx).toContain('Code (python):\ndef f(x):')
    // page 15 (empty, no units) is skipped
    expect(ctx).not.toContain('page 15')
  })

  it('works with no units (page text only)', () => {
    const ctx = getExtractionContextForLLM('Doc', [{ pageNumber: 1, text: 'hello', headings: [] }], undefined)
    expect(ctx).toBe('[Doc, page 1]\nhello')
  })

  it('surfaces a unit whose page has no extracted text (no silent drop)', () => {
    // page 5 has a vision-read table but no text entry in pages[] — must still appear
    const ctx = getExtractionContextForLLM('Doc', [{ pageNumber: 1, text: 'intro', headings: [] }], undefined, {
      tables: [{ pageNumber: 5, html: '<table><tr><td>recovered</td></tr></table>' }],
    })
    expect(ctx).toContain('[Doc, page 1]')
    expect(ctx).toContain('[Doc, page 5]')
    expect(ctx).toContain('recovered')
  })

  it('renders an empty <table> as a (harmless) empty Table block without throwing', () => {
    const ctx = getExtractionContextForLLM('D', [{ pageNumber: 1, text: 'x', headings: [] }], undefined, {
      tables: [{ pageNumber: 1, html: '<table></table>' }],
    })
    expect(ctx).toContain('Table:')
  })

  it('unescapes HTML entities in table cells', () => {
    const ctx = getExtractionContextForLLM('D', [{ pageNumber: 1, text: '', headings: [] }], undefined, {
      tables: [{ pageNumber: 1, html: '<table><tr><td>a &lt; b</td><td>x &amp; y</td></tr></table>' }],
    })
    expect(ctx).toContain('a < b | x & y')
  })

  // Phase 5b — charts (de-plotted series CSV) join tables/figures/code in context.
  it('renders chart data with its title, labelling the block', () => {
    const ctx = getExtractionContextForLLM('Report', [{ pageNumber: 1, text: 'intro', headings: [] }], undefined, {
      charts: [{ pageNumber: 1, title: 'Enrollment by year', data: 'category,Enrollment\n2020,1200' }],
    })
    expect(ctx).toContain('Chart (Enrollment by year):\ncategory,Enrollment\n2020,1200')
  })

  it('renders an untitled chart as a bare Chart block', () => {
    const ctx = getExtractionContextForLLM('Report', [{ pageNumber: 1, text: 'intro', headings: [] }], undefined, {
      charts: [{ pageNumber: 1, data: 'category,v\nA,1' }],
    })
    expect(ctx).toContain('Chart:\ncategory,v\nA,1')
    expect(ctx).not.toContain('Chart (')
  })

  it('surfaces a chart on a page with no extracted text (no silent drop)', () => {
    // mirrors the XLSX path: chart-only page 1, text lives elsewhere
    const ctx = getExtractionContextForLLM('Report', [{ pageNumber: 2, text: 'body', headings: [] }], undefined, {
      charts: [{ pageNumber: 1, title: 'Sales', data: 'category,s\nQ1,10' }],
    })
    expect(ctx).toContain('[Report, page 1]')
    expect(ctx).toContain('Chart (Sales):')
  })
})

// ── AI-tutor prompt: the materials / no-materials branch ──────────────────
//
// Pinned because the no-materials branch was dead on arrival once: the chat route
// 422'd on empty content before the prompt was ever built, so a student in a
// course with nothing uploaded got "Something went wrong" instead of a tutor.
// These assert the two branches actually differ in the ways that matter.
describe('buildAiTutorPrompt', () => {
  const base = { courseTitle: 'Advanced Machine Learning', courseCode: 'CS-620', sectionCode: '01' }

  it('with materials: appends them and requires citations for material-backed claims', () => {
    const p = buildAiTutorPrompt({ ...base, content: '[Slides, page 3] Gradient descent steps downhill.' })

    expect(p).toContain('--- Course Materials ---')
    expect(p).toContain('Gradient descent steps downhill.')
    expect(p).toContain('[Document Title, page N]')
    // must still teach on-subject gaps rather than deflecting
    expect(p).toContain("Never refuse an on-subject question just because it wasn't uploaded.")
  })

  it('with no materials: tutors the subject instead of refusing, and forbids invented citations', () => {
    const p = buildAiTutorPrompt({ ...base, content: '' })

    // no empty materials block dangling at the end of the prompt
    expect(p).not.toContain('--- Course Materials ---')
    // does not tell the model to cite pages it cannot have
    expect(p).not.toContain('[Document Title, page N]')
    expect(p).toContain('Never invent a citation')
    expect(p).toContain('teach the subject from your own knowledge')
    // and must not announce the empty course to the student
    expect(p).toContain('Do NOT tell the student the course has no materials')
  })

  it('scopes both branches to the course subject rather than open-ended help', () => {
    for (const content of ['', 'some extracted text']) {
      const p = buildAiTutorPrompt({ ...base, content })
      expect(p).toContain('Advanced Machine Learning')
      expect(p).toContain("Stay on the course's subject.")
    }
  })

  // It shipped telling Scholera students to go look in Canvas/Blackboard, because
  // nothing told it which LMS it was running in. Both branches deflect to "ask
  // your professor", so both need the guard.
  it('never points the student at a competing LMS, in either branch', () => {
    for (const content of ['', 'some extracted text']) {
      const p = buildAiTutorPrompt({ ...base, content })
      expect(p).toContain('You are running INSIDE this course')
      expect(p).toMatch(/do not name or allude to Canvas, Blackboard, Moodle/)
    }
  })

  it('treats whitespace-only content as no materials (not as a materials block)', () => {
    const p = buildAiTutorPrompt({ ...base, content: '   \n  ' })
    expect(p).not.toContain('--- Course Materials ---')
    expect(p).toContain('Never invent a citation')
  })
})
