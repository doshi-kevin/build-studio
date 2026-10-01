// Tests for section-staff (TA/grader) validation schemas.
// Focuses on custom refinements, transforms, and business rules — skips trivial
// Zod built-ins (uuid / required / optional / happy-path) unless they enforce a
// specific UX contract the server actions rely on.

import { describe, it, expect } from 'vitest'
import {
  submitStaffRequestSchema,
  approveStaffRequestSchema,
  rejectStaffRequestSchema,
  revokeStaffSchema,
  toEndOfDayIso,
  STAFF_ROLES,
} from '@/lib/validations/section-staff'

const validUUID = '550e8400-e29b-41d4-a716-446655440000'

// ── submitStaffRequestSchema ─────────────────────────────────

describe('submitStaffRequestSchema', () => {
  const parse = (data: unknown) => submitStaffRequestSchema.safeParse(data)

  const validInput = {
    section_id: validUUID,
    candidate_email: 'ta@uni.edu',
    candidate_first_name: 'Alex',
    candidate_last_name: 'Nguyen',
    requested_role: 'ta' as const,
  }

  it('lowercases candidate_email (actions rely on case-insensitive compare)', () => {
    const result = parse({ ...validInput, candidate_email: 'TA@Uni.Edu' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.candidate_email).toBe('ta@uni.edu')
  })

  it('trims candidate first/last names', () => {
    const result = parse({
      ...validInput,
      candidate_first_name: '  Alex  ',
      candidate_last_name: '  Nguyen  ',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.candidate_first_name).toBe('Alex')
      expect(result.data.candidate_last_name).toBe('Nguyen')
    }
  })

  it.each(STAFF_ROLES)('accepts requested_role "%s"', (role) => {
    expect(parse({ ...validInput, requested_role: role }).success).toBe(true)
  })

  it('rejects requested_role outside the enum (e.g. "professor")', () => {
    expect(parse({ ...validInput, requested_role: 'professor' }).success).toBe(false)
  })

  it('rejects empty first name', () => {
    expect(parse({ ...validInput, candidate_first_name: '' }).success).toBe(false)
  })

  it('rejects empty last name', () => {
    expect(parse({ ...validInput, candidate_last_name: '' }).success).toBe(false)
  })

  it('rejects first name over 50 characters', () => {
    expect(parse({ ...validInput, candidate_first_name: 'a'.repeat(51) }).success).toBe(false)
  })

  it('rejects message over 500 characters', () => {
    expect(parse({ ...validInput, message: 'a'.repeat(501) }).success).toBe(false)
  })

  it('accepts empty-string message (form default) via z.literal("") fallback', () => {
    expect(parse({ ...validInput, message: '' }).success).toBe(true)
  })

  it('rejects non-email candidate_email', () => {
    expect(parse({ ...validInput, candidate_email: 'not-an-email' }).success).toBe(false)
  })

  it('rejects invalid section_id (not a UUID)', () => {
    expect(parse({ ...validInput, section_id: 'section-1' }).success).toBe(false)
  })
})

// ── approveStaffRequestSchema ────────────────────────────────

describe('approveStaffRequestSchema', () => {
  const parse = (data: unknown) => approveStaffRequestSchema.safeParse(data)

  it('accepts only request_id (starts_at/ends_at/note optional)', () => {
    expect(parse({ request_id: validUUID }).success).toBe(true)
  })

  it('rejects non-UUID request_id', () => {
    expect(parse({ request_id: 'req-1' }).success).toBe(false)
  })

  it('rejects note over 500 characters', () => {
    expect(parse({ request_id: validUUID, note: 'a'.repeat(501) }).success).toBe(false)
  })
})

// ── rejectStaffRequestSchema ─────────────────────────────────

describe('rejectStaffRequestSchema', () => {
  const parse = (data: unknown) => rejectStaffRequestSchema.safeParse(data)

  it('requires a rejection note (min length 1)', () => {
    const result = parse({ request_id: validUUID, note: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = result.error.flatten().fieldErrors
      expect(errors.note?.[0]).toBe('Rejection reason is required')
    }
  })

  it('rejects note over 500 characters', () => {
    expect(parse({ request_id: validUUID, note: 'a'.repeat(501) }).success).toBe(false)
  })

  it('accepts valid note', () => {
    expect(parse({ request_id: validUUID, note: 'Not a great fit' }).success).toBe(true)
  })
})

// ── revokeStaffSchema ────────────────────────────────────────

describe('revokeStaffSchema', () => {
  const parse = (data: unknown) => revokeStaffSchema.safeParse(data)

  it('accepts only staff_id (reason optional)', () => {
    expect(parse({ staff_id: validUUID }).success).toBe(true)
  })

  it('accepts empty-string reason via z.literal("") fallback', () => {
    expect(parse({ staff_id: validUUID, reason: '' }).success).toBe(true)
  })

  it('rejects non-UUID staff_id', () => {
    expect(parse({ staff_id: 'staff-1' }).success).toBe(false)
  })

  it('rejects reason over 500 characters', () => {
    expect(parse({ staff_id: validUUID, reason: 'a'.repeat(501) }).success).toBe(false)
  })
})

// ── starts_at / ends_at date validation (#748) ───────────────
//
// These two fields were `z.string().optional()`, so the schema accepted any
// string at all. Both dialogs then fed the value straight into
// `new Date(value + 'T23:59:59').toISOString()`, which throws RangeError on
// something unparseable — and uncaught in a client component that reached the
// error boundary and replaced the whole dashboard with "Dashboard Error". A typo
// in a date field took down the page.
//
// The interesting half is WHY a Date.parse check would not have been enough.
// `Date.parse('2026-02-31')` does not fail; it rolls forward to March 3rd. So a
// validator that only asked "does this parse" would accept a day that does not
// exist and then silently store a different date than the professor typed — the
// crash traded for a quieter wrong answer. Round-tripping the formatted date back
// and comparing is what actually rejects it, and that is the assertion below that
// a naive implementation fails.

describe('staff request date fields (#748)', () => {
  const parseEnds = (ends_at: unknown) =>
    approveStaffRequestSchema.safeParse({ request_id: validUUID, ends_at })

  it('rejects a day that does not exist, which Date.parse silently rolls forward', () => {
    /* The whole reason the refinement re-formats instead of trusting Date.parse.
       Guard the premise too: if a future runtime ever made this throw instead of
       roll, the refinement could be simplified — but until then it cannot. */
    expect(new Date('2026-02-31T00:00:00Z').toISOString().slice(0, 10)).toBe('2026-03-03')
    expect(parseEnds('2026-02-31').success).toBe(false)
  })

  it('rejects free text, which used to reach new Date() and crash the dashboard', () => {
    expect(parseEnds('banana').success).toBe(false)
  })

  it.each(['2026-05-01', '2026-05-01T23:59:59.000Z', ''])(
    'accepts %o — the schema is both the form resolver and the action validator',
    (value) => {
      /* Double duty is load-bearing: react-hook-form sees the raw yyyy-mm-dd field
         value, the server action sees the ISO datetime the dialog converted it to.
         Narrowing to either shape alone would reject every real submission from the
         other caller, so both must stay valid. */
      expect(parseEnds(value).success).toBe(true)
    },
  )

  it('applies the same validation on the submit path, not just approve', () => {
    /* Two schemas, one shared refinement — StaffRequestQueue and
       SubmitStaffRequestDialog each had their own copy of the crashing conversion,
       so fixing only one leaves the other reachable. */
    const base = {
      section_id: validUUID,
      candidate_email: 'ta@uni.edu',
      candidate_first_name: 'Alex',
      candidate_last_name: 'Nguyen',
      requested_role: 'ta' as const,
    }
    expect(submitStaffRequestSchema.safeParse({ ...base, ends_at: '2026-02-31' }).success).toBe(false)
    expect(submitStaffRequestSchema.safeParse({ ...base, starts_at: 'banana' }).success).toBe(false)
  })
})

// ── toEndOfDayIso ────────────────────────────────────────────

describe('toEndOfDayIso (#748)', () => {
  it('returns undefined instead of throwing on an unparseable value', () => {
    /* The second line of defence. The schema now rejects junk before submit, but
       this helper is what the dialogs call, and the original bug was an uncaught
       RangeError — so "returns undefined" and "does not throw" are separate claims
       and both matter. */
    expect(() => toEndOfDayIso('banana')).not.toThrow()
    expect(toEndOfDayIso('banana')).toBeUndefined()
  })

  it('extends a date-only value to the end of that day', () => {
    /* An end date has to include the day it names, or a TA loses access at midnight
       on the morning of their last day. */
    expect(toEndOfDayIso('2026-05-01')).toBe(new Date('2026-05-01T23:59:59').toISOString())
  })

  it('passes an existing datetime through without re-appending a time', () => {
    /* The old inline copy did `value + 'T23:59:59'` unconditionally, so a value that
       had already been converted once became '...T00:00:00ZT23:59:59' — unparseable,
       which is the RangeError path again. */
    expect(toEndOfDayIso('2026-05-01T12:30:00.000Z')).toBe('2026-05-01T12:30:00.000Z')
  })

  it('returns undefined for an empty field rather than the epoch', () => {
    /* `new Date('')` is Invalid Date, but `new Date('T23:59:59')` and friends are the
       kind of thing that silently becomes a real date. An untouched optional field
       must stay absent, not become a boundary the server then enforces. */
    expect(toEndOfDayIso('')).toBeUndefined()
  })
})
