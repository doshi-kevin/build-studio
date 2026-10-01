// Deadline-gate decision logic extracted from submitAssignment / startAssessment (student)
// and the professor grading page. These are the branching rules this commit introduced:
//   - past due_at rejects a submission UNLESS a professor reopen window is still active
//   - the reopen window is active only while resubmit_until is in the future
//   - a submission is "Late" when submitted_at is after due_at
// The rules were previously inline (unreachable without Supabase mocks); pinning the pure
// decision here means a regression fails a fast unit test instead of leaking to prod.

import { describe, it, expect } from 'vitest'
import {
  canSubmitPastDeadline,
  isReopenWindowActive,
  isLateSubmission,
} from '@/lib/assignments/submissions'
import { getStudentAssignmentStatus } from '@/lib/assignments/student-status'

const NOW = new Date('2026-07-17T12:00:00.000Z').getTime()
const PAST = '2026-07-17T09:00:00.000Z' // 3h before NOW
const FUTURE = '2026-07-17T15:00:00.000Z' // 3h after NOW

describe('isReopenWindowActive', () => {
  it('true only while resubmit_until is in the future', () => {
    expect(isReopenWindowActive(FUTURE, NOW)).toBe(true)
    expect(isReopenWindowActive(PAST, NOW)).toBe(false)
  })

  it('false when there is no window', () => {
    expect(isReopenWindowActive(null, NOW)).toBe(false)
    expect(isReopenWindowActive(undefined, NOW)).toBe(false)
  })

  it('an exactly-expired window is closed (boundary: now === until)', () => {
    expect(isReopenWindowActive(new Date(NOW).toISOString(), NOW)).toBe(false)
  })

  it('an invalid timestamp is treated as no window (no crash)', () => {
    expect(isReopenWindowActive('not-a-date', NOW)).toBe(false)
  })
})

describe('canSubmitPastDeadline', () => {
  it('no deadline → always allowed regardless of window', () => {
    expect(canSubmitPastDeadline(null, null, NOW)).toBe(true)
    expect(canSubmitPastDeadline(undefined, PAST, NOW)).toBe(true)
  })

  it('before the deadline → allowed even without a reopen window', () => {
    expect(canSubmitPastDeadline(FUTURE, null, NOW)).toBe(true)
  })

  it('past the deadline with no window → denied', () => {
    expect(canSubmitPastDeadline(PAST, null, NOW)).toBe(false)
    expect(canSubmitPastDeadline(PAST, undefined, NOW)).toBe(false)
  })

  it('past the deadline but an active window reopens it → allowed', () => {
    expect(canSubmitPastDeadline(PAST, FUTURE, NOW)).toBe(true)
  })

  it('past the deadline with an expired window → denied', () => {
    expect(canSubmitPastDeadline(PAST, PAST, NOW)).toBe(false)
  })

  it('exactly at the deadline is still allowed (boundary: now === due)', () => {
    const due = new Date(NOW).toISOString()
    expect(canSubmitPastDeadline(due, null, NOW)).toBe(true)
  })
})

describe('reopened status via getStudentAssignmentStatus', () => {
  it('reopened when past deadline but window active and not yet submitted', () => {
    const s = getStudentAssignmentStatus({
      now: NOW,
      dueAt: PAST,
      submissionStatus: null,
      gradesPublished: false,
      resubmitUntil: FUTURE,
    })
    expect(s.kind).toBe('reopened')
    expect(s.tone).toBe('warning')
  })

  it('missing when window expired (no longer open)', () => {
    const s = getStudentAssignmentStatus({
      now: NOW,
      dueAt: PAST,
      submissionStatus: null,
      gradesPublished: false,
      resubmitUntil: PAST,
    })
    expect(s.kind).toBe('missing')
  })
})

describe('isLateSubmission', () => {
  it('true when submitted after the deadline', () => {
    expect(isLateSubmission(FUTURE, PAST)).toBe(true)
  })

  it('false when submitted before the deadline', () => {
    expect(isLateSubmission(PAST, FUTURE)).toBe(false)
  })

  it('exactly on time is not late (boundary: submitted === due)', () => {
    expect(isLateSubmission(PAST, PAST)).toBe(false)
  })

  it('false when either timestamp is missing (no deadline, or never submitted)', () => {
    expect(isLateSubmission(null, PAST)).toBe(false)
    expect(isLateSubmission(FUTURE, null)).toBe(false)
    expect(isLateSubmission(null, null)).toBe(false)
    expect(isLateSubmission(undefined, undefined)).toBe(false)
  })
})
