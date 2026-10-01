// keywords.ts — normalizeForMatch, keywordPresent, and the checkKeywords driver.
// Pure module: no mocks. These pin the decimal-point preservation fix (a dot
// between digits survives normalization so "3.14" stays one token), the
// whole-word + plural/singular matching rules, and the alias fallback that stops
// an equivalent surface form from being scored a keyword miss.

import { describe, it, expect } from 'vitest'
import {
  normalizeForMatch,
  keywordPresent,
  checkKeywords,
  type KeywordAlias,
} from '@/lib/assignments/ai-grading/keywords'

describe('normalizeForMatch', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeForMatch('  Hello   WORLD  ')).toBe('hello world')
  })

  it('turns hyphens into spaces so "well-known" ≡ "well known"', () => {
    expect(normalizeForMatch('well-known')).toBe('well known')
  })

  it('KEEPS the dot inside a decimal number (the decimal fix)', () => {
    // The load-bearing bug: a naive [^\w\s] strip removes the dot and turns
    // "3.14" into "314" (or "3 14"). The guarded pass must preserve it.
    expect(normalizeForMatch('pi is 3.14 exactly')).toBe('pi is 3.14 exactly')
  })

  it('strips a trailing sentence dot that is NOT digit-flanked', () => {
    expect(normalizeForMatch('the end.')).toBe('the end')
  })

  it('strips a dot with a digit on only one side (not a decimal)', () => {
    // "v2." — dot follows a digit but is not flanked by digits on both sides.
    expect(normalizeForMatch('version v2.')).toBe('version v2')
    // "3." at end of a clause is not a decimal either.
    expect(normalizeForMatch('step 3. next')).toBe('step 3 next')
  })

  it('strips assorted punctuation but keeps word chars', () => {
    expect(normalizeForMatch('O(n), then; done!')).toBe('o n then done')
  })
})

describe('keywordPresent — whole-word sequence containment', () => {
  it('matches a single token as a whole word', () => {
    expect(keywordPresent('recursion', 'this uses recursion here')).toBe(true)
  })

  it('does NOT match a substring inside a larger token', () => {
    // "cat" must not match inside "concatenate".
    expect(keywordPresent('cat', 'we concatenate the arrays')).toBe(false)
  })

  it('matches a multi-token phrase only when the tokens appear in order', () => {
    expect(keywordPresent('binary search', 'a binary search tree')).toBe(true)
    expect(keywordPresent('binary search', 'search the binary file')).toBe(false)
  })

  it('returns false for empty keyword or empty text', () => {
    expect(keywordPresent('', 'some text')).toBe(false)
    expect(keywordPresent('term', '')).toBe(false)
  })
})

describe('keywordPresent — plural/singular tolerance on the LAST token only', () => {
  it('matches keyword singular against text plural (s and es)', () => {
    expect(keywordPresent('array', 'we build arrays')).toBe(true)
    expect(keywordPresent('index', 'the indexes grow')).toBe(true)
  })

  it('matches keyword plural against text singular', () => {
    expect(keywordPresent('arrays', 'one array here')).toBe(true)
  })

  it('applies tolerance ONLY to the final token of a phrase', () => {
    // Plural on the non-final token should not match.
    expect(keywordPresent('hash table', 'a hash tables view')).toBe(true) // last token tolerant
    expect(keywordPresent('hash table', 'hashes table lookup')).toBe(false) // non-final not tolerant
  })
})

describe('checkKeywords', () => {
  it('returns null when no keywords are configured', () => {
    expect(checkKeywords(undefined, 'text')).toBeNull()
    expect(checkKeywords([], 'text')).toBeNull()
  })

  it('partitions configured keywords into found and missing', () => {
    const res = checkKeywords(['recursion', 'memoization'], 'we use recursion but not the other')
    expect(res).toEqual({
      required: ['recursion', 'memoization'],
      found: ['recursion'],
      missing: ['memoization'],
    })
  })

  it('lists ALL keywords as missing when text is null (unmapped question)', () => {
    const res = checkKeywords(['a', 'b'], null)
    expect(res).toEqual({ required: ['a', 'b'], found: [], missing: ['a', 'b'] })
  })

  it('preserves the original keyword surface form in found/missing, not the normalized one', () => {
    const res = checkKeywords(['Well-Known'], 'this is well known')
    expect(res?.found).toEqual(['Well-Known'])
    expect(res?.missing).toEqual([])
  })

  it('satisfies a keyword via a configured alias when the term itself is absent', () => {
    const aliases: KeywordAlias[] = [{ term: 'DFS', aliases: ['depth-first search'] }]
    const res = checkKeywords(['DFS'], 'we run a depth-first search over the graph', aliases)
    expect(res?.found).toEqual(['DFS'])
    expect(res?.missing).toEqual([])
  })

  it('still marks a keyword missing when neither the term nor any alias is present', () => {
    const aliases: KeywordAlias[] = [{ term: 'DFS', aliases: ['depth-first search'] }]
    const res = checkKeywords(['DFS'], 'we run breadth-first here', aliases)
    expect(res?.found).toEqual([])
    expect(res?.missing).toEqual(['DFS'])
  })

  it('matches a decimal keyword exactly thanks to the decimal-preserving normalize', () => {
    const res = checkKeywords(['3.14'], 'the value is 3.14 here')
    expect(res?.found).toEqual(['3.14'])
    // And a differing decimal is a genuine miss (not collapsed to the same token).
    const miss = checkKeywords(['3.14'], 'the value is 3 14 here')
    expect(miss?.missing).toEqual(['3.14'])
  })
})
