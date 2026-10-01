// Canvas folding — the other half of the "edit mode stopped reading as a form"
// change. Two things are pinned here because both are easy to break later:
//
//  1. The thresholds and the folded summary line, which are the only reason a
//     14-week syllabus doesn't bury the rest of the page.
//  2. The fold set is seeded ONCE, from the blocks as they loaded, and is never
//     recomputed. Recomputing it is the obvious "improvement" and it is wrong:
//     isLongBlock() crosses its threshold mid-edit, so adding a 4th week to a
//     3-week schedule would fold the block shut under the professor's cursor.
//
// Folding is canvas-only state: students never see it and it is never written to
// the database (it used to live on the block and take a write on every toggle).

import { describe, it, expect } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, act } from '@testing-library/react'
import {
  BlockEditorProvider,
  useBlockEditor,
  isLongBlock,
  blockSummaryLine,
} from '@/components/professor/about/block-editor'
import type { AboutBlock, SyllabusWeek } from '@/lib/validations/course-about'

// ── builders ─────────────────────────────────────────────────

const weeks = (n: number): SyllabusWeek[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `w-${i}`, week: i + 1, topic: `Topic ${i + 1}`, description: '', readings: '',
  }))

const syllabus = (id: string, n: number, title = ''): AboutBlock =>
  ({ id, type: 'syllabus', data: { title, weeks: weeks(n) } }) as AboutBlock

const outcomes = (id: string, n: number, title = ''): AboutBlock =>
  ({
    id,
    type: 'learning-outcomes',
    data: {
      title,
      outcomes: Array.from({ length: n }, (_, i) => ({ id: `o-${i}`, text: `Outcome ${i}`, isCore: false })),
    },
  }) as AboutBlock

const faq = (id: string, n: number, title = ''): AboutBlock =>
  ({
    id,
    type: 'faq',
    data: {
      title,
      items: Array.from({ length: n }, (_, i) => ({
        id: `q-${i}`,
        question: `Q${i}`,
        answer: { type: 'doc', content: [] },
      })),
    },
  }) as AboutBlock

const table = (id: string, rowCount: number, title = ''): AboutBlock =>
  ({
    id,
    type: 'table',
    data: { title, hasHeaderRow: true, rows: Array.from({ length: rowCount }, () => ['a', 'b']) },
  }) as AboutBlock

const quote = (id: string): AboutBlock =>
  ({ id, type: 'quote', data: { text: 'Language is the dress of thought', attribution: 'Johnson' } }) as AboutBlock

// ── isLongBlock ──────────────────────────────────────────────

describe('isLongBlock', () => {
  it('folds the four list-shaped blocks once they pass their threshold', () => {
    expect(isLongBlock(syllabus('s', 4))).toBe(true)
    expect(isLongBlock(outcomes('o', 5))).toBe(true)
    expect(isLongBlock(faq('f', 4))).toBe(true)
    expect(isLongBlock(table('t', 4))).toBe(true)
  })

  it('leaves a block sitting exactly ON its threshold open — a short block is never worth hiding', () => {
    expect(isLongBlock(syllabus('s', 3))).toBe(false)
    expect(isLongBlock(outcomes('o', 4))).toBe(false)
    expect(isLongBlock(faq('f', 3))).toBe(false)
    expect(isLongBlock(table('t', 3))).toBe(false)
  })

  it('never folds a block with no list in it, however it is configured', () => {
    expect(isLongBlock(quote('q'))).toBe(false)
    expect(isLongBlock(syllabus('s', 0))).toBe(false)
  })
})

// ── blockSummaryLine ─────────────────────────────────────────

describe('blockSummaryLine', () => {
  it("uses the block's own title, and counts its rows with the right noun", () => {
    expect(blockSummaryLine(syllabus('s', 14, 'Weekly Schedule'), 'Syllabus')).toBe('Weekly Schedule · 14 weeks')
    expect(blockSummaryLine(outcomes('o', 6, 'What you will learn'), 'Outcomes')).toBe('What you will learn · 6 outcomes')
    expect(blockSummaryLine(faq('f', 5, 'FAQ'), 'FAQ')).toBe('FAQ · 5 questions')
    expect(blockSummaryLine(table('t', 7, 'Grading'), 'Table')).toBe('Grading · 7 rows')
  })

  it('falls back to the registry label when the professor has not titled the block', () => {
    // An untitled block still has to be identifiable while it is folded shut —
    // "· 14 weeks" on its own would name nothing.
    expect(blockSummaryLine(syllabus('s', 14), 'Syllabus')).toBe('Syllabus · 14 weeks')
    expect(blockSummaryLine(table('t', 7), 'Table')).toBe('Table · 7 rows')
  })

  it('says "1 week", not "1 weeks"', () => {
    expect(blockSummaryLine(syllabus('s', 1, 'Schedule'), 'Syllabus')).toBe('Schedule · 1 week')
    expect(blockSummaryLine(faq('f', 1, 'FAQ'), 'FAQ')).toBe('FAQ · 1 question')
  })

  it('drops the count entirely when there is nothing to count', () => {
    expect(blockSummaryLine(syllabus('s', 0, 'Schedule'), 'Syllabus')).toBe('Schedule')
    expect(blockSummaryLine(quote('q'), 'Quote')).toBe('Quote')
  })
})

// ── the collapsed set in BlockEditorContext ──────────────────

function renderWith(initialBlocks: AboutBlock[]) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BlockEditorProvider initialBlocks={initialBlocks} sectionId="sec-1">{children}</BlockEditorProvider>
  )
  return renderHook(() => useBlockEditor(), { wrapper })
}

describe('BlockEditorContext — the collapsed set', () => {
  it('opens with long blocks folded and short ones open', () => {
    const { result } = renderWith([syllabus('long', 14), syllabus('short', 2), quote('q')])
    expect(result.current.collapsedIds.has('long')).toBe(true)
    expect(result.current.collapsedIds.has('short')).toBe(false)
    expect(result.current.collapsedIds.has('q')).toBe(false)
  })

  it('honours a short block the professor had already folded by hand', () => {
    // `collapsed` on the block is the legacy persisted flag. It is still read at
    // load, so a page folded before this change opens the way it was left.
    const folded = { ...quote('q'), collapsed: true } as AboutBlock
    const { result } = renderWith([folded])
    expect(result.current.collapsedIds.has('q')).toBe(true)
  })

  it('does NOT re-fold a block that grows past the threshold while being edited', () => {
    // The regression this guards: seed a 3-week syllabus (open), add more weeks,
    // and a recomputed set would fold the block shut mid-keystroke.
    const { result } = renderWith([syllabus('s', 3)])
    expect(result.current.collapsedIds.has('s')).toBe(false)

    act(() => result.current.dispatch({
      type: 'UPDATE_BLOCK',
      payload: { blockId: 's', data: { weeks: weeks(9) } },
    }))

    expect(result.current.collapsedIds.has('s')).toBe(false)
  })

  it('toggleCollapsed folds and unfolds the same block', () => {
    const { result } = renderWith([quote('q')])
    act(() => result.current.toggleCollapsed('q'))
    expect(result.current.collapsedIds.has('q')).toBe(true)
    act(() => result.current.toggleCollapsed('q'))
    expect(result.current.collapsedIds.has('q')).toBe(false)
  })

  it('expand only ever opens — click-to-edit must never fold the block it targets', () => {
    const { result } = renderWith([syllabus('long', 14), quote('q')])

    act(() => result.current.expand('long'))
    expect(result.current.collapsedIds.has('long')).toBe(false)

    // Already open: expanding again leaves it open, and the set identity unchanged.
    const before = result.current.collapsedIds
    act(() => result.current.expand('q'))
    expect(result.current.collapsedIds.has('q')).toBe(false)
    expect(result.current.collapsedIds).toBe(before)
  })
})
