// Validation schema tests for generateLiveQuizSchema — the input to
// generateAndPushLiveQuiz. The professor-picked timeLimitSeconds is new: it
// flows straight into the generated quiz payload (and thus the student
// countdown), so its bounds and back-compat default are the part worth pinning.

import { describe, it, expect } from 'vitest'
import { generateLiveQuizSchema } from '@/lib/validations/live-classroom'

const ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

describe('generateLiveQuizSchema', () => {
  it('accepts a valid roomId + explicit timeLimitSeconds', () => {
    const result = generateLiveQuizSchema.safeParse({
      roomId: ROOM_ID,
      timeLimitSeconds: 60,
    })
    expect(result.success).toBe(true)
    expect(result.success && result.data.timeLimitSeconds).toBe(60)
  })

  it('defaults timeLimitSeconds to 120 when omitted (back-compat)', () => {
    const result = generateLiveQuizSchema.safeParse({ roomId: ROOM_ID })
    expect(result.success).toBe(true)
    expect(result.success && result.data.timeLimitSeconds).toBe(120)
  })

  it('rejects a non-UUID roomId', () => {
    expect(generateLiveQuizSchema.safeParse({ roomId: 'not-a-uuid' }).success).toBe(false)
  })

  it('accepts the inclusive bounds (10 and 600)', () => {
    expect(generateLiveQuizSchema.safeParse({ roomId: ROOM_ID, timeLimitSeconds: 10 }).success).toBe(true)
    expect(generateLiveQuizSchema.safeParse({ roomId: ROOM_ID, timeLimitSeconds: 600 }).success).toBe(true)
  })

  it('rejects values below the min and above the max', () => {
    expect(generateLiveQuizSchema.safeParse({ roomId: ROOM_ID, timeLimitSeconds: 9 }).success).toBe(false)
    expect(generateLiveQuizSchema.safeParse({ roomId: ROOM_ID, timeLimitSeconds: 601 }).success).toBe(false)
  })

  it('rejects a non-integer timeLimitSeconds', () => {
    expect(generateLiveQuizSchema.safeParse({ roomId: ROOM_ID, timeLimitSeconds: 60.5 }).success).toBe(false)
  })
})
