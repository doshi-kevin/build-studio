// Tests for resolveStudent — resolves a free-text (model-supplied) name to ONE
// enrolled student. The risk is silent: a wrong match surfaces another student's
// data in chat, so the ambiguous / not-found / word-boundary cases matter most.

import { describe, it, expect } from 'vitest'
import { resolveStudent, normName, editDistance } from '@/lib/ai/professor-assistant/student-resolve'

const roster = [
  { id: '1', name: 'Marcus Bell' },
  { id: '2', name: 'Liam O’Connor' },
  { id: '3', name: 'Mei Lin' },
  { id: '4', name: 'Sofia Rossi' },
  { id: '5', name: 'Olivia Santos' },
  { id: '6', name: 'José García' },
]

describe('resolveStudent', () => {
  it('resolves an exact full-name match', () => {
    expect(resolveStudent('Marcus Bell', roster)).toEqual({ kind: 'found', id: '1', name: 'Marcus Bell' })
  })

  it('resolves a first-name-only token prefix to a single student', () => {
    expect(resolveStudent('Marcus', roster)).toEqual({ kind: 'found', id: '1', name: 'Marcus Bell' })
    expect(resolveStudent('marc', roster)).toEqual({ kind: 'found', id: '1', name: 'Marcus Bell' })
  })

  it('resolves a last-name token prefix', () => {
    expect(resolveStudent('Rossi', roster)).toEqual({ kind: 'found', id: '4', name: 'Sofia Rossi' })
  })

  it('returns ambiguous when a prefix matches multiple students', () => {
    // "Li" prefixes "Liam" and "Lin" (Mei Lin) — must ask, not guess.
    const r = resolveStudent('Li', roster)
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect([...r.matches].sort()).toEqual(['Liam O’Connor', 'Mei Lin'])
  })

  it('does NOT match "Li" against "Olivia" (word-boundary, not substring)', () => {
    const r = resolveStudent('Li', roster)
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.matches).not.toContain('Olivia Santos')
  })

  it('is diacritic-insensitive', () => {
    expect(resolveStudent('jose', roster)).toEqual({ kind: 'found', id: '6', name: 'José García' })
    expect(resolveStudent('garcia', roster)).toEqual({ kind: 'found', id: '6', name: 'José García' })
  })

  it('returns not_found with up to 5 closest suggestions, never the whole roster', () => {
    const big = Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, name: `Person ${i}` }))
    const r = resolveStudent('Zzyzx Nomatch', big)
    expect(r.kind).toBe('not_found')
    if (r.kind === 'not_found') expect(r.suggestions.length).toBeLessThanOrEqual(5)
  })

  it('surfaces the closest name first for a genuine typo (no prefix match)', () => {
    const r = resolveStudent('Marcsu', [{ id: '1', name: 'Marcus Bell' }, { id: '2', name: 'Sofia Rossi' }])
    expect(r.kind).toBe('not_found')
    if (r.kind === 'not_found') expect(r.suggestions[0]).toBe('Marcus Bell')
  })

  it('handles an empty roster without throwing', () => {
    expect(resolveStudent('anyone', [])).toEqual({ kind: 'not_found', suggestions: [] })
  })

  it('handles a blank query as not_found (no accidental match)', () => {
    expect(resolveStudent('   ', roster).kind).toBe('not_found')
  })
})

describe('normName', () => {
  it('lowercases, strips diacritics, and collapses whitespace', () => {
    expect(normName('  José   GARCÍA ')).toBe('jose garcia')
  })
})

describe('editDistance', () => {
  it('computes Levenshtein distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3)
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('same', 'same')).toBe(0)
  })
})
