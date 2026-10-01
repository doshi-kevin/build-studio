// @vitest-environment node
//
// Font-independent code detection (ooxml.ts): looksLikeCode catches code set in
// a proportional font (no monospace signal), while staying conservative enough
// not to mis-tag prose/lists/math. guessCodeLanguage is a best-effort syntax cue.
import { describe, it, expect } from 'vitest'
import { looksLikeCode, guessCodeLanguage } from '@/lib/document-parser/ooxml'

const PY = `def binary_search(arr, target):
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1`

const JS = `function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}`

describe('looksLikeCode', () => {
  it('detects code regardless of font (the non-monospace gap)', () => {
    expect(looksLikeCode(PY)).toBe(true)
    expect(looksLikeCode(JS)).toBe(true)
  })

  it('does NOT mis-tag prose, bullet lists, or short fragments', () => {
    const prose =
      'Word embeddings capture distributional semantics. The Skip-gram model ' +
      'predicts context words from a center word, while GloVe synthesizes global ' +
      'statistics with local context. Both produce dense vectors.'
    const bullets = 'Key topics:\n- Language modeling\n- Smoothing strategies\n- Attention mechanisms'
    expect(looksLikeCode(prose)).toBe(false)
    expect(looksLikeCode(bullets)).toBe(false)
    expect(looksLikeCode('x = 1')).toBe(false) // too short (1 line)
  })
})

describe('guessCodeLanguage', () => {
  it('identifies common languages from syntax cues', () => {
    expect(guessCodeLanguage(PY)).toBe('python')
    expect(guessCodeLanguage(JS)).toBe('javascript')
    expect(guessCodeLanguage('SELECT id, name FROM users WHERE age > 21;')).toBe('sql')
  })

  it('returns undefined when the language is unclear', () => {
    expect(guessCodeLanguage('a + b - c')).toBeUndefined()
  })
})
