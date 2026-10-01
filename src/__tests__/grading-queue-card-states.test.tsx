// GradingQueueCard — the three behaviours that live in the component rather than
// in `buildGradingQueue`/`sortGradingQueue` (both covered in
// professor-todos.test.ts).
//
// Deliberately narrow. Most of this card's remaining logic is container queries
// (`@max-[300px]:hidden` and friends), which jsdom cannot evaluate at all — that
// belongs in a visual walkthrough, not here. What IS worth pinning:
//
//   1. loadError must beat an empty list. Both branches render from the same
//      component and the empty one says "Nothing waiting to be graded" — a
//      confident all-caught-up on a broken fetch is how a professor misses a
//      week of ungraded work. Today that only holds because `if (loadError)`
//      happens to come first; nothing else stops a reorder.
//   2. The empty state must not show sort controls that reorder nothing.
//   3. The sort buttons must actually be wired to the list. sortGradingQueue is
//      unit-tested, but nothing else proves clicking "Most" re-renders with it.

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GradingQueueCard } from '@/components/professor/dashboard/GradingQueueCard'
import type { GradingQueueEntry } from '@/lib/dashboard/professor-todos'

const entry = (over: Partial<GradingQueueEntry> = {}): GradingQueueEntry => ({
  assessmentId: 'a1',
  sectionId: 'sec-1',
  title: 'Essay',
  courseCode: 'CS-513',
  waiting: 1,
  oldestDays: 1,
  href: '/professor/courses/sec-1/assignments/a1?tab=grading',
  ...over,
})

/** Row titles in rendered order. */
const rowTitles = () => screen.getAllByRole('listitem').map((li) => li.querySelector('p')?.textContent)

/** The header's sort dropdown trigger, or null when the card isn't showing a list. */
const sortTrigger = () => screen.queryByLabelText(/^Sort the grading queue/)

describe('GradingQueueCard — error, empty, and sorting', () => {
  it('shows the error state rather than "nothing waiting" when the fetch failed', () => {
    render(<GradingQueueCard entries={[]} loadError />)
    expect(screen.getByText("Couldn't load your grading queue")).toBeInTheDocument()
    expect(screen.queryByText('Nothing waiting to be graded')).not.toBeInTheDocument()
  })

  it('shows the error state even when rows did arrive — a partial load is still a broken one', () => {
    render(<GradingQueueCard entries={[entry()]} loadError />)
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
    expect(sortTrigger()).not.toBeInTheDocument()
  })

  it('hides the sort control when there is nothing to sort', () => {
    render(<GradingQueueCard entries={[]} />)
    expect(screen.getByText('Nothing waiting to be graded')).toBeInTheDocument()
    expect(sortTrigger()).not.toBeInTheDocument()
  })

  it('reorders the rendered list when the professor switches to most-waiting', () => {
    // Arrives oldest-first, as the server sends it: the stale single submission
    // leads, the big fresh pile follows.
    const entries = [
      entry({ assessmentId: 'a2', title: 'Problem Set', waiting: 1, oldestDays: 9 }),
      entry({ assessmentId: 'a1', title: 'Essay', waiting: 5, oldestDays: 1 }),
    ]
    render(<GradingQueueCard entries={entries} />)
    expect(rowTitles()).toEqual(['Problem Set', 'Essay'])

    // The trigger doubles as the current-state readout, so it has to change too.
    expect(sortTrigger()).toHaveTextContent('Oldest')

    // Opened by keyboard, not by click: Radix's trigger listens on pointerdown,
    // which jsdom doesn't synthesise from fireEvent.click, so a click here is a
    // silent no-op. Enter is also the path that has to work for keyboard users.
    fireEvent.keyDown(sortTrigger()!, { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Most waiting first' }))

    expect(rowTitles()).toEqual(['Essay', 'Problem Set'])
    expect(sortTrigger()).toHaveTextContent('Most')
  })
})
