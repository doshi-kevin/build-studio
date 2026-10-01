// Logic tests for assessment-mode phase math (computeAssessmentTiming). The risky
// parts are the phase boundaries (work→upload→closed), the early-finish clamp that
// may only SHRINK the work window (never extend past the scheduled end), and the
// ceil-based remainingSeconds so a fresh phase reads its full duration.
import { describe, it, expect } from 'vitest'
import {
  computeAssessmentTiming,
  isBriefVisible,
  assessmentTimingNow,
  canSubmitAssessmentAt,
  isAssessmentWindowClosedNow,
  isAlreadySubmittedError,
  isTerminalSubmitError,
} from '@/lib/assignments/assessment'

const START = '2026-06-09T01:00:00.000Z'
const T0 = new Date(START).getTime()
const MIN = 60_000
// 30 min work, 10 min upload → work ends at T0+30m, upload ends at T0+40m.
const config = { workMinutes: 30, uploadMinutes: 10 }

describe('computeAssessmentTiming', () => {
  it('returns lobby with nulls when not started', () => {
    expect(computeAssessmentTiming(null, null, config, T0)).toEqual({
      phase: 'lobby',
      remainingSeconds: 0,
      workEndsAtMs: null,
      uploadEndsAtMs: null,
    })
  })

  it('is in the work phase at the instant it started, with the full work window left', () => {
    const r = computeAssessmentTiming(START, null, config, T0)
    expect(r.phase).toBe('work')
    expect(r.remainingSeconds).toBe(30 * 60)
    expect(r.workEndsAtMs).toBe(T0 + 30 * MIN)
    expect(r.uploadEndsAtMs).toBe(T0 + 40 * MIN)
  })

  it('counts down remaining seconds during the work phase', () => {
    expect(computeAssessmentTiming(START, null, config, T0 + 10 * MIN).remainingSeconds).toBe(20 * 60)
    expect(computeAssessmentTiming(START, null, config, T0 + 29 * MIN).remainingSeconds).toBe(60)
  })

  it('crosses into upload exactly at the work-end boundary', () => {
    // At the boundary nowMs === workEndsAtMs: no longer < workEndsAtMs → upload phase.
    const r = computeAssessmentTiming(START, null, config, T0 + 30 * MIN)
    expect(r.phase).toBe('upload')
    expect(r.remainingSeconds).toBe(10 * 60) // full upload window
  })

  it('counts down during the upload phase', () => {
    const r = computeAssessmentTiming(START, null, config, T0 + 35 * MIN)
    expect(r.phase).toBe('upload')
    expect(r.remainingSeconds).toBe(5 * 60)
  })

  it('closes exactly at the upload-end boundary with zero remaining', () => {
    const r = computeAssessmentTiming(START, null, config, T0 + 40 * MIN)
    expect(r.phase).toBe('closed')
    expect(r.remainingSeconds).toBe(0)
    expect(r.workEndsAtMs).toBe(T0 + 30 * MIN)
    expect(r.uploadEndsAtMs).toBe(T0 + 40 * MIN)
  })

  it('stays closed past the window', () => {
    expect(computeAssessmentTiming(START, null, config, T0 + 120 * MIN).phase).toBe('closed')
  })

  it('ceils partial seconds so a nearly-full phase does not read one second short', () => {
    // 500ms into the work phase → 30*60 - 1 whole second elapsed rounds UP.
    expect(computeAssessmentTiming(START, null, config, T0 + 500).remainingSeconds).toBe(30 * 60)
    // 1.5s in → ceil((30m - 1500ms)/1000) = 1799.
    expect(computeAssessmentTiming(START, null, config, T0 + 1500).remainingSeconds).toBe(30 * 60 - 1)
  })

  describe('early finish', () => {
    const workEndedEarly = new Date(T0 + 20 * MIN).toISOString() // finished at 20 min

    it('shrinks the work window to the early-finish time and shifts the upload window earlier', () => {
      const r = computeAssessmentTiming(START, workEndedEarly, config, T0 + 21 * MIN)
      // Work ended at 20m, so at 21m we are in upload; upload runs 20m→30m.
      expect(r.phase).toBe('upload')
      expect(r.workEndsAtMs).toBe(T0 + 20 * MIN)
      expect(r.uploadEndsAtMs).toBe(T0 + 30 * MIN)
      expect(r.remainingSeconds).toBe(9 * 60) // 30m - 21m = 9m of upload left
    })

    it('is still in work before the early-finish time', () => {
      const r = computeAssessmentTiming(START, workEndedEarly, config, T0 + 15 * MIN)
      expect(r.phase).toBe('work')
      expect(r.remainingSeconds).toBe(5 * 60) // 20m early-end - 15m now
    })

    it('never EXTENDS the window: a workEndedAt after the scheduled end is clamped to scheduled', () => {
      const lateStamp = new Date(T0 + 45 * MIN).toISOString() // past scheduled 30m end
      const r = computeAssessmentTiming(START, lateStamp, config, T0 + 10 * MIN)
      expect(r.workEndsAtMs).toBe(T0 + 30 * MIN) // clamped, not 45m
      expect(r.uploadEndsAtMs).toBe(T0 + 40 * MIN)
    })
  })

  describe('untimed work (workMinutes null)', () => {
    const untimed = { workMinutes: null, uploadMinutes: 10 }

    it('stays in the work phase with no countdown until the student finishes', () => {
      const r = computeAssessmentTiming(START, null, untimed, T0 + 120 * MIN)
      expect(r.phase).toBe('work')
      expect(r.remainingSeconds).toBe(0)
      expect(r.workEndsAtMs).toBeNull()
      expect(r.uploadEndsAtMs).toBeNull()
    })

    it('starts the upload window from the finish instant once the student finishes', () => {
      const finished = new Date(T0 + 90 * MIN).toISOString()
      const r = computeAssessmentTiming(START, finished, untimed, T0 + 93 * MIN)
      expect(r.phase).toBe('upload')
      expect(r.workEndsAtMs).toBe(T0 + 90 * MIN)
      expect(r.uploadEndsAtMs).toBe(T0 + 100 * MIN)
      expect(r.remainingSeconds).toBe(7 * 60)
    })

    it('closes after the upload window elapses', () => {
      const finished = new Date(T0 + 90 * MIN).toISOString()
      expect(computeAssessmentTiming(START, finished, untimed, T0 + 101 * MIN).phase).toBe('closed')
    })
  })
})

describe('isBriefVisible', () => {
  it('is visible only during the work phase', () => {
    expect(isBriefVisible('work')).toBe(true)
    expect(isBriefVisible('lobby')).toBe(false)
    expect(isBriefVisible('upload')).toBe(false)
    expect(isBriefVisible('closed')).toBe(false)
  })
})

describe('canSubmitAssessmentAt', () => {
  // upload window: T0+30m to T0+40m; grace is 2 min → hard cutoff at T0+42m
  const closedTiming = computeAssessmentTiming(START, null, config, T0 + 41 * MIN) // past upload end, within grace
  const veryClosedTiming = computeAssessmentTiming(START, null, config, T0 + 50 * MIN) // well past grace

  it('allows submit during the upload phase', () => {
    const timing = computeAssessmentTiming(START, null, config, T0 + 35 * MIN)
    expect(canSubmitAssessmentAt(timing, T0 + 35 * MIN, null)).toBe(true)
  })

  it('allows submit within the 2-min grace period after the window closes', () => {
    // T0+41m is 1 min past uploadEndsAtMs (T0+40m), still within 2-min grace
    expect(canSubmitAssessmentAt(closedTiming, T0 + 41 * MIN, null)).toBe(true)
  })

  it('blocks submit once past the grace period with no reopen window', () => {
    expect(canSubmitAssessmentAt(veryClosedTiming, T0 + 50 * MIN, null)).toBe(false)
    expect(canSubmitAssessmentAt(veryClosedTiming, T0 + 50 * MIN, undefined)).toBe(false)
  })

  it('allows submit past grace when a professor reopen window is active', () => {
    const reopenUntil = new Date(T0 + 60 * MIN).toISOString()
    expect(canSubmitAssessmentAt(veryClosedTiming, T0 + 50 * MIN, reopenUntil)).toBe(true)
  })

  it('blocks submit when the reopen window itself has expired', () => {
    const expiredReopen = new Date(T0 + 45 * MIN).toISOString()
    expect(canSubmitAssessmentAt(veryClosedTiming, T0 + 50 * MIN, expiredReopen)).toBe(false)
  })

  it('always allows submit when still in the work phase (not yet past upload window)', () => {
    const workTiming = computeAssessmentTiming(START, null, config, T0 + 10 * MIN)
    expect(canSubmitAssessmentAt(workTiming, T0 + 10 * MIN, null)).toBe(true)
  })
})

describe('assessmentTimingNow', () => {
  it('matches computeAssessmentTiming against the current clock', () => {
    const now = Date.now()
    const started = new Date(now - 5 * MIN).toISOString()
    // Recompute with the same start; both use "now" ~identically. Compare the phase and
    // allow a 1s slack on remainingSeconds for the tiny gap between the two Date.now() reads.
    const live = assessmentTimingNow(started, null, config)
    const ref = computeAssessmentTiming(started, null, config, Date.now())
    expect(live.phase).toBe('work')
    expect(ref.phase).toBe('work')
    expect(Math.abs(live.remainingSeconds - ref.remainingSeconds)).toBeLessThanOrEqual(1)
  })
})

// The runner classifies submitAssessment's error MESSAGE to decide whether to keep promising a
// retry. These pin that classification against the ACTUAL strings the server returns, so an edit
// to either side is caught (the "already completed" case was missed by the original inline regex).
describe('submit-error classification', () => {
  // Verbatim from assessment-actions.ts.
  const CLOSED = 'The assessment window has closed. Ask your professor to reopen it for you.'
  const DEADLINE = 'The deadline for this assessment has passed. Ask your professor to reopen it for you.'
  const RESET = 'This attempt was reset. Reload the page to start again.'
  const ALREADY = 'You have already completed this assessment.'
  const SAVE_FAILED = 'Could not save your submission. Please try again.'
  const OFFLINE = 'Your device looks offline. Reconnect, then submit again.'

  it('isAlreadySubmittedError catches only the already-recorded case', () => {
    expect(isAlreadySubmittedError(ALREADY)).toBe(true)
    expect(isAlreadySubmittedError(CLOSED)).toBe(false)
    expect(isAlreadySubmittedError(SAVE_FAILED)).toBe(false)
  })

  it('isTerminalSubmitError catches ALL four terminal server errors (incl. already-completed)', () => {
    expect(isTerminalSubmitError(CLOSED)).toBe(true)
    expect(isTerminalSubmitError(DEADLINE)).toBe(true)
    expect(isTerminalSubmitError(RESET)).toBe(true)
    expect(isTerminalSubmitError(ALREADY)).toBe(true) // the case the original regex missed
  })

  it('isTerminalSubmitError leaves genuinely retryable errors retryable', () => {
    expect(isTerminalSubmitError(SAVE_FAILED)).toBe(false)
    expect(isTerminalSubmitError(OFFLINE)).toBe(false)
  })
})

// The shared predicate behind the "Assessment closed" state on BOTH student surfaces. It must stay
// false for an attempt that was never started (there is no window yet to close).
describe('isAssessmentWindowClosedNow', () => {
  const config = { workMinutes: 1, uploadMinutes: 1 }
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

  it('is false when the student never started', () => {
    expect(isAssessmentWindowClosedNow(null, null, config, null)).toBe(false)
  })

  it('is false while the window is still open', () => {
    expect(isAssessmentWindowClosedNow(ago(10_000), null, config, null)).toBe(false)
  })

  it('is true once work + upload + the submit grace have all elapsed', () => {
    // 1 min work + 1 min upload + 2 min grace = 4 min; go comfortably past it.
    expect(isAssessmentWindowClosedNow(ago(10 * 60_000), null, config, null)).toBe(true)
  })

  it('UNTIMED work that was started but never finished is never "closed" (no false lockout)', () => {
    expect(isAssessmentWindowClosedNow(ago(10 * 60_000), null, { workMinutes: null, uploadMinutes: 1 }, null)).toBe(false)
  })

  it('an active professor reopen window keeps it open', () => {
    const until = new Date(Date.now() + 2 * 60 * 60_000).toISOString()
    expect(isAssessmentWindowClosedNow(ago(10 * 60_000), null, config, until)).toBe(false)
  })
})
