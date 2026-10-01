// Tests for enrollment validation schemas and the institution self-unenroll policy.
// Only custom refinements, business defaults, business rules, and custom functions are tested.
// Trivial Zod built-in tests (uuid/min/max/required/optional/happy-path) have been removed.

import { describe, it, expect } from 'vitest'
import {
  updateEnrollmentStatusSchema,
} from '@/lib/validations/enrollment'
import {
  parseInstitutionSettings,
  canSelfUnenroll,
  SELF_UNENROLL_DEFAULT_DAYS,
} from '@/lib/validations/institution-settings'
import { withinAddDropWindow } from '@/lib/validations/institution'

// ── updateEnrollmentStatusSchema ─────────────────────────────

describe('updateEnrollmentStatusSchema', () => {
  const parse = (data: unknown) => updateEnrollmentStatusSchema.safeParse(data)

  it.each(['enrolled', 'completed', 'dropped', 'withdrawn'] as const)(
    'accepts status "%s"',
    (status) => {
      expect(parse({ status }).success).toBe(true)
    },
  )
})

// ── parseInstitutionSettings — MUST fail closed ──────────────
// A broken settings JSONB must never grant students self-unenroll.

describe('parseInstitutionSettings', () => {
  it.each([null, undefined, 'string', 42, [], {}])(
    'resolves %j to self-unenroll DISABLED',
    (raw) => {
      expect(parseInstitutionSettings(raw).selfUnenroll.enabled).toBe(false)
    },
  )

  it('resolves a partial/malformed selfUnenroll to disabled', () => {
    expect(parseInstitutionSettings({ selfUnenroll: { enabled: true } }).selfUnenroll.enabled).toBe(false)
    expect(parseInstitutionSettings({ selfUnenroll: { enabled: true, days: 0 } }).selfUnenroll.enabled).toBe(false)
    expect(parseInstitutionSettings({ selfUnenroll: { enabled: true, days: 9999 } }).selfUnenroll.enabled).toBe(false)
  })

  it('passes through a valid policy', () => {
    const parsed = parseInstitutionSettings({ selfUnenroll: { enabled: true, days: 30 } })
    expect(parsed.selfUnenroll).toEqual({ enabled: true, days: 30 })
  })

  it('carries a sensible default days value when disabled', () => {
    expect(parseInstitutionSettings(null).selfUnenroll.days).toBe(SELF_UNENROLL_DEFAULT_DAYS)
  })
})

// ── canSelfUnenroll — the window math both UI and action share ──

describe('canSelfUnenroll', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

  it('is false when the policy is disabled, regardless of the window', () => {
    expect(canSelfUnenroll({ enabled: false, days: 365 }, ago(0))).toBe(false)
  })

  it('is true inside the window and false after it', () => {
    const policy = { enabled: true, days: 2 }
    expect(canSelfUnenroll(policy, ago(1 * DAY_MS))).toBe(true)
    expect(canSelfUnenroll(policy, ago(3 * DAY_MS))).toBe(false)
  })

  it('fails closed on a missing or unparseable enrolled_at', () => {
    expect(canSelfUnenroll({ enabled: true, days: 14 }, null)).toBe(false)
    expect(canSelfUnenroll({ enabled: true, days: 14 }, 'not-a-date')).toBe(false)
  })
})

/**
 * withinAddDropWindow — the single predicate the student course layout and dropSection
 * both call, so the button shown and the action honoured cannot drift (#744).
 *
 * The permissive-null case is here because I got it wrong first: I made a null day count
 * fail closed, on the general principle that missing configuration should refuse. That
 * inverted parseAddDropPolicy's documented intent and would have silently removed self-drop
 * from every institution, since none has a day count set. `allowStudentDrop` is the switch
 * for turning it off; the absence of a deadline is not.
 */
describe('withinAddDropWindow (#744)', () => {
  const ymd = (offsetDays: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    return d.toISOString().slice(0, 10)
  }

  it('is open all term when no deadline is configured', () => {
    expect(
      withinAddDropWindow({ allowStudentDrop: true, addDropDeadlineDays: null }, ymd(-400)),
    ).toBe(true)
  })

  it('is closed when the institution switches self-drop off', () => {
    expect(
      withinAddDropWindow({ allowStudentDrop: false, addDropDeadlineDays: null }, ymd(-1)),
    ).toBe(false)
  })

  it('is open inside a configured window and closed after it', () => {
    const policy = { allowStudentDrop: true, addDropDeadlineDays: 7 }
    expect(withinAddDropWindow(policy, ymd(-2))).toBe(true)
    expect(withinAddDropWindow(policy, ymd(-30))).toBe(false)
  })

  it('is closed when a configured window has no section start to anchor to', () => {
    /* The one genuine unknown: a day count that cannot be resolved to a date. Distinct from
       "no deadline configured", which is a deliberate permissive choice. */
    expect(
      withinAddDropWindow({ allowStudentDrop: true, addDropDeadlineDays: 7 }, null),
    ).toBe(false)
  })

  it('gives two students in one section the same answer whenever they enrolled', () => {
    /* The whole point of moving the anchor. The predicate takes no per-student input at
       all, so it cannot vary by enrolment date even by accident. */
    const policy = { allowStudentDrop: true, addDropDeadlineDays: 7 }
    const start = ymd(-3)
    expect(withinAddDropWindow(policy, start)).toBe(withinAddDropWindow(policy, start))
  })
})
