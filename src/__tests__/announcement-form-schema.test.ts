// Every announcement create and edit silently did nothing on main: the FORM used
// createAnnouncementSchema as its resolver, but that schema demands an absolute
// instant for scheduled_at while the form field holds a datetime-local wall-clock
// ('' when unset). Validation rejected before onSubmit could convert, and because
// the scheduled_at input only renders while status === 'scheduled' there was
// nowhere for the message to show. No toast, no network request, no clue.
//
// These pin BOTH halves: the server contract stays strict, and the form shape is
// what the form actually produces.
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createAnnouncementSchema } from '@/lib/validations/announcement'

// Mirrors AnnouncementForm's resolver schema.
const formSchema = createAnnouncementSchema
  .extend({ scheduled_at: z.string().optional().nullable() })
  .superRefine((data, ctx) => {
    if (data.status === 'scheduled' && !data.scheduled_at) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduled_at'], message: 'Pick when this should publish.' })
    }
  })

const base = { title: 'Quiz Friday', content: 'Read chapter 4.', is_pinned: false, status: 'draft' as const }

describe('announcement form schema — what the form actually submits', () => {
  it("accepts an empty scheduled_at, which is EVERY draft and published post", () => {
    // the exact value toLocalDateTimeInput(null) returns, and the one that broke it
    expect(formSchema.safeParse({ ...base, scheduled_at: '' }).success).toBe(true)
    expect(formSchema.safeParse({ ...base, status: 'published', scheduled_at: '' }).success).toBe(true)
  })

  it('accepts the offset-less local string a datetime-local input yields', () => {
    const r = formSchema.safeParse({ ...base, status: 'scheduled', scheduled_at: '2026-08-27T10:30' })
    expect(r.success).toBe(true)
  })

  it('still requires a time when the professor chose to schedule', () => {
    const r = formSchema.safeParse({ ...base, status: 'scheduled', scheduled_at: '' })
    expect(r.success).toBe(false)
    if (!r.success) {
      // must land on the field the professor can actually see
      expect(r.error.issues[0].path).toEqual(['scheduled_at'])
    }
  })
})

describe('server contract stays strict', () => {
  it('rejects the pre-conversion local string, so the conversion cannot be skipped', () => {
    expect(createAnnouncementSchema.safeParse({ ...base, scheduled_at: '2026-08-27T10:30' }).success).toBe(false)
    expect(createAnnouncementSchema.safeParse({ ...base, scheduled_at: '' }).success).toBe(false)
  })

  it('accepts an absolute instant', () => {
    expect(createAnnouncementSchema.safeParse({ ...base, scheduled_at: '2026-08-27T14:30:00.000Z' }).success).toBe(true)
    expect(createAnnouncementSchema.safeParse({ ...base, scheduled_at: null }).success).toBe(true)
  })
})
