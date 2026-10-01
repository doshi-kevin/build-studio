// A scheduled publish time must be in the FUTURE (#311).
//
// The server used to take whatever it was given, and the auto-publish sweep flips
// any draft whose scheduled time has passed — so a past value pushed the quiz live
// on the very next list load, skipping the publish gate.
//
// The rule is deliberately split: CREATE enforces it in the schema, UPDATE enforces
// it in the action against the STORED value (see actions-prof-quizzes.test.ts),
// because a schedule that merely elapsed while the professor kept editing must stay
// saveable. This file covers the shared predicate and the create-side schema.
import { describe, it, expect } from 'vitest'
import {
  createQuizFullServerSchema,
  updateQuizServerSchema,
  isScheduledPublishInPast,
} from '@/lib/validations/quiz'

const HOUR_MS = 60 * 60 * 1000
const future = () => new Date(Date.now() + HOUR_MS).toISOString()
const past = () => new Date(Date.now() - HOUR_MS).toISOString()

/** createQuizFullServerSchema requires a title; everything else is optional. */
const createInput = (scheduledPublishAt?: string | null) => ({
  title: 'Midterm',
  ...(scheduledPublishAt === undefined ? {} : { scheduledPublishAt }),
})

describe('isScheduledPublishInPast', () => {
  it('is false for null/undefined — that is how a schedule is CLEARED', () => {
    // If clearing counted as "in the past" the professor could never un-schedule
    // a quiz whose time had already elapsed.
    expect(isScheduledPublishInPast(null)).toBe(false)
    expect(isScheduledPublishInPast(undefined)).toBe(false)
  })

  it('is true at the boundary — a time equal to now is already spent', () => {
    // `<=`, not `<`: the auto-publish sweep uses lte(scheduled_publish_at, now),
    // so a time exactly equal to now WOULD fire on the next load.
    expect(isScheduledPublishInPast(new Date(Date.now() - 1000).toISOString())).toBe(true)
    expect(isScheduledPublishInPast(future())).toBe(false)
  })

  it('treats an unparseable value as past — fail closed rather than storing garbage', () => {
    // NaN fails every comparison, so a comparison-only check would let this store
    // a value the sweep can never act on and the UI can never render.
    expect(isScheduledPublishInPast('tomorrow')).toBe(true)
    expect(isScheduledPublishInPast('')).toBe(true)
  })
})

describe('createQuizFullServerSchema.scheduledPublishAt', () => {
  it('accepts a future time', () => {
    expect(createQuizFullServerSchema.safeParse(createInput(future())).success).toBe(true)
  })

  it('rejects a past time — a brand-new quiz has no elapsed schedule to preserve', () => {
    const parsed = createQuizFullServerSchema.safeParse(createInput(past()))
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBe('Scheduled publish time must be in the future')
  })

  it('accepts null and an omitted field', () => {
    expect(createQuizFullServerSchema.safeParse(createInput(null)).success).toBe(true)
    expect(createQuizFullServerSchema.safeParse(createInput()).success).toBe(true)
  })
})

describe('updateQuizServerSchema.scheduledPublishAt', () => {
  it('does NOT reject a past time at the schema layer', () => {
    // Load-bearing: QuizStudio's autosave resends scheduledPublishAt on every save
    // while publishMode === 'scheduled'. A quiz whose schedule elapsed mid-edit
    // (or that the auto-publish gate held back for having no questions) would have
    // every later autosave rejected — including the unrelated title/question edits
    // in the same payload. The action decides instead, by comparing to the stored
    // value; see 'updateQuiz scheduled publish' in actions-prof-quizzes.test.ts.
    expect(updateQuizServerSchema.safeParse({ scheduledPublishAt: past() }).success).toBe(true)
    expect(updateQuizServerSchema.safeParse({ scheduledPublishAt: null }).success).toBe(true)
  })
})
