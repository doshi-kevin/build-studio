// #495: what a student sees when the submit fails at the deadline.
//
// The issue asks for this to be checked "in a real network environment", because Chrome's
// Offline switch does not apply to loopback — so on localhost the submit always reaches
// the dev server and the failure path never runs. That is true, and it is also why the
// path had never been exercised: a manual check that can only happen on staging, at a
// deadline, with an attempt left, does not get done.
//
// From the component's point of view "offline" is just the server action REJECTING, so the
// whole checklist is reachable here — and unlike a one-off manual pass, it runs in CI.
//
// The five cases the issue lists:
//   1. network drops at the upload deadline → a persistent banner, NOT a false success
//   2. "Try submitting again" while still offline → the banner survives
//   3. reconnect → the submit goes through
//   4. window elapses past grace while offline → copy switches, button disables
//   5. response lost after a successful commit → the submitted view, not an error
//
// What this CANNOT cover is radio-level offline (a dropped TCP connection mid-request
// behaves differently from a rejected promise) and the real 2-minute grace clock. Case 3
// here proves the retry path works, not that a physical reconnect fires it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AssessmentRunner } from '@/components/student/assignments/AssessmentRunner'

const mockSubmit = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()

vi.mock('@/app/(dashboard)/student/courses/[sectionId]/assignments/assessment-actions', () => ({
  startAssessment: vi.fn(async () => ({ startedAt: new Date().toISOString() })),
  finishAssessmentWorkEarly: vi.fn(async () => ({ ok: true })),
  submitAssessment: (...a: unknown[]) => mockSubmit(...a),
  saveAssessmentProctoringBatch: vi.fn(async () => ({ ok: true })),
  saveAssessmentProctoringSnapshot: vi.fn(async () => ({ ok: true })),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) },
}))
/* No proctoring mock on purpose. This config turns activity/fullscreen/video all OFF, so
   the real capture classes are never constructed and nothing reaches for getUserMedia. An
   earlier draft of this file mocked '@/lib/assignments/proctoring-capture', which does not
   exist and which this component does not import — a mock that applied to nothing while
   making the setup look more careful than it was. */

const CONFIG = {
  enabled: true,
  workMinutes: 30,
  uploadMinutes: 10,
  proctoring: { activity: false, fullscreen: false, video: false },
}

/** The runner parked in its UPLOAD phase, which is where a submit can fail. */
function renderUpload() {
  const startedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString()
  const workEndedAt = new Date(Date.now() - 60 * 1000).toISOString()
  return render(
    <AssessmentRunner
      sectionId="sec-1"
      assignmentId="asg-1"
      config={CONFIG}
      fileTypes={['pdf']}
      initialStartedAt={startedAt}
      initialWorkEndedAt={workEndedAt}
      initialPhase="upload"
      submissionId="sub-1"
      submitted={false}
      briefSlot={null}
    />,
  )
}

/** Attach a file, because the "your work didn't reach us" banner is only shown when there is work. */
function attach(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['answer'], 'answer.pdf', { type: 'application/pdf' })
  fireEvent.change(input, { target: { files: [file] } })
  return file
}

const submitButton = () => screen.getByRole('button', { name: /Submit assessment|Try submitting again|Submission window closed/ })

beforeEach(() => {
  mockSubmit.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('#495: a submit that fails at the deadline', () => {
  it('shows a persistent banner rather than a false success when the device is offline', async () => {
    // Offline REJECTS the action rather than returning {error}; an unhandled rejection here
    // used to mean the click simply appeared to do nothing.
    mockSubmit.mockRejectedValue(new TypeError('Failed to fetch'))
    const { container } = renderUpload()
    await waitFor(() => expect(container.querySelector('input[type="file"]')).toBeTruthy())
    attach(container)

    fireEvent.click(submitButton())

    await waitFor(() => {
      expect(screen.getByText(/didn't go through|didn’t go through/)).toBeInTheDocument()
    })
    // The important half: it must NOT claim success.
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(screen.getByText(/hasn't reached your instructor|hasn’t reached your instructor/)).toBeInTheDocument()
  })

  it('keeps the banner when the retry also fails, instead of implying it worked', async () => {
    mockSubmit.mockRejectedValue(new TypeError('Failed to fetch'))
    const { container } = renderUpload()
    await waitFor(() => expect(container.querySelector('input[type="file"]')).toBeTruthy())
    attach(container)

    fireEvent.click(submitButton())
    await waitFor(() => expect(screen.getByRole('button', { name: /Try submitting again/ })).toBeInTheDocument())

    // Still offline. The banner is cleared at the start of every attempt, so a second
    // failure has to put it back — otherwise a student clicking retry sees it vanish and
    // reads that as success.
    fireEvent.click(screen.getByRole('button', { name: /Try submitting again/ }))
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      expect(screen.getByText(/didn't go through|didn’t go through/)).toBeInTheDocument()
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('goes through once the action stops rejecting', async () => {
    mockSubmit
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true })
    const { container } = renderUpload()
    await waitFor(() => expect(container.querySelector('input[type="file"]')).toBeTruthy())
    attach(container)

    fireEvent.click(submitButton())
    await waitFor(() => expect(screen.getByRole('button', { name: /Try submitting again/ })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /Try submitting again/ }))

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(2))
    // The failure banner is gone once the work is in.
    await waitFor(() => {
      expect(screen.queryByText(/didn't go through|didn’t go through/)).not.toBeInTheDocument()
    })
  })

  it('stops promising a retry once the window is terminally shut', async () => {
    /* A closed window is not a network problem, and retrying can never clear it. The
       classifier keys off the server's wording, so this also pins that the runner reacts to
       a message containing "closed" by disabling the button. */
    mockSubmit.mockResolvedValue({ error: 'The upload window has closed.' })
    const { container } = renderUpload()
    await waitFor(() => expect(container.querySelector('input[type="file"]')).toBeTruthy())
    attach(container)

    fireEvent.click(submitButton())

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Submission window closed/ })).toBeDisabled()
    })
    expect(screen.getByText(/the window is no longer open/)).toBeInTheDocument()
    // and it must not offer the retry wording alongside it
    expect(screen.queryByRole('button', { name: /Try submitting again/ })).not.toBeInTheDocument()
  })

  it('treats an already-recorded submission as success, not as lost work', async () => {
    /* The race the whole feature exists for: the server commits, the response is lost, the
       retry hits "already submitted". The work IS in, so a red "didn't reach us" banner
       would be actively wrong — it would tell the student to redo finished work. */
    mockSubmit.mockResolvedValue({ error: 'This assessment is already submitted.' })
    const { container } = renderUpload()
    await waitFor(() => expect(container.querySelector('input[type="file"]')).toBeTruthy())
    attach(container)

    fireEvent.click(submitButton())

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(toastError).not.toHaveBeenCalled()
    expect(screen.queryByText(/didn't go through|didn’t go through/)).not.toBeInTheDocument()
  })
})
