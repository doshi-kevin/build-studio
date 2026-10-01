/**
 * A failed cascade lookup must not read as "this section is empty".
 *
 * Deleting a section cascades across 57 tables with no soft-delete and no recovery short of
 * a database restore. The dialog's whole job is to tell the admin what they are about to
 * lose — so the dangerous failure is not the dialog erroring, it is the dialog reassuring.
 *
 * `getSectionCascadeCounts` returns null when it could not look (auth, tenancy, or a thrown
 * query). If the dialog rendered that the same way it renders genuine zeros, an admin would
 * be told a section holding a full semester of work contains nothing, immediately before
 * destroying it. Typing the section code does not help: that interlock proves you picked the
 * right ROW, not that you understand what is IN it.
 */

import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { DeleteSectionDialog } from '@/components/admin/courses/DeleteSectionDialog'

const getSectionCascadeCounts = vi.fn()

const removeAssignment = vi.fn()
vi.mock('@/app/(dashboard)/admin/courses/actions', () => ({
  getSectionCascadeCounts: (...args: unknown[]) => getSectionCascadeCounts(...args),
  removeAssignment: (...args: unknown[]) => removeAssignment(...args),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const SECTION = { id: 'sec-1', section_code: 'A' }
const REASSURING = /no enrollments or student work/i

describe('DeleteSectionDialog — unknown cascade counts', () => {
  beforeEach(() => {
    getSectionCascadeCounts.mockReset()
  })

  it('does NOT claim the section is empty when the lookup failed', async () => {
    getSectionCascadeCounts.mockResolvedValue(null) // could not check

    render(<DeleteSectionDialog open onOpenChange={() => {}} section={SECTION} />)

    await waitFor(() => expect(getSectionCascadeCounts).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByText(/Couldn.t check what this section contains/i)).toBeInTheDocument(),
    )
    // The load-bearing assertion: the reassuring sentence must be absent.
    expect(screen.queryByText(REASSURING)).toBeNull()
  })

  it('does say the section is empty when it genuinely is', async () => {
    getSectionCascadeCounts.mockResolvedValue({
      students: 0, assignments: 0, quizzes: 0, submissions: 0, quizAttempts: 0, modules: 0,
    })

    render(<DeleteSectionDialog open onOpenChange={() => {}} section={SECTION} />)

    await waitFor(() => expect(screen.getByText(REASSURING)).toBeInTheDocument())
    expect(screen.queryByText(/Couldn.t check what this section contains/i)).toBeNull()
  })

  it('lists real counts, so the admin sees the blast radius', async () => {
    getSectionCascadeCounts.mockResolvedValue({
      students: 7, assignments: 6, quizzes: 10, submissions: 3, quizAttempts: 7, modules: 3,
    })

    render(<DeleteSectionDialog open onOpenChange={() => {}} section={SECTION} />)

    await waitFor(() => expect(screen.getByText('7 enrolled students')).toBeInTheDocument())
    // pluralised properly — "quiz" must not render as "quizs"
    expect(screen.getByText('10 quizzes')).toBeInTheDocument()
    expect(screen.queryByText(REASSURING)).toBeNull()
  })
})

/**
 * Radix's AlertDialogAction closes the dialog on click unless the handler calls
 * preventDefault. Without it the "Deleting…" label and the disabled guard are unreachable,
 * and the admin gets no feedback at all while a 57-table cascade runs.
 *
 * The oracle is that the in-flight label RENDERS — which can only happen if the dialog is
 * still open after the click.
 */
describe('DeleteSectionDialog — in-flight feedback', () => {
  beforeEach(() => {
    getSectionCascadeCounts.mockReset()
    removeAssignment.mockReset()
  })

  /* Rendered with REAL open state, not a hardcoded `open` — with a no-op onOpenChange the
     dialog physically cannot close, so the test would pass with the bug present and prove
     nothing. This wrapper lets Radix's default close-on-click actually happen. */
  function Harness() {
    const [open, setOpen] = useState(true)
    return <DeleteSectionDialog open={open} onOpenChange={setOpen} section={SECTION} />
  }

  it('stays open and shows progress while the delete is running', async () => {
    getSectionCascadeCounts.mockResolvedValue({
      students: 1, assignments: 0, quizzes: 0, submissions: 0, quizAttempts: 0, modules: 0,
    })
    removeAssignment.mockImplementation(() => new Promise(() => {})) // never settles

    render(<Harness />)
    await waitFor(() => expect(screen.getByText('1 enrolled student')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: /^delete section$/i }))

    await waitFor(() => expect(removeAssignment).toHaveBeenCalledWith(SECTION.id))
    // only visible if the dialog did NOT close on click
    await waitFor(() => expect(screen.getByText(/Deleting…/)).toBeInTheDocument())
  })

  it('keeps Delete inert until the cascade counts have arrived', async () => {
    let release: (v: unknown) => void = () => {}
    getSectionCascadeCounts.mockImplementation(() => new Promise((r) => { release = r }))

    render(<DeleteSectionDialog open onOpenChange={() => {}} section={SECTION} />)
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'A' } })

    // code is correct, but we still don't know what would be destroyed
    expect(screen.getByRole('button', { name: /^delete section$/i })).toBeDisabled()

    release({ students: 0, assignments: 0, quizzes: 0, submissions: 0, quizAttempts: 0, modules: 0 })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^delete section$/i })).toBeEnabled(),
    )
  })
})
