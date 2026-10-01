// Regression tests for issue #174: AI-graded question types (explanation,
// walkthrough) on student results. The linear review card must trust the
// server-stored grade (gradeAnswer's default case always says Wrong/0) and show
// the submitted answer; the adaptive results page must surface the AI grading
// rationale and rubric coverage per question.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QuestionReviewCard } from '@/components/student/quizzes/QuestionReviewCard'
import { AdaptiveResults, abilityLabel } from '@/components/student/quizzes/AdaptiveResults'
import { getUnifiedResult } from '@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions'
import type { UnifiedResult } from '@/lib/quiz/unified-result'
import type { Question } from '@/lib/validations/quiz'
import { buildQuestion, buildAnswer } from './helpers/test-data-builders'

vi.mock('@/components/shared/MarkdownLatex', () => ({
  MarkdownLatex: ({ content }: { content: string }) => <span>{content}</span>,
}))
vi.mock('@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions', () => ({
  getUnifiedResult: vi.fn(),
}))

// Build a UnifiedResult payload (as getUnifiedResult returns it) for an adaptive
// attempt with a single AI-graded review item. The review section now renders
// via QuestionReviewCard, so the payload carries the full question + answer the
// card looks up (keyed by questionId), plus the adaptive AI-feedback fields on
// the review item.
function adaptivePayload(
  review: UnifiedResult['questionReview'][number],
  walkthroughTranscripts: Record<string, { role: 'student' | 'tutor'; text: string }[]> = {},
) {
  const question = buildQuestion({
    id: review.questionId,
    questionText: review.questionText,
    content: { questionType: 'explanation' },
    points: review.points,
  })
  const answer = buildAnswer({
    questionId: review.questionId,
    textAnswer: review.textAnswer ?? undefined,
    isCorrect: review.isCorrect,
    earnedPoints: review.earnedPoints ?? undefined,
  })
  return {
    result: {
      isAdaptive: true,
      grade: review.earnedPoints != null && review.points ? Math.round((review.earnedPoints / review.points) * 100) : 0,
      pass: true,
      passThreshold: 60,
      totalPoints: review.points,
      earnedPoints: review.earnedPoints,
      questionReview: [review],
      topics: { topics: [], strengths: [], weaknesses: [] },
      ability: { engine: 'irt' as const, theta: 0.4, se: 0.3, itemsServed: 1, stopReason: 'length' },
      noQuestionsRecorded: false,
    } satisfies UnifiedResult,
    quizTitle: 'Adaptive Quiz',
    showExplanations: 'after_submission' as const,
    dueDate: null,
    showLeaderboard: false,
    timeSpentSeconds: 0,
    questions: [question],
    answers: { [review.questionId]: answer },
    misconceptions: [],
    walkthroughTranscripts,
  }
}

const explanationQuestion = buildQuestion({
  id: 'q-expl',
  questionText: 'Explain why the sky is blue',
  content: { questionType: 'explanation' },
  points: 10,
})

describe('QuestionReviewCard — AI-graded types (issue #174)', () => {
  it('uses the server-stored grade instead of the client-side Wrong/0 default', () => {
    render(
      <QuestionReviewCard
        question={explanationQuestion}
        answer={buildAnswer({
          questionId: 'q-expl',
          textAnswer: 'Rayleigh scattering of sunlight',
          isCorrect: true,
          earnedPoints: 10,
        })}
        questionNumber={1}
      />,
    )
    expect(screen.getByText('Correct')).toBeInTheDocument()
    expect(screen.getByText('10/10 pt')).toBeInTheDocument()
    expect(screen.queryByText('Wrong')).not.toBeInTheDocument()
  })

  it('shows the submitted answer text', () => {
    render(
      <QuestionReviewCard
        question={explanationQuestion}
        answer={buildAnswer({
          questionId: 'q-expl',
          textAnswer: 'Rayleigh scattering of sunlight',
          isCorrect: false,
          earnedPoints: 0,
        })}
        questionNumber={1}
      />,
    )
    expect(screen.getByText('Your answer')).toBeInTheDocument()
    expect(screen.getByText('Rayleigh scattering of sunlight')).toBeInTheDocument()
  })

  it('shows a neutral Not graded state when no stored grade exists', () => {
    render(
      <QuestionReviewCard
        question={explanationQuestion}
        answer={buildAnswer({ questionId: 'q-expl', textAnswer: 'some attempt', isCorrect: null })}
        questionNumber={1}
      />,
    )
    expect(screen.getByText('Not graded')).toBeInTheDocument()
    expect(screen.queryByText('Wrong')).not.toBeInTheDocument()
    expect(screen.queryByText('Correct')).not.toBeInTheDocument()
    // No earned/total fraction — just the question's point value
    expect(screen.getByText('10 pt')).toBeInTheDocument()
  })

  it('renders the graded conversation for a walkthrough, both roles', () => {
    /* #379 part 1. The card read `answer.textAnswer`, which a Guided Walkthrough never sets: the
       player deliberately does not send the transcript and the grader reads it from
       quiz_attempts.walkthrough_transcripts. So the card said "No answer recorded" next to real AI
       feedback, confirmed in production three times INCLUDING on a full-credit answer.

       BOTH roles are asserted on purpose. The student's replies alone are unreadable without the
       prompt that produced them, and a professor grading from this card has to be able to see
       whether the tutor led them somewhere. */
    render(
      <QuestionReviewCard
        question={buildQuestion({
          id: 'q-walk',
          questionText: 'Walk me through it',
          content: { questionType: 'walkthrough', opening: '', maxTurns: 4 },
        })}
        answer={buildAnswer({ questionId: 'q-walk' })}
        questionNumber={2}
        walkthroughTranscript={[
          { role: 'tutor', text: 'What happens to the output size?' },
          { role: 'student', text: 'It shrinks because of the stride.' },
        ]}
      />,
    )

    expect(screen.getByText('What happens to the output size?')).toBeInTheDocument()
    expect(screen.getByText('It shrinks because of the stride.')).toBeInTheDocument()
    /* The label changes too: "Your answer" is wrong for a dialogue. */
    expect(screen.getByText('Your conversation')).toBeInTheDocument()
    expect(screen.queryByText('No answer recorded')).not.toBeInTheDocument()
  })

  it('collapses a long conversation rather than blowing out the page', () => {
    /* A results page lists every question, so a 20-turn dialogue cannot render in full by default. */
    const turns = Array.from({ length: 9 }, (_, i) => ({
      role: (i % 2 === 0 ? 'tutor' : 'student') as 'tutor' | 'student',
      text: `turn number ${i}`,
    }))
    render(
      <QuestionReviewCard
        question={buildQuestion({
          id: 'q-walk',
          questionText: 'Walk me through it',
          content: { questionType: 'walkthrough', opening: '', maxTurns: 12 },
        })}
        answer={buildAnswer({ questionId: 'q-walk' })}
        questionNumber={3}
        walkthroughTranscript={turns}
      />,
    )

    expect(screen.getByText('turn number 0')).toBeInTheDocument()
    expect(screen.getByText('turn number 3')).toBeInTheDocument()
    expect(screen.queryByText('turn number 8')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Show all 9 messages/ }))
    expect(screen.getByText('turn number 8')).toBeInTheDocument()
  })

  it('renders a placeholder when no answer was recorded (walkthrough in a linear quiz)', () => {
    render(
      <QuestionReviewCard
        question={buildQuestion({
          id: 'q-walk',
          questionText: 'Walk me through it',
          content: { questionType: 'walkthrough', opening: '', maxTurns: 4 },
        })}
        answer={undefined}
        questionNumber={2}
      />,
    )
    expect(screen.getByText('No answer recorded')).toBeInTheDocument()
  })

  // Regression: when reveal is gated the server omits the answer key
  // (acceptedAnswers / blank answers), so gradeAnswer must NOT run — it would
  // throw on the missing fields. The card shows the answer without correctness.
  it('does not crash on a gated short_answer whose acceptedAnswers were redacted', () => {
    render(
      <QuestionReviewCard
        question={buildQuestion({
          id: 'q-sa',
          questionText: 'Capital of France?',
          content: { questionType: 'short_answer', caseSensitive: false } as Question['content'],
          points: 5,
        })}
        answer={buildAnswer({ questionId: 'q-sa', textAnswer: 'Paris' })}
        questionNumber={1}
        showExplanations="never"
      />,
    )
    expect(screen.getByText('Paris')).toBeInTheDocument()
    expect(screen.getByText('Answered')).toBeInTheDocument()
    expect(screen.queryByText('Accepted answers')).not.toBeInTheDocument()
  })

  it('does not crash on a gated fill_in_blank whose blank answers were redacted', () => {
    render(
      <QuestionReviewCard
        question={buildQuestion({
          id: 'q-fib2',
          questionText: 'The {{blank:b1}} assumption.',
          content: {
            questionType: 'fill_in_blank',
            blanks: [{ id: 'b1', caseSensitive: false }],
          } as Question['content'],
          points: 5,
        })}
        answer={buildAnswer({ questionId: 'q-fib2', blankAnswers: { b1: 'Markov' } })}
        questionNumber={1}
        showExplanations="never"
      />,
    )
    expect(screen.getByText('Markov')).toBeInTheDocument()
    expect(screen.queryByText('Accepted')).not.toBeInTheDocument()
  })
})

describe('abilityLabel — ±SE band vs. baseline', () => {
  it('claims Above average only when the whole band clears 0', () => {
    expect(abilityLabel(0.4, 0.3)).toBe('Above average') // band [0.1, 0.7]
  })

  it('claims Below average only when the whole band is under 0', () => {
    expect(abilityLabel(-0.4, 0.3)).toBe('Below average') // band [-0.7, -0.1]
  })

  it('says Around average when the band straddles 0', () => {
    expect(abilityLabel(0.4, 0.5)).toBe('Around average') // band [-0.1, 0.9]
  })

  // Strict-inequality boundary: a band edge landing exactly on 0 must NOT be
  // read as a confident direction — guards `>`/`<` against `>=`/`<=`.
  it('says Around average when the band edge touches 0 from above', () => {
    expect(abilityLabel(0.3, 0.3)).toBe('Around average') // theta - se === 0
  })

  it('says Around average when the band edge touches 0 from below', () => {
    expect(abilityLabel(-0.3, 0.3)).toBe('Around average') // theta + se === 0
  })
})

describe('AdaptiveResults — per-question AI feedback (issue #174)', () => {
  it('renders the question review with rationale and rubric coverage', async () => {
    vi.mocked(getUnifiedResult).mockResolvedValue(
      adaptivePayload({
        questionId: 'q-expl',
        questionText: 'Explain why the sky is blue',
        type: 'explanation',
        points: 10,
        isCorrect: true,
        earnedPoints: 7,
        textAnswer: 'Rayleigh scattering of sunlight',
        softScore: 0.67,
        rationale: 'You identified scattering but missed the wavelength dependence.',
        nodesMet: 2,
        nodesTotal: 3,
      }),
    )

    render(<AdaptiveResults sectionId="sec-1" quizId="quiz-1" attemptId="att-1" />)

    expect(await screen.findByText('Question review')).toBeInTheDocument()
    expect(screen.getByText('Explain why the sky is blue')).toBeInTheDocument()
    expect(screen.getByText('Rayleigh scattering of sunlight')).toBeInTheDocument()
    expect(screen.getByText('Covered 2 of 3 key ideas.')).toBeInTheDocument()
    expect(
      screen.getByText('You identified scattering but missed the wavelength dependence.'),
    ).toBeInTheDocument()
    expect(screen.getByText('7/10 pt')).toBeInTheDocument()
  })

  it('omits the AI feedback block when the server gated it (rationale and counts stripped)', async () => {
    vi.mocked(getUnifiedResult).mockResolvedValue(
      adaptivePayload({
        questionId: 'q-expl',
        questionText: 'Explain why the sky is blue',
        type: 'explanation',
        points: 10,
        isCorrect: true,
        earnedPoints: 5,
        textAnswer: 'an attempt',
        softScore: 0.5,
        // gated off: rationale + node counts absent
      }),
    )

    render(<AdaptiveResults sectionId="sec-1" quizId="quiz-1" attemptId="att-1" />)

    expect(await screen.findByText('Question review')).toBeInTheDocument()
    expect(screen.queryByText('AI feedback')).not.toBeInTheDocument()
  })
})
