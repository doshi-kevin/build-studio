/**
 * The create-challenge dialog must not carry an abandoned draft into its next open (#703 part 3).
 *
 * `form.reset()` was called only after a SUCCESSFUL create, so cancelling left the previous
 * title, points and due date sitting in the form. Reopening "New challenge" then showed a
 * pre-filled form, which reads as a saved draft rather than as leftovers, and the professor's
 * likely next action is to submit someone else's abandoned text.
 *
 * Asserting the input VALUE across a close/reopen cycle, because that is the only observable
 * that distinguishes "reset on close" from "reset on success".
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CreateChallengeDialog } from '@/components/professor/challenges/CreateChallengeDialog'

vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/challenges/actions', () => ({
  createChallenge: vi.fn(async () => ({ success: true })),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

const SECTION = '8a2ac745-bbd2-4848-a4b6-aeac1e69bb4b'

const openDialog = () => fireEvent.click(screen.getByRole('button', { name: /New challenge/i }))

describe('CreateChallengeDialog (#703 part 3)', () => {
  it('clears an abandoned title when the dialog is closed and reopened', async () => {
    render(<CreateChallengeDialog sectionId={SECTION} badges={[]} skills={[]} />)

    openDialog()
    const title = await screen.findByLabelText(/title/i)
    fireEvent.change(title, { target: { value: 'Abandoned draft' } })
    expect((title as HTMLInputElement).value).toBe('Abandoned draft')

    // Cancel, which is the path that used to keep the value.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }))
    await waitFor(() => expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument())

    openDialog()
    const reopened = await screen.findByLabelText(/title/i)
    expect((reopened as HTMLInputElement).value).toBe('')
  })
})
