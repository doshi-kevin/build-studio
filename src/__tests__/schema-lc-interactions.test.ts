// Validation schema tests for Live Classroom interactions.

import { describe, it, expect } from 'vitest'
import {
  createInteractionSchema,
  submitResponseSchema,
  askQuestionSchema,
  pollPayloadSchema,
  quizPayloadSchema,
} from '@/lib/validations/lc-interactions'

const ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

describe('createInteractionSchema', () => {
  it('accepts a valid poll', () => {
    const result = createInteractionSchema.safeParse({
      roomId: ROOM_ID,
      kind: 'poll',
      payload: {
        question: 'What is your favorite color?',
        pollType: 'single_choice',
        choices: [
          { id: '1', text: 'Red' },
          { id: '2', text: 'Blue' },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a valid quiz', () => {
    const result = createInteractionSchema.safeParse({
      roomId: ROOM_ID,
      kind: 'quiz',
      payload: {
        title: 'Pop Quiz',
        timeLimitSeconds: 60,
        questions: [
          {
            id: 'q1',
            prompt: 'What is 2+2?',
            choices: [
              { id: '4', text: '4' },
              { id: '5', text: '5' },
            ],
            correctChoiceId: '4',
          },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a quiz question tagged with subtopic UUIDs, but rejects a non-UUID topicId', () => {
    const base = {
      roomId: ROOM_ID,
      kind: 'quiz' as const,
      payload: {
        title: 'Pop Quiz',
        timeLimitSeconds: 60,
        questions: [
          {
            id: 'q1',
            prompt: 'What is 2+2?',
            choices: [
              { id: '4', text: '4' },
              { id: '5', text: '5' },
            ],
            correctChoiceId: '4',
            skillIds: ['11111111-1111-4111-8111-111111111111'],
          },
        ],
      },
    }
    expect(createInteractionSchema.safeParse(base).success).toBe(true)

    const bad = { ...base, payload: { ...base.payload, questions: [{ ...base.payload.questions[0], skillIds: ['not-a-uuid'] }] } }
    expect(createInteractionSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an unknown kind', () => {
    const result = createInteractionSchema.safeParse({
      roomId: ROOM_ID,
      kind: 'comment',
      payload: {},
    })
    expect(result.success).toBe(false)
  })

  it('rejects a poll with too few choices', () => {
    const result = pollPayloadSchema.safeParse({
      question: 'Pick one',
      choices: [{ id: '1', text: 'Only one' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a quiz with no questions', () => {
    const result = quizPayloadSchema.safeParse({
      title: 'Empty quiz',
      questions: [],
    })
    expect(result.success).toBe(false)
  })
})

describe('submitResponseSchema', () => {
  it('accepts a poll response with choiceIds', () => {
    const result = submitResponseSchema.safeParse({
      interactionId: ROOM_ID,
      response: { choiceIds: ['1'] },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a quiz response with answers map', () => {
    const result = submitResponseSchema.safeParse({
      interactionId: ROOM_ID,
      response: { answers: { q1: '4', q2: 'b' } },
    })
    expect(result.success).toBe(true)
  })

  it('rejects an empty response', () => {
    const result = submitResponseSchema.safeParse({
      interactionId: ROOM_ID,
      response: {},
    })
    expect(result.success).toBe(false)
  })
})

describe('askQuestionSchema', () => {
  it('accepts a valid question', () => {
    const result = askQuestionSchema.safeParse({
      roomId: ROOM_ID,
      text: 'Could you go back to slide 3?',
      anonymous: false,
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty text', () => {
    const result = askQuestionSchema.safeParse({
      roomId: ROOM_ID,
      text: '',
      anonymous: false,
    })
    expect(result.success).toBe(false)
  })
})
