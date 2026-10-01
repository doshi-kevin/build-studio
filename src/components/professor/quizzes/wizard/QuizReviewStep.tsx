// The studio's Preview toggle: settings/stats summary, then every question
// rendered through the student player's QuestionDisplay — the exact UI a
// student sees while taking the quiz (read-only: inputs are disabled, nothing
// persisted, no answer key). Opens anchored to the question that was being edited.

'use client'

import { useEffect, useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Check, Clock, ListChecks, BarChart3, Pencil, AlertTriangle } from 'lucide-react'
import {
  EXPLANATION_TIMING_LABELS,
  QUESTION_TYPE_LABELS,
  type Question,
  type QuizItemType,
  type DifficultyLevel,
  type ExplanationTiming,
} from '@/lib/validations/quiz'
import { cn } from '@/lib/utils'
import { QuestionDisplay } from '@/components/student/quizzes/QuestionDisplay'
import { WalkthroughChat } from '@/components/student/quizzes/AdaptiveQuizPlayer'
import { wizardToServerInput, type WizardFormValues } from './QuizStudio'
import type { WizardQuestion } from './QuestionEditorCard'

// Wrap the exact payload the save path persists (wizardToServerInput) in a
// Question shell, so the preview can't drift from what students will get.
function toPreviewQuestion(q: WizardQuestion): Question {
  return {
    ...wizardToServerInput(q),
    id: q.clientId,
    sectionId: 'preview',
    createdAt: '',
    updatedAt: '',
  }
}

const TYPE_COLORS: Record<QuizItemType, string> = {
  multiple_choice: 'bg-muted text-muted-foreground',
  true_false: 'bg-muted text-muted-foreground',
  short_answer: 'bg-muted text-muted-foreground',
  fill_in_blank: 'bg-muted text-muted-foreground',
  explanation: 'bg-muted text-muted-foreground',
  walkthrough: 'bg-muted text-muted-foreground',
}

const DIFFICULTY_COLORS: Record<DifficultyLevel, string> = {
  easy: 'bg-success-muted text-success-muted-foreground',
  medium: 'bg-warning-muted text-warning-muted-foreground',
  hard: 'bg-destructive-muted text-destructive-muted-foreground',
}

interface QuizReviewStepProps {
  formValues: WizardFormValues
  questions: WizardQuestion[]
  /** Called when professor clicks Edit on a question — selects it back in the editor */
  onEditQuestion?: (index: number) => void
  /** Open scrolled to (and highlighting) this question — the one being edited,
   *  so the global preview doubles as a per-question check with zero scrolling. */
  anchorClientId?: string
}

export function QuizReviewStep({
  formValues,
  questions,
  onEditQuestion,
  anchorClientId,
}: QuizReviewStepProps) {
  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0)

  // Student-shaped questions. Memoized so choice-array identity is stable
  // across answer clicks — QuestionDisplay's shuffle memo keys on it, and a
  // fresh array every render would reshuffle the options on every click.
  const previewQuestions = useMemo(() => questions.map(toPreviewQuestion), [questions])

  const editButton = (idx: number) =>
    onEditQuestion && (
      <button
        type="button"
        onClick={() => onEditQuestion(idx)}
        className="p-1 rounded-full text-muted-foreground hover:text-foreground transition-colors"
        title="Edit this question"
        aria-label={`Edit question ${idx + 1}`}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    )

  useEffect(() => {
    if (!anchorClientId) return
    // Instant jump (not smooth): opening preview should land on the question.
    // Also move focus to the card so keyboard/screen-reader users get the same
    // "you are here" as sighted users (preventScroll: scrollIntoView owns position).
    const card = document.getElementById(`preview-question-${anchorClientId}`)
    card?.scrollIntoView({ block: 'start' })
    card?.focus({ preventScroll: true })
  }, [anchorClientId])

  // Difficulty distribution
  const diffDist = { easy: 0, medium: 0, hard: 0 }
  for (const q of questions) {
    diffDist[q.difficulty]++
  }

  // Type distribution
  const typeDist: Record<QuizItemType, number> = {
    multiple_choice: 0,
    true_false: 0,
    short_answer: 0,
    fill_in_blank: 0,
    explanation: 0,
    walkthrough: 0,
  }
  for (const q of questions) {
    typeDist[q.questionType]++
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Quiz Summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Quiz Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">Title:</span>{' '}
              <span className="font-medium">{formValues.title || '(untitled)'}</span>
            </div>
            {formValues.description && (
              <div className="sm:col-span-2">
                <span className="text-muted-foreground">Description:</span>{' '}
                {formValues.description}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Time Limit:</span>{' '}
              {formValues.timeLimitMinutes ? `${formValues.timeLimitMinutes} min` : 'None'}
            </div>
            <div>
              <span className="text-muted-foreground">Max Attempts:</span>{' '}
              {formValues.maxAttempts ?? 'No limit'}
            </div>
            <div>
              <span className="text-muted-foreground">Pass Threshold:</span>{' '}
              {formValues.passThreshold}%
            </div>
            <div>
              <span className="text-muted-foreground">Explanations:</span>{' '}
              {EXPLANATION_TIMING_LABELS[(formValues.showExplanations || 'after_submission') as ExplanationTiming]}
            </div>
          </div>

          {/* Toggle Settings */}
          <div className="flex flex-wrap gap-2 pt-2">
            <SettingBadge label="Shuffle Questions" enabled={formValues.shuffleQuestions} />
            <SettingBadge label="Shuffle Answers" enabled={formValues.shuffleAnswers} />
            <SettingBadge label="Leaderboard" enabled={formValues.showLeaderboard} />
            <SettingBadge
              label="Formula Sheet"
              enabled={formValues.allowFormulaSheet}
              warn={formValues.allowFormulaSheet && !formValues.formulaSheetUrl}
            />
            <SettingBadge label="Negative Marking" enabled={formValues.negativeMarking} />
            <SettingBadge label="Proctoring" enabled={formValues.proctoringEnabled} />
            <SettingBadge label="Video Proctoring" enabled={formValues.videoProctoringEnabled} />
          </div>
        </CardContent>
      </Card>

      {/* Stats Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          icon={<ListChecks className="h-4 w-4" />}
          label="Questions"
          value={questions.length}
        />
        <StatCard
          icon={<BarChart3 className="h-4 w-4" />}
          label="Total Points"
          value={totalPoints}
        />
        <div className="border rounded-xl p-3">
          <p className="text-xs text-muted-foreground mb-1">Difficulty</p>
          <div className="flex flex-wrap gap-1">
            {diffDist.easy > 0 && (
              <Badge className={cn('text-xs', DIFFICULTY_COLORS.easy)}>
                {diffDist.easy} Easy
              </Badge>
            )}
            {diffDist.medium > 0 && (
              <Badge className={cn('text-xs', DIFFICULTY_COLORS.medium)}>
                {diffDist.medium} Med
              </Badge>
            )}
            {diffDist.hard > 0 && (
              <Badge className={cn('text-xs', DIFFICULTY_COLORS.hard)}>
                {diffDist.hard} Hard
              </Badge>
            )}
          </div>
        </div>
        <div className="border rounded-xl p-3">
          <p className="text-xs text-muted-foreground mb-1">Types</p>
          <div className="flex flex-wrap gap-1">
            {(Object.entries(typeDist) as [QuizItemType, number][])
              .filter(([, count]) => count > 0)
              .map(([type, count]) => (
                <Badge key={type} className={cn('text-xs', TYPE_COLORS[type])}>
                  {count} {QUESTION_TYPE_LABELS[type]}
                </Badge>
              ))}
          </div>
        </div>
      </div>

      {/* Questions Preview */}
      <div className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-muted-foreground">
            Questions ({questions.length})
          </h3>
          {questions.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Read-only preview — this is exactly what students see while taking the quiz.
            </p>
          )}
        </div>

        {questions.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            No questions added yet. Go back to Step 2 to add questions.
          </p>
        )}

        {questions.map((q, idx) => (
          <Card
            key={q.clientId}
            id={`preview-question-${q.clientId}`}
            tabIndex={q.clientId === anchorClientId ? -1 : undefined}
            aria-current={q.clientId === anchorClientId ? 'true' : undefined}
            className={cn(
              'scroll-mt-4',
              q.clientId === anchorClientId &&
                'border-primary/40 bg-primary/5 ring-2 ring-primary/20 focus-visible:outline-none',
            )}
          >
            <CardContent className="pt-4 pb-4">
              {q.questionType === 'walkthrough' ? (
                // Same switch the adaptive player makes: walkthroughs render the
                // tutor chat, not QuestionDisplay. Inert here — no tutor calls.
                <WalkthroughChat
                  sectionId=""
                  attemptId=""
                  question={previewQuestions[idx]}
                  questionNumber={idx + 1}
                  onFinish={() => {}}
                  submitting={false}
                  preview
                  headerAction={editButton(idx)}
                />
              ) : (
                <QuestionDisplay
                  question={previewQuestions[idx]}
                  answer={undefined}
                  questionNumber={idx + 1}
                  shuffleAnswers={formValues.shuffleAnswers}
                  onAnswer={() => {}}
                  headerAction={editButton(idx)}
                  disabled
                />
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

function SettingBadge({ label, enabled, warn }: { label: string; enabled?: boolean; warn?: boolean }) {
  if (!enabled) return null
  if (warn) {
    return (
      <Badge variant="secondary" className="text-xs bg-warning-muted text-warning-muted-foreground">
        <AlertTriangle className="h-3 w-3 mr-1" />
        {label} (no file)
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className="text-xs">
      <Check className="h-3 w-3 mr-1" />
      {label}
    </Badge>
  )
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: number
}) {
  return (
    <div className="border rounded-xl p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}
