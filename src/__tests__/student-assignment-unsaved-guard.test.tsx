/**
 * A student's typed response lives only in component state until they press Submit, so a
 * refresh or a tab close threw the whole answer away with no prompt at all.
 *
 * The oracle here is whether the `beforeunload` event is actually CANCELLED — that is what
 * makes the browser show its "leave site?" dialog. Asserting that a listener was added would
 * pass even if the handler did nothing.
 *
 * The negative case matters as much as the positive one: a guard that fires on a page the
 * student only opened to read trains people to dismiss the dialog, which is worse than not
 * having it. So an untouched form must NOT block.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { StudentAssignmentWorkspace } from '@/components/student/assignments/StudentAssignmentWorkspace'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/app/(dashboard)/student/courses/[sectionId]/assignments/actions', () => ({
  submitAssignment: vi.fn(),
  requestLateSubmission: vi.fn(),
  withdrawRegradeRequest: vi.fn(),
  submitRegradeRequest: vi.fn(),
}))

const BASE = {
  sectionId: '8a2ac745-bbd2-4848-a4b6-aeac1e69bb4b',
  assignmentId: 'a1',
  fileTypes: [] as never[],
  points: 100,
  submission: null,
}

/** Dispatch a real cancelable beforeunload and report whether anything cancelled it. */
function unloadBlocked(): boolean {
  const evt = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(evt)
  return evt.defaultPrevented
}

describe('student assignment — unsaved work guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does NOT block navigation when nothing has been typed', () => {
    render(<StudentAssignmentWorkspace {...BASE} />)
    expect(unloadBlocked()).toBe(false)
  })

  it('blocks navigation once the student has typed a response', () => {
    render(<StudentAssignmentWorkspace {...BASE} />)

    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'My worked answer to question one…' } })

    expect(unloadBlocked()).toBe(true)
  })

  it('does not block when the text still matches what was already submitted', () => {
    render(
      <StudentAssignmentWorkspace
        {...BASE}
        submission={{
          id: 's1',
          status: 'returned',
          text: 'previously saved answer',
          files: [],
          score: null,
          feedback: '',
        }}
      />,
    )
    // untouched — identical to the stored submission, so there is nothing to lose
    expect(unloadBlocked()).toBe(false)
  })

  it('blocks again once that existing response is edited', () => {
    render(
      <StudentAssignmentWorkspace
        {...BASE}
        submission={{
          id: 's1',
          status: 'returned',
          text: 'previously saved answer',
          files: [],
          score: null,
          feedback: '',
        }}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'previously saved answer, now revised' },
    })
    expect(unloadBlocked()).toBe(true)
  })
})
