// StaffDirectoryTable: which action a row offers. The three things that live in the
// component rather than in `directory-utils` (whose pure helpers are covered in
// staff-directory-utils.test.ts).
//
// Deliberately narrow. The dialog copy, the button labels and the badge text are all copy,
// and asserting them just restates the JSX. What is worth pinning is the row's ELIGIBILITY,
// because two separate bugs landed in this one cell:
//
//   1. A row at status='active' whose ends_at had passed offered NOTHING. Revoke was hidden
//      because the derived display status read 'ended', Delete was hidden because the
//      assignment really was still active, so the cell rendered a bare em-dash. Nothing in
//      this codebase ever writes status='ended', so that is what every normally-expired
//      assignment becomes, permanently. Prod has two of them and the count only grows.
//
//   2. `hasActiveAssignment` was computed from the SEARCH-FILTERED rows. Searching for one
//      course hid a person's other assignments, so Delete appeared for someone the server
//      refuses to delete. This is the assertion no pure test can produce: a helper handed
//      the wrong list returns the right answer for that list. The bug is which list is
//      passed, which is wiring, and wiring only shows up in a render.
//
// The third test exists so the second cannot pass by accident: with `hasActiveAssignment`
// hardcoded true, "no Delete button" is true for the wrong reason.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StaffDirectoryTable } from '@/components/admin/staff/StaffDirectoryTable'

vi.mock('@/app/(dashboard)/admin/staff-requests/actions', () => ({
  revokeStaffAssignment: vi.fn(async () => ({ success: true })),
  resendStaffInvite: vi.fn(async () => ({ success: true })),
  deleteCourseAssistant: vi.fn(async () => ({ success: true })),
  getCourseAssistantCascadeCounts: vi.fn(async () => ({ activeAssignments: 0, pastAssignments: 0 })),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

const STAFF = { id: 'staff-1', name: 'Dana Ruiz', email: 'dana@example.edu', invite_status: 'accepted' }

const PAST = '2026-01-03T00:00:00.000Z'
const FUTURE = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()

/** One section_staff row, shaped the way the admin page's query returns it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    role: 'ta',
    status: 'active',
    ends_at: FUTURE,
    staff: STAFF,
    section: {
      id: 'sec-1',
      section_code: 'A',
      course: { id: 'c1', code: 'CS-513', title: 'Systems', department: { id: 'd1', name: 'CS', code: 'CS' } },
      professor: { id: 'p1', name: 'Prof' },
    },
    ...over,
  }
}

const DEPARTMENTS = [{ id: 'd1', name: 'CS', code: 'CS' }]

const search = () => screen.getByPlaceholderText(/Search by name/)

describe('StaffDirectoryTable row eligibility', () => {
  it('offers an action on an expired row that is still active in the database', () => {
    /* The stranded row. It displays as "Ended" because its end date has passed, but the DB
       row is still 'active', so it can be neither revoked nor deleted under the old gating
       and the admin had no way to clear it at all. */
    render(
      <StaffDirectoryTable
        assignments={[row({ status: 'active', ends_at: PAST })]}
        departments={DEPARTMENTS}
      />,
    )

    expect(screen.getByRole('button', { name: /Close out/ })).toBeInTheDocument()
  })

  it('withholds Delete for someone still assigned in a course the search is hiding', () => {
    /* Two rows for one person: a closed one in CS-513 and a live one in MA-201. Searching
       CS-513 hides the live row, and reading the filtered list is what made Delete appear
       for a profile the server refuses to delete. */
    const closedHere = row({ id: 'row-closed', status: 'removed', ends_at: PAST })
    const activeElsewhere = row({
      id: 'row-active',
      status: 'active',
      ends_at: FUTURE,
      section: {
        id: 'sec-2',
        section_code: 'B',
        course: { id: 'c2', code: 'MA-201', title: 'Calculus', department: { id: 'd1', name: 'CS', code: 'CS' } },
        professor: { id: 'p1', name: 'Prof' },
      },
    })

    render(
      <StaffDirectoryTable assignments={[closedHere, activeElsewhere]} departments={DEPARTMENTS} />,
    )

    fireEvent.change(search(), { target: { value: 'CS-513' } })

    // The live row is now hidden, so only the closed one is on screen.
    expect(screen.queryByText('MA-201')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove profile|^Delete/ })).not.toBeInTheDocument()
    expect(screen.getByText('Active elsewhere')).toBeInTheDocument()
  })

  it('shows a closed row its preserved end date', () => {
    /* The close-out dialog promises "that end date is kept as it is". Closed rows used to
       render no date at all, so the admin could not see the date the whole fix exists to
       preserve. PAST is 2026-01-03; formatDate renders it in the local zone, so assert on the
       year and "ended" rather than an exact string. */
    render(
      <StaffDirectoryTable
        assignments={[row({ id: 'row-closed', status: 'removed', ends_at: PAST })]}
        departments={DEPARTMENTS}
      />,
    )

    expect(screen.getByText(/ended .*202[56]/)).toBeInTheDocument()
  })

  it('offers Delete for the same closed row once nothing else is active', () => {
    /* Without this, the test above would also pass with hasActiveAssignment hardcoded true. */
    render(
      <StaffDirectoryTable
        assignments={[row({ id: 'row-closed', status: 'removed', ends_at: PAST })]}
        departments={DEPARTMENTS}
      />,
    )

    expect(screen.queryByText('Active elsewhere')).not.toBeInTheDocument()
    expect(screen.getByTitle(/Remove this course assistant/)).toBeInTheDocument()
  })
})
