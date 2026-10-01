// Quiz question review card shown on student results page.
// Displays correctness, answer choices, explanation, and time spent per question.
'use client'

import { useState } from 'react'
import { CheckCircle2, XCircle, Clock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { QuizCodeBlock } from '@/components/shared/QuizCodeBlock'
import { blankPlaceholderText } from '@/lib/quiz/fill-in-blank'
import type { Question, Answer, ExplanationTiming } from '@/lib/validations/quiz'
import type { TranscriptTurn } from '@/lib/quiz/irt/grader'
import { gradeAnswer } from '@/lib/quiz/scoring'
import { canRevealQuizAnswers, QUESTION_TYPE_LABELS } from '@/lib/validations/quiz'

/** Format seconds as "Xm Ys" or "Xs" for the time chip. */
function formatTimeSec(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

/**
 * How many turns show before the dialogue collapses.
 *
 * A walkthrough is a multi-turn tutor conversation, so a long one would otherwise blow out the
 * vertical rhythm of a results page that lists every question.
 */
const TRANSCRIPT_PREVIEW_TURNS = 4

/**
 * The graded conversation for a Guided Walkthrough (#379 part 1).
 *
 * BOTH roles are shown, deliberately. The student's replies alone are unreadable without the
 * question that prompted them, and a professor grading from this card has to be able to see whether
 * the tutor led the student somewhere or hallucinated. Showing only the last student turn, which was
 * the cheap option, is actively misleading: the final turn is usually a closing acknowledgement with
 * no academic content.
 */
function WalkthroughTranscript({ turns }: { turns: TranscriptTurn[] }) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = turns.length > TRANSCRIPT_PREVIEW_TURNS
  const shown = expanded || !collapsible ? turns : turns.slice(0, TRANSCRIPT_PREVIEW_TURNS)

  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="space-y-1.5 rounded-xl border border-border bg-muted/20 p-2.5">
        {shown.map((turn, i) => (
          <div
            key={i}
            className={cn('flex', turn.role === 'student' ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[85%] rounded-2xl px-3 py-1.5 text-sm',
                turn.role === 'student'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card text-foreground border border-border',
              )}
            >
              <span className="block text-[10px] uppercase tracking-wider opacity-70">
                {turn.role === 'student' ? 'You' : 'Tutor'}
              </span>
              {turn.text}
            </div>
          </div>
        ))}
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded
            ? 'Show less'
            : `Show all ${turns.length} messages`}
        </button>
      )}
    </div>
  )
}

interface QuestionReviewCardProps {
  question: Question
  answer: Answer | undefined
  /**
   * The graded dialogue for a Guided Walkthrough, which does NOT live in `answer.textAnswer`
   * (#379 part 1). The player never sends it; the grader reads it from
   * `quiz_attempts.walkthrough_transcripts`, so without this the card said "No answer recorded"
   * beside real AI feedback, including on full-credit answers.
   */
  walkthroughTranscript?: TranscriptTurn[]
  questionNumber: number
  /** Controls when explanations are shown. Defaults to 'after_submission' (always show). */
  showExplanations?: ExplanationTiming
  /** Quiz due date — needed for 'after_due_date' timing. */
  dueDate?: string | null
  /** Adaptive-only AI grading detail. When present, an "AI feedback" panel is
   *  shown under the answer for AI-graded (explanation/walkthrough) questions. */
  aiFeedback?: { rationale?: string | null; nodesMet?: number | null; nodesTotal?: number | null }
}

export function QuestionReviewCard({
  question,
  answer,
  walkthroughTranscript,
  questionNumber,
  showExplanations = 'after_submission',
  dueDate,
  aiFeedback,
}: QuestionReviewCardProps) {
  // AI-graded types can't be graded client-side — gradeAnswer's default case
  // returns Wrong/0 regardless of the real grade — so trust the server-stored
  // grade for them. A null stored grade means the answer was never graded.
  const aiGraded =
    question.content.questionType === 'explanation' || question.content.questionType === 'walkthrough'
  const { content } = question

  // Gate correct answer reveals behind the same timing as explanations.
  // Without this, students see correct answers immediately and can share them
  // with others who haven't taken the quiz yet.
  // Call the ONE predicate the server gates on rather than restating it here —
  // a local copy is exactly how the client and server rules drifted (#311).
  const canRevealAnswers = canRevealQuizAnswers(showExplanations, dueDate)
  // 'never' → canRevealAnswers stays false

  // Grade client-side ONLY when answers are revealable. When reveal is gated the
  // server redacts the answer key (acceptedAnswers / blank answers / correctAnswer
  // are omitted), so gradeAnswer would throw on the missing fields — and the
  // correctness result isn't shown before the reveal window anyway.
  const result = aiGraded
    ? { isCorrect: answer?.isCorrect ?? false, earnedPoints: answer?.earnedPoints ?? 0 }
    : answer && canRevealAnswers
      ? gradeAnswer(question, answer)
      : { isCorrect: false, earnedPoints: 0 }
  const ungraded = aiGraded && answer?.isCorrect == null

  const cardTint =
    canRevealAnswers && !ungraded
      ? result.isCorrect
        ? 'border-success/30 bg-success-muted/40'
        : 'border-destructive/30 bg-destructive-muted/40'
      : ''

  return (
    <Card className={`p-4 ${cardTint}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex shrink-0 flex-col items-center gap-0.5">
          {ungraded ? (
            <span className="text-[10px] font-medium text-muted-foreground">Not graded</span>
          ) : canRevealAnswers ? (
            result.isCorrect ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-success-muted-foreground" />
                <span className="text-[10px] font-medium text-success-muted-foreground">Correct</span>
              </>
            ) : (
              <>
                <XCircle className="h-5 w-5 text-destructive" />
                <span className="text-[10px] font-medium text-destructive">Wrong</span>
              </>
            )
          ) : (
            <span className="text-[10px] font-medium text-muted-foreground">Answered</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-muted-foreground">Q{questionNumber}</span>
            <Badge variant="outline" className="text-xs">
              {QUESTION_TYPE_LABELS[content.questionType]}
            </Badge>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {canRevealAnswers && !ungraded
                ? `${result.earnedPoints}/${question.points} pt`
                : `${question.points} pt`}
            </span>
          </div>

            {question.imageUrl && (
              <div className="mb-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={question.imageUrl}
                  alt="Question"
                  className="h-auto max-h-48 w-auto rounded-xl border border-border bg-muted/30 object-contain"
                />
              </div>
            )}

            {/* FIB stems carry {{blank:id:answers}} tokens — render them as
                "_____" placeholders (blankPlaceholderText also strips the answer
                payload, so it can never leak here even if the fetch didn't). */}
            <MarkdownLatex
              content={
                content.questionType === 'fill_in_blank'
                  ? blankPlaceholderText(question.questionText)
                  : question.questionText
              }
              className="text-sm font-medium mb-2"
            />

            {question.codeSnippet && (
              <div className="mb-3">
                <QuizCodeBlock
                  language={question.codeSnippet.language}
                  code={question.codeSnippet.code}
                />
              </div>
            )}

          {/* Show student answer and correct answer */}
          {content.questionType === 'multiple_choice' && (
            <div className="space-y-1">
              {content.choices.map((choice) => {
                const isSelected = answer?.selectedChoiceIds?.includes(choice.id)
                const isCorrect = choice.isCorrect
                let bg = ''
                if (canRevealAnswers) {
                  if (isCorrect) bg = 'bg-success-muted/60 border-success/30'
                  else if (isSelected) bg = 'bg-destructive-muted/50 border-destructive/30'
                } else if (isSelected) {
                  // Only show which choices the student picked, no correct/incorrect coloring
                  bg = 'bg-muted/30 border-foreground/20'
                }

                return (
                  <div
                    key={choice.id}
                    className={`flex items-center gap-2 rounded-xl border p-2 text-sm ${bg || 'border-border'}`}
                  >
                    {canRevealAnswers && isSelected && !isCorrect && <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />}
                    {canRevealAnswers && isCorrect && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success-muted-foreground" />}
                    {isSelected && !canRevealAnswers && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    {!isSelected && !(canRevealAnswers && isCorrect) && <span className="w-3.5" />}
                    <MarkdownLatex content={choice.text} variant="compact" className="text-sm" />
                  </div>
                )
              })}
            </div>
          )}

          {content.questionType === 'true_false' && (
            <div className="space-y-1.5 text-sm">
              <div>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Your answer</span>
                <p className={`mt-0.5 font-medium ${canRevealAnswers ? (result.isCorrect ? 'text-success-muted-foreground' : 'text-destructive') : 'text-foreground'}`}>
                  {answer?.booleanAnswer === true ? 'True' : answer?.booleanAnswer === false ? 'False' : 'No answer'}
                </p>
              </div>
              {canRevealAnswers && !result.isCorrect && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Correct answer</span>
                  <p className="mt-0.5 font-medium text-success-muted-foreground">{content.correctAnswer ? 'True' : 'False'}</p>
                </div>
              )}
            </div>
          )}

          {content.questionType === 'short_answer' && (
            <div className="space-y-1.5 text-sm">
              <div>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Your answer</span>
                <p className={`mt-0.5 ${canRevealAnswers ? (result.isCorrect ? 'text-success-muted-foreground' : 'text-destructive') : 'text-foreground'}`}>
                  {answer?.textAnswer || <span className="italic text-muted-foreground">No answer</span>}
                </p>
              </div>
              {canRevealAnswers && !result.isCorrect && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Accepted answers</span>
                  <div className="mt-0.5 space-y-0.5">
                    {content.acceptedAnswers.map((a, i) => (
                      <div key={i} className="text-success-muted-foreground">
                        <MarkdownLatex content={a} variant="compact" className="text-sm" />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {content.questionType === 'fill_in_blank' && (
            <div className="space-y-3 text-sm">
              {content.blanks.map((blank, i) => {
                const studentAnswer = answer?.blankAnswers?.[blank.id] ?? ''
                // acceptedAnswers is omitted by the server when reveal is gated,
                // so only compute correctness (and read it) when revealing.
                const blankCorrect =
                  canRevealAnswers &&
                  (blank.acceptedAnswers ?? []).some((a) =>
                    blank.caseSensitive
                      ? studentAnswer.trim() === a.trim()
                      : studentAnswer.trim().toLowerCase() === a.trim().toLowerCase(),
                  )
                return (
                  <div key={blank.id} className="space-y-1 rounded-xl border border-border bg-muted/10 p-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Blank {i + 1}</p>
                    <p className={canRevealAnswers ? (blankCorrect ? 'text-success-muted-foreground' : 'text-destructive') : 'text-foreground'}>
                      {studentAnswer || <span className="italic text-muted-foreground">No answer</span>}
                    </p>
                    {canRevealAnswers && !blankCorrect && (
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Accepted</span>
                        <div className="mt-0.5 space-y-0.5">
                          {(blank.acceptedAnswers ?? []).map((a, j) => (
                            <div key={j} className="text-success-muted-foreground">
                              <MarkdownLatex content={a} variant="compact" className="text-sm" />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {aiGraded && (
            <div className="space-y-1.5 text-sm">
              <div>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  {walkthroughTranscript?.length ? 'Your conversation' : 'Your answer'}
                </span>
                {walkthroughTranscript?.length ? (
                  <WalkthroughTranscript turns={walkthroughTranscript} />
                ) : answer?.textAnswer ? (
                  <p className="mt-0.5 text-foreground">{answer.textAnswer}</p>
                ) : (
                  <p className="mt-0.5 italic text-muted-foreground">No answer recorded</p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                This question type is AI-graded in adaptive quizzes
                {ungraded ? ' and was not auto-graded here' : ''}.
              </p>
              {aiFeedback && (aiFeedback.rationale || (aiFeedback.nodesTotal ?? 0) > 0) && (
                <div className="mt-1 rounded-xl bg-muted/50 p-2.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    AI feedback
                  </span>
                  {(aiFeedback.nodesTotal ?? 0) > 0 && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Covered {aiFeedback.nodesMet} of {aiFeedback.nodesTotal} key ideas.
                    </p>
                  )}
                  {aiFeedback.rationale && <p className="mt-0.5 text-sm text-foreground">{aiFeedback.rationale}</p>}
                </div>
              )}
            </div>
          )}

          {/* Explanation — respects professor's showExplanations setting */}
          {canRevealAnswers && question.explanation && (
            <div className="mt-3 rounded-xl border border-border bg-muted/50 p-3">
              <p className="text-xs font-medium text-foreground mb-0.5">Explanation</p>
              <MarkdownLatex content={question.explanation} className="text-sm text-muted-foreground" />
            </div>
          )}

          {/* Time spent chip — only shown when time was recorded */}
          {(answer?.timeSpentSeconds ?? 0) > 0 && (
            <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3 shrink-0" />
              <span>Time: {formatTimeSec(answer!.timeSpentSeconds!)}</span>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
