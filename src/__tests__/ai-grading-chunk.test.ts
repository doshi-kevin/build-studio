// chunk.ts — the passage chunker for the retrieval pipeline. Pure module, no mocks.
// Pins: sentence-window overlap (3 sentences, step 2), notebook per-cell chunking
// with code fences + error outputs, and the MAX_PASSAGES truncation SIGNAL that
// lets the caller degrade a grade computed from a partial view of the submission.

import { describe, it, expect } from 'vitest'
import {
  chunkText,
  chunkNotebook,
  chunkSentenceWindows,
  chunkSubmission,
} from '@/lib/assignments/ai-grading/chunk'
import type { ParsedNotebook } from '@/lib/assignments/notebook'

describe('chunkText', () => {
  it('returns [] for empty / whitespace-only text', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n  ')).toEqual([])
  })

  it('splits on blank lines and packs small paragraphs together', () => {
    const passages = chunkText('First paragraph.\n\nSecond paragraph.')
    // Both are tiny so they pack into one passage joined by a blank line.
    expect(passages).toHaveLength(1)
    expect(passages[0].text).toBe('First paragraph.\n\nSecond paragraph.')
  })

  it('starts a new passage once the soft char cap is exceeded', () => {
    const big = 'x'.repeat(600)
    const passages = chunkText(`${big}\n\n${big}`)
    // 600 + 600 > 800 soft cap, so they cannot share a passage.
    expect(passages).toHaveLength(2)
  })

  it('hard-splits a single paragraph longer than the hard cap on sentence boundaries', () => {
    // One paragraph > 1000 chars made of many short sentences.
    const sentence = 'This is a sentence. '
    const para = sentence.repeat(80) // ~1600 chars, no blank lines
    const passages = chunkText(para)
    expect(passages.length).toBeGreaterThan(1)
    // Every produced passage stays within a reasonable bound (soft target region).
    for (const p of passages) expect(p.text.length).toBeLessThanOrEqual(1000)
  })
})

describe('chunkSentenceWindows — overlapping 3-sentence windows, step 2', () => {
  it('returns empty passages (not truncated) for empty text', () => {
    expect(chunkSentenceWindows('')).toEqual({ passages: [], truncated: false })
  })

  it('produces overlapping windows advancing two sentences at a time', () => {
    const text = 'S1. S2. S3. S4. S5.'
    const { passages } = chunkSentenceWindows(text)
    // i=0 → S1 S2 S3 ; i=2 → S3 S4 S5 (overlap on S3); then i=4 would start but
    // the i+3>=len break at i=2 already covered the tail.
    expect(passages.map((p) => p.text)).toEqual(['S1. S2. S3.', 'S3. S4. S5.'])
  })

  it('yields a single window when there are 3 or fewer sentences', () => {
    const { passages, truncated } = chunkSentenceWindows('Only one. And two.')
    expect(passages).toEqual([{ text: 'Only one. And two.' }])
    expect(truncated).toBe(false)
  })
})

import type { NotebookCell } from '@/lib/assignments/notebook'

// chunkNotebook reads only cellType / source / outputs; the cast through unknown keeps
// each fixture to the fields under test without restating role / executionCount.
function cell(c: Partial<NotebookCell>): NotebookCell {
  return c as unknown as NotebookCell
}
function nb(cells: NotebookCell[]): ParsedNotebook {
  return { cells } as ParsedNotebook
}

describe('chunkNotebook — one passage per non-empty cell', () => {
  it('fences code source and appends text + error outputs, skipping images', () => {
    const notebook = nb([
      cell({
        cellType: 'code',
        source: 'print(x)',
        outputs: [
          { type: 'text', subtype: 'stream_stdout', content: '42', truncated: false },
          { type: 'image', mime: 'image/png', dataBase64: 'base64...' },
          {
            type: 'error',
            errorType: 'ValueError',
            errorValue: 'bad',
            traceback: '',
            truncated: false,
          },
        ],
      }),
    ])
    const passages = chunkNotebook(notebook)
    expect(passages).toHaveLength(1)
    expect(passages[0].text).toContain('```\nprint(x)\n```')
    expect(passages[0].text).toContain('42')
    expect(passages[0].text).toContain('Error: ValueError: bad')
    expect(passages[0].text).not.toContain('base64')
  })

  it('emits markdown cell source verbatim and skips empty cells', () => {
    const notebook = nb([
      cell({ cellType: 'markdown', source: '# Title', outputs: [] }),
      cell({ cellType: 'markdown', source: '   ', outputs: [] }),
    ])
    const passages = chunkNotebook(notebook)
    expect(passages).toEqual([{ text: '# Title' }])
  })
})

describe('chunkSubmission — combined + truncation signal', () => {
  it('returns not-truncated when under MAX_PASSAGES', () => {
    const res = chunkSubmission('a\n\nb', [])
    expect(res.truncated).toBe(false)
    expect(res.passages.length).toBeGreaterThan(0)
  })

  it('sets truncated=true and caps at MAX_PASSAGES when the pool overflows', () => {
    // 201 blank-line-separated non-trivial paragraphs each large enough to be
    // their own passage → > 200 passages.
    const para = 'y'.repeat(900)
    const text = Array.from({ length: 201 }, () => para).join('\n\n')
    const res = chunkSubmission(text, [])
    expect(res.passages).toHaveLength(200)
    expect(res.truncated).toBe(true)
  })

  it('returns empty + not-truncated when neither text nor notebooks yield content', () => {
    expect(chunkSubmission(null, [])).toEqual({ passages: [], truncated: false })
  })
})
