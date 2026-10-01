import { describe, it, expect } from 'vitest'
import {
  getStudentAssignmentStatus,
  scoreTone,
  DUE_SOON_MS,
} from '@/lib/assignments/student-status'

// Anchor to the real clock: the helper's overdue branch uses isPastDue(), which
// reads the real Date.now(), while due-soon/not-started use the injected `now`.
// In production both are the same clock; the test mirrors that by making the
// injected `now` the real now, then expressing dueAt as offsets from it.
const NOW = Date.now()
const past = (ms = 60_000) => new Date(NOW - ms).toISOString()
const future = (ms: number) => new Date(NOW + ms).toISOString()

const status = (over: Parameters<typeof getStudentAssignmentStatus>[0]) =>
  getStudentAssignmentStatus({ now: NOW, ...over })

describe('getStudentAssignmentStatus', () => {
  it('returned wins first, regardless of due date or grade publication', () => {
    expect(status({ dueAt: past(), submissionStatus: 'returned', gradesPublished: false }))
      .toMatchObject({ kind: 'returned', tone: 'destructive', group: 'attention' })
    // still returned even if grades happen to be published
    expect(status({ dueAt: future(DUE_SOON_MS), submissionStatus: 'returned', gradesPublished: true }).kind)
      .toBe('returned')
  })

  it('missing when not submitted and past due (both null and draft count as not submitted)', () => {
    for (const submissionStatus of [null, 'draft'] as const) {
      expect(status({ dueAt: past(), submissionStatus, gradesPublished: false }))
        .toMatchObject({ kind: 'missing', label: 'Missing submission', tone: 'destructive', group: 'attention' })
    }
  })

  it('reopened when past due but an active reopen window exists and student has not submitted', () => {
    const resubmitUntil = future(3 * 60 * 60 * 1000) // 3h from now
    expect(status({ dueAt: past(), submissionStatus: null, gradesPublished: false, resubmitUntil }))
      .toMatchObject({ kind: 'reopened', tone: 'warning', group: 'attention' })
    // label includes the formatted date
    const s = status({ dueAt: past(), submissionStatus: null, gradesPublished: false, resubmitUntil })
    expect(s.label).toMatch(/Reopened until/)
  })

  it('reopened for draft status too (student started but did not submit, window active)', () => {
    const resubmitUntil = future(1 * 60 * 60 * 1000)
    expect(status({ dueAt: past(), submissionStatus: 'draft', gradesPublished: false, resubmitUntil }))
      .toMatchObject({ kind: 'reopened' })
  })

  it('missing wins when reopen window is expired (past resubmit_until)', () => {
    const expiredWindow = past(3 * 60 * 60 * 1000) // 3h ago
    expect(status({ dueAt: past(), submissionStatus: null, gradesPublished: false, resubmitUntil: expiredWindow }))
      .toMatchObject({ kind: 'missing' })
  })

  it('due-soon when not submitted and due inside the window', () => {
    expect(status({ dueAt: future(60 * 60 * 1000), submissionStatus: null, gradesPublished: false }))
      .toMatchObject({ kind: 'due-soon', tone: 'warning', group: 'attention' })
  })

  it('due-soon at exactly the DUE_SOON_MS boundary (<=), not-started just past it', () => {
    expect(status({ dueAt: future(DUE_SOON_MS), submissionStatus: null, gradesPublished: false }).kind)
      .toBe('due-soon')
    expect(status({ dueAt: future(DUE_SOON_MS + 1), submissionStatus: null, gradesPublished: false }).kind)
      .toBe('not-started')
  })

  it('not-started when not submitted and no due date', () => {
    expect(status({ dueAt: null, submissionStatus: null, gradesPublished: false }))
      .toMatchObject({ kind: 'not-started', tone: 'neutral', group: 'upcoming' })
  })

  it('submitted', () => {
    expect(status({ dueAt: past(), submissionStatus: 'submitted', gradesPublished: false }))
      .toMatchObject({ kind: 'submitted', tone: 'info', group: 'submitted' })
  })

  it('graded when published and no open regrade', () => {
    expect(status({ dueAt: past(), submissionStatus: 'graded', gradesPublished: true }))
      .toMatchObject({ kind: 'graded', tone: 'success', group: 'graded' })
  })

  it('regrade-pending when graded, published, and an open regrade exists', () => {
    expect(status({ dueAt: past(), submissionStatus: 'graded', gradesPublished: true, hasOpenRegrade: true }))
      .toMatchObject({ kind: 'regrade-pending', tone: 'info', group: 'submitted' })
  })

  // The key regression guard: an unpublished grade must never read as "graded".
  it('masks graded -> submitted while grades are unpublished', () => {
    expect(status({ dueAt: past(), submissionStatus: 'graded', gradesPublished: false }).kind)
      .toBe('submitted')
    // and the mask runs before the regrade branch, so an open regrade cannot leak it either
    expect(status({ dueAt: past(), submissionStatus: 'graded', gradesPublished: false, hasOpenRegrade: true }).kind)
      .toBe('submitted')
  })

  it('a graded row is not hijacked by the not-submitted/overdue branches', () => {
    expect(status({ dueAt: past(), submissionStatus: 'graded', gradesPublished: true, hasOpenRegrade: true }).kind)
      .toBe('regrade-pending')
  })
})

// A timed assessment's window is derived from when the STUDENT started, so it can close while the
// assignment's own deadline is still days away. Before this the list said "Due soon"/"Not started"
// for an attempt the student was permanently locked out of.
describe('getStudentAssignmentStatus — closed assessment window', () => {
  it('a closed window beats "due soon" and "not started", even with the deadline far in the future', () => {
    expect(
      status({
        dueAt: future(30 * 24 * 60 * 60 * 1000), // a month out — nowhere near due
        submissionStatus: 'draft',
        gradesPublished: false,
        assessmentClosed: true,
      }),
    ).toMatchObject({ kind: 'assessment-closed', tone: 'destructive', group: 'attention' })

    // ...and the same row without the closed window still reads as ordinary upcoming work.
    expect(
      status({
        dueAt: future(30 * 24 * 60 * 60 * 1000),
        submissionStatus: 'draft',
        gradesPublished: false,
      }).kind,
    ).toBe('not-started')
  })

  it('a professor reopen window outranks the closed window (recovery is offered, not a lockout)', () => {
    expect(
      status({
        dueAt: future(30 * 24 * 60 * 60 * 1000),
        submissionStatus: 'draft',
        gradesPublished: false,
        assessmentClosed: true,
        resubmitUntil: future(2 * 60 * 60 * 1000),
      }).kind,
    ).toBe('reopened')
  })

  it('does not hijack an attempt that was actually submitted or graded', () => {
    expect(
      status({ dueAt: past(), submissionStatus: 'submitted', gradesPublished: false, assessmentClosed: true }).kind,
    ).toBe('submitted')
    expect(
      status({ dueAt: past(), submissionStatus: 'graded', gradesPublished: true, assessmentClosed: true }).kind,
    ).toBe('graded')
  })
})

describe('scoreTone', () => {
  it('null score is neutral', () => {
    expect(scoreTone(null, 100)).toBe('neutral')
  })

  it('points <= 0 is neutral (covers ungraded assignments)', () => {
    expect(scoreTone(5, 0)).toBe('neutral')
    expect(scoreTone(5, -1)).toBe('neutral')
  })

  it('success at/above 80, warning just below', () => {
    expect(scoreTone(80, 100)).toBe('success')
    expect(scoreTone(79.9, 100)).toBe('warning')
    expect(scoreTone(100, 100)).toBe('success')
  })

  it('warning at/above 60, destructive just below', () => {
    expect(scoreTone(60, 100)).toBe('warning')
    expect(scoreTone(59.9, 100)).toBe('destructive')
  })

  it('a real zero score is destructive, not masked to neutral', () => {
    expect(scoreTone(0, 100)).toBe('destructive')
  })
})
