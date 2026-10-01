/**
 * ReportsGallery caps the ended-session list and reveals the rest on demand (#185).
 *
 * The gallery previously rendered every ended session at once. The oracle here is
 * the number of report links visible before and after "Show more", plus the
 * remaining-count affordance. The list animation and date formatting are mocked
 * away so the test asserts pagination behavior, not the motion/format libraries.
 */
import type { ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReportsGallery } from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/ReportsGallery'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/components/ui/animated-list', () => ({
  AnimatedList: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  AnimatedItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
}))

function makeReports(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `room-${i}`,
    name: `Session ${i}`,
    createdAt: '2026-08-10T00:00:00.000Z',
    duration: '50m',
    deckPageCount: 10,
    reported: false,
  }))
}

describe('ReportsGallery — #185 pagination', () => {
  it('caps the initial render at 12 and reveals the rest via "Show more"', () => {
    render(<ReportsGallery sectionId="sec-1" reports={makeReports(13)} />)

    // Only the first page of report links is shown, with a remaining-count control.
    expect(screen.getAllByRole('link')).toHaveLength(12)
    const showMore = screen.getByRole('button', { name: /show more \(1\)/i })

    fireEvent.click(showMore)

    // All reports now render and the control is gone.
    expect(screen.getAllByRole('link')).toHaveLength(13)
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull()
  })

  it('reveals one page per click across multiple pages (25 reports)', () => {
    render(<ReportsGallery sectionId="sec-1" reports={makeReports(25)} />)

    // Page 1: 12 links, 13 remaining.
    expect(screen.getAllByRole('link')).toHaveLength(12)
    fireEvent.click(screen.getByRole('button', { name: /show more \(13\)/i }))

    // Page 2: one more page-size increment, not the whole tail.
    expect(screen.getAllByRole('link')).toHaveLength(24)
    fireEvent.click(screen.getByRole('button', { name: /show more \(1\)/i }))

    expect(screen.getAllByRole('link')).toHaveLength(25)
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull()
  })

  it('renders no "Show more" control when reports fit on one page', () => {
    render(<ReportsGallery sectionId="sec-1" reports={makeReports(12)} />)
    expect(screen.getAllByRole('link')).toHaveLength(12)
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull()
  })
})
