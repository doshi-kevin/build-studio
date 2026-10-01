// Evidence locating + highlight rendering (evidence-first review, phase 2).
//
// Load-bearing behaviours:
//  - Matching never guesses: exact → case-insensitive → whitespace-tolerant, then an
//    honest null (a wrong highlight would misattribute student work to a criterion).
//  - Overlapping ranges collapse to non-overlapping marks (no nested <mark>).
//  - Student-authored text renders as TEXT — evidence containing HTML must appear
//    verbatim on screen, never become elements (XSS).

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  findEvidenceRange,
  computeEvidenceRanges,
  EvidenceHighlightedText,
  evidenceMarkId,
} from '@/components/professor/assignments/EvidenceHighlights'

const TEXT = 'The loop invariant holds.\nEach step decreases n by one,   so termination follows.'

describe('findEvidenceRange', () => {
  it('finds an exact substring', () => {
    const r = findEvidenceRange(TEXT, 'loop invariant holds')
    expect(r).toEqual({ start: 4, end: 24 })
  })

  it('falls back to case-insensitive, preserving indexes', () => {
    const r = findEvidenceRange(TEXT, 'THE LOOP INVARIANT')
    expect(r).toEqual({ start: 0, end: 18 })
  })

  it('tolerates whitespace drift (PDF newlines / collapsed spaces)', () => {
    // Evidence has single spaces; the text has a newline and a triple space in the way.
    const r = findEvidenceRange(TEXT, 'by one, so termination')
    expect(r).not.toBeNull()
    expect(TEXT.slice(r!.start, r!.end)).toBe('by one,   so termination')
  })

  it('returns null (never a guess) when the quote is not in the text', () => {
    expect(findEvidenceRange(TEXT, 'completely different sentence')).toBeNull()
    expect(findEvidenceRange(TEXT, '')).toBeNull()
    expect(findEvidenceRange('', 'anything')).toBeNull()
  })

  it('survives evidence with zero-width characters via honest degrade', () => {
    // Zero-width space inside a token defeats all three passes — must not throw.
    expect(() => findEvidenceRange(TEXT, 'in​variant xq')).not.toThrow()
  })

  it('never mis-anchors when toLowerCase changes string length (Unicode İ)', () => {
    // "İ" lowercases to two code units, so a naive lowercase indexOf would shift every
    // index after it. The match must still land on the ORIGINAL string's indexes.
    const text = 'İstanbul study: the loop invariant holds here.'
    const r = findEvidenceRange(text, 'THE LOOP INVARIANT HOLDS')
    expect(r).not.toBeNull()
    expect(text.slice(r!.start, r!.end)).toBe('the loop invariant holds')
  })
})

describe('computeEvidenceRanges', () => {
  it('drops overlapping ranges, keeping document order', () => {
    const ranges = computeEvidenceRanges(TEXT, [
      { key: '0:1', evidence: 'invariant holds' },
      { key: '0:0', evidence: 'The loop invariant' }, // overlaps 0:1 but starts earlier
      { key: '1:0', evidence: 'termination follows' },
    ])
    expect(ranges.map((r) => r.key)).toEqual(['0:0', '1:0'])
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBeGreaterThanOrEqual(ranges[i - 1].end)
    }
  })

  it('skips empty evidence and unlocatable quotes', () => {
    const ranges = computeEvidenceRanges(TEXT, [
      { key: '0:0', evidence: '' },
      { key: '0:1', evidence: 'not in the text at all' },
    ])
    expect(ranges).toEqual([])
  })
})

describe('EvidenceHighlightedText', () => {
  it('renders marks with stable ids and full surrounding text', () => {
    const ranges = computeEvidenceRanges(TEXT, [{ key: '1:0', evidence: 'termination follows' }])
    const { container } = render(
      <EvidenceHighlightedText text={TEXT} ranges={ranges} activeKey="1:0" />,
    )
    const mark = container.querySelector(`#${evidenceMarkId('1:0')}`)
    expect(mark).not.toBeNull()
    expect(mark!.textContent).toBe('termination follows')
    // Nothing was lost around the mark.
    expect(container.textContent).toBe(TEXT)
  })

  it('renders student-authored HTML as inert text (XSS)', () => {
    const hostile = 'before <img src=x onerror=alert(1)> after'
    const { container } = render(
      <EvidenceHighlightedText
        text={hostile}
        ranges={computeEvidenceRanges(hostile, [{ key: '0:0', evidence: '<img src=x onerror=alert(1)>' }])}
      activeKey={null}
      />,
    )
    // The payload is visible as text and no img element was created.
    expect(screen.getByText(/onerror=alert\(1\)/)).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders plain text when no ranges located', () => {
    const { container } = render(<EvidenceHighlightedText text={TEXT} ranges={[]} activeKey={null} />)
    expect(container.querySelector('mark')).toBeNull()
    expect(container.textContent).toBe(TEXT)
  })
})
