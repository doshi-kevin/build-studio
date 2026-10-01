import { describe, it, expect } from 'vitest'
import { countBlankMarkers } from '@/lib/quiz/utils'

describe('countBlankMarkers', () => {
  it('counts each run of 3+ underscores as one marker', () => {
    expect(countBlankMarkers('The _____ is the powerhouse.')).toBe(1)
    expect(countBlankMarkers('_____ and _____ and _____.')).toBe(3)
    expect(countBlankMarkers('___ or ____ or _____')).toBe(3) // 3, 4, 5 underscores
  })

  it('returns 0 when there are no markers', () => {
    expect(countBlankMarkers('No blanks here at all.')).toBe(0)
    expect(countBlankMarkers('')).toBe(0)
  })

  it('ignores markdown bold and LaTeX subscripts (fewer than 3 underscores)', () => {
    expect(countBlankMarkers('This is __bold__ text.')).toBe(0)
    expect(countBlankMarkers('The vector $x_i$ and $q_j$.')).toBe(0)
  })

  it('ignores markdown bold-italic (___word___) — its underscores are flush against text', () => {
    expect(countBlankMarkers('The ___key___ idea here.')).toBe(0)
    expect(countBlankMarkers('A ___bold-italic___ phrase and a real _____ blank.')).toBe(1)
  })

  it('counts a standalone blank even when wrapped in punctuation', () => {
    expect(countBlankMarkers('Answer: (_____) goes here.')).toBe(1)
  })

  it('does not count a run flush against a word (a real blank is space-delimited)', () => {
    expect(countBlankMarkers('word_____ here')).toBe(0)
  })
})
