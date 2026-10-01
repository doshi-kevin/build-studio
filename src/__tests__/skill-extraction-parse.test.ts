// Tests for parseTopicsAndSummary — the topic+summary parser behind the
// best-effort extraction step. Covers the clean object form, the legacy bare
// array, the truncated-JSON regex fallback, key-name filtering, and the
// summary length cap.

import { describe, it, expect } from 'vitest'
import { parseTopicsAndSummary } from '@/lib/ai/llm-client'

describe('parseTopicsAndSummary', () => {
  it('parses the canonical {summary, topics} object', () => {
    const r = parseTopicsAndSummary(
      '{"summary":"Covers attention and transformers.","topics":["Self-Attention","Transformers"]}',
    )
    expect(r.summary).toBe('Covers attention and transformers.')
    expect(r.topics).toEqual(['Self-Attention', 'Transformers'])
  })

  it('still accepts a bare topics array (no summary)', () => {
    const r = parseTopicsAndSummary('["Neural Networks", "Gradient Descent"]')
    expect(r.summary).toBeNull()
    expect(r.topics).toEqual(['Neural Networks', 'Gradient Descent'])
  })

  it('tolerates surrounding markdown fences / prose around the JSON', () => {
    const r = parseTopicsAndSummary('```json\n{"summary":"A.","topics":["X","Y"]}\n```')
    expect(r.summary).toBe('A.')
    expect(r.topics).toEqual(['X', 'Y'])
  })

  it('caps an overlong summary', () => {
    const long = 'x'.repeat(400)
    const r = parseTopicsAndSummary(`{"summary":"${long}","topics":["A","B"]}`)
    expect(r.summary).not.toBeNull()
    expect(r.summary!.length).toBeLessThanOrEqual(240)
  })

  it('recovers topics from truncated JSON via the quoted-string fallback', () => {
    // No closing braces — JSON.parse fails, regex path runs.
    const r = parseTopicsAndSummary('{"topics":["Convolutions","Pooling","Stride"')
    expect(r.topics).toEqual(['Convolutions', 'Pooling', 'Stride'])
  })

  it('does not treat the "topics"/"summary" key names as topics in the fallback', () => {
    const r = parseTopicsAndSummary('"summary" "topics" "Real Topic One" "Real Topic Two"')
    expect(r.topics).toEqual(['Real Topic One', 'Real Topic Two'])
  })

  it('returns null topics when nothing usable is present', () => {
    expect(parseTopicsAndSummary('not json at all, one "x"').topics).toBeNull()
  })
})
