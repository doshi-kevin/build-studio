'use client'

// Quiz detail page for students — shows quiz info, attempts, and start/resume buttons.

import { useState, useEffect, useCallback, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Clock, FileQuestion, FileText, Award, Play, Loader2, CalendarClock, ShieldAlert, Camera, Info, AlertTriangle, Eye, Maximize, Lock } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DeadEnd } from '@/components/ui/dead-end'
import { Separator } from '@/components/ui/separator'
import { PageHeader } from '@/components/professor/PageHeader'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  getQuizForAttempt,
  getMyAttempts,
  startAttempt,
} from '@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions'
import { attemptsExhausted, type Quiz, type QuizAttempt } from '@/lib/validations/quiz'
import { enterFullscreen } from '@/lib/quiz/fullscreen'
import { formatDate, isPastDue } from '@/lib/quiz/utils'

interface StudentQuizDetailProps {
  sectionId: string
  quizId: string
}

export function StudentQuizDetail({ sectionId, quizId }: StudentQuizDetailProps) {
  const router = useRouter()
  const [quiz, setQuiz] = useState<Quiz | null>(null)
  const [quizMissing, setQuizMissing] = useState(false)
  const [attempts, setAttempts] = useState<QuizAttempt[]>([])
  const [isPending, startTransition] = useTransition()
  const [proctoringDialogOpen, setProctoringDialogOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<'start' | 'resume'>('start')

  useEffect(() => {
    async function load() {
      const [quizResult, attemptsResult] = await Promise.all([
        getQuizForAttempt(sectionId, quizId),
        getMyAttempts(sectionId, quizId),
      ])

      // Missing quiz = a dead end rendered in place, not a silent bounce to the
      // list (see .claude/rules/dead-ends.md). Client fetch, so no notFound().
      if (quizResult.error || !quizResult.data) {
        setQuizMissing(true)
        return
      }

      setQuiz(quizResult.data)
      setAttempts(attemptsResult.data || [])
    }
    load()
  }, [sectionId, quizId, router])

  const submittedAttempts = attempts.filter((a) => a.status === 'submitted')
  const inProgressAttempt = attempts.find((a) => a.status === 'in_progress')
  // null = no limit, so there is no number to count down from.
  const attemptsRemaining =
    quiz && quiz.maxAttempts !== null ? quiz.maxAttempts - submittedAttempts.length : null
  const canAttempt = !!quiz && !attemptsExhausted(quiz.maxAttempts, submittedAttempts.length)
  const bestScore = submittedAttempts.length > 0
    ? Math.max(...submittedAttempts.map((a) => a.score ?? 0))
    : null

  const proceedAfterAcknowledge = useCallback(() => {
    if (!quiz) return
    setProctoringDialogOpen(false)
    // Enter fullscreen from the user gesture (click) — browsers block it from useEffect
    enterFullscreen()
    // Adaptive (CCAT) quizzes use a server-driven single-item player which
    // creates/resumes the attempt itself — route straight to it.
    if (quiz.adaptiveMode) {
      router.push(`/student/courses/${sectionId}/quizzes/${quiz.id}/adaptive`)
      return
    }
    if (pendingAction === 'resume' && inProgressAttempt) {
      router.push(`/student/courses/${sectionId}/quizzes/${quiz.id}/attempt/${inProgressAttempt.id}`)
      return
    }
    startTransition(async () => {
      const result = await startAttempt(sectionId, quiz.id)
      if (result.error) {
        toast.error(result.error)
        return
      }
      if (result.data) {
        router.push(`/student/courses/${sectionId}/quizzes/${quiz.id}/attempt/${result.data.id}`)
      }
    })
  }, [quiz, sectionId, router, pendingAction, inProgressAttempt])

  const handleStart = useCallback(() => {
    if (!quiz) return
    setPendingAction('start')
    setProctoringDialogOpen(true)
  }, [quiz])

  const handleResume = useCallback(() => {
    if (!quiz || !inProgressAttempt) return
    setPendingAction('resume')
    setProctoringDialogOpen(true)
  }, [quiz, inProgressAttempt])

  if (quizMissing) {
    // Client component, so unlike the server boundaries we know sectionId here
    // and can exit straight back to this course's quiz list.
    return (
      <DeadEnd
        title="We couldn't find that quiz"
        description="It may have been removed, or you may not have access to it."
        action={{ label: 'Back to quizzes', href: `/student/courses/${sectionId}/quizzes` }}
      />
    )
  }

  if (!quiz) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/student/courses/${sectionId}/quizzes`}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to Quizzes
      </Link>

      <PageHeader title={quiz.title} description={quiz.description || undefined} />

      <Card className="p-6">
        <h3 className="text-sm font-semibold mb-4">Quiz Information</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="flex items-center gap-2">
            <FileQuestion className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Questions</p>
              <p className="text-sm font-medium tabular-nums">
                {quiz.questionIds.length}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Time Limit</p>
              <p className="text-sm font-medium tabular-nums">
                {quiz.timeLimitMinutes ? `${quiz.timeLimitMinutes} minutes` : 'No limit'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Award className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Pass Threshold</p>
              <p className="text-sm font-medium tabular-nums">{quiz.passThreshold}%</p>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Attempts</p>
            <p className="text-sm font-medium tabular-nums">
              {/* A bare count under an "Attempts" label reads as an allowance, not usage —
                  say it the way the Time Limit cell beside it does. */}
              {quiz.maxAttempts === null
                ? `${submittedAttempts.length} used · No limit`
                : `${submittedAttempts.length}/${quiz.maxAttempts}`}
            </p>
          </div>
        </div>

        {quiz.dueDate && (
          <>
            <Separator className="my-4" />
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm">
                <span className="text-muted-foreground">Due: </span>
                <span className={`font-medium ${isPastDue(quiz.dueDate) ? 'text-destructive' : ''}`}>
                  {/* formatDate keeps a date-only due date on its stored day; the
                      old local-time render showed the previous day, and a 00:00
                      clock time that the picker never actually set (#311). */}
                  {formatDate(quiz.dueDate)}
                </span>
                {isPastDue(quiz.dueDate) && (
                  <span className="text-xs text-destructive ml-2">Past due</span>
                )}
              </p>
            </div>
          </>
        )}

        {bestScore !== null && (
          <>
            <Separator className="my-4" />
            <p className="text-sm">
              Best score: <span className="font-semibold tabular-nums">{bestScore}%</span>
            </p>
          </>
        )}
      </Card>

      {/* ── Quiz Rules ── */}
      {(() => {
        const rules: { icon: React.ReactNode; text: string; warn?: boolean }[] = []

        if (quiz.timeLimitMinutes) {
          rules.push({
            icon: <Clock className="h-3.5 w-3.5" />,
            text: `${quiz.timeLimitMinutes}-minute time limit — quiz auto-submits when time runs out`,
          })
        }

        if (quiz.negativeMarking) {
          const penaltyPct = Math.round((quiz.negativeMarkingPenalty ?? 0.25) * 100)
          rules.push({
            icon: <AlertTriangle className="h-3.5 w-3.5" />,
            text: `Negative marking — wrong answers deduct ${penaltyPct}% of question points (e.g. ${penaltyPct}% of 4 pts = ${(4 * penaltyPct / 100).toFixed(1)} pt deducted). Unanswered questions are not penalized, so skip if unsure.`,
            warn: true,
          })
        }

        if (attemptsRemaining === 1 && !inProgressAttempt) {
          rules.push({
            icon: <AlertTriangle className="h-3.5 w-3.5" />,
            text: 'This is your last attempt',
            warn: true,
          })
        }

        if (quiz.proctoringEnabled) {
          rules.push({
            icon: <Eye className="h-3.5 w-3.5" />,
            text: quiz.videoProctoringEnabled
              ? 'This quiz is proctored — keyboard activity, tab switches, and webcam are monitored'
              : 'This quiz is proctored — keyboard activity and tab switches are monitored',
          })
        }

        if (quiz.allowFormulaSheet && quiz.formulaSheetUrl) {
          rules.push({
            icon: <FileText className="h-3.5 w-3.5" />,
            text: 'A formula sheet is provided — you can expand it at any time during the quiz',
          })
        }

        if (rules.length === 0) return null

        return (
          <Card className="p-5 bg-muted/20">
            <div className="flex items-center gap-2 mb-3">
              <Info className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Quiz Rules</h3>
            </div>
            <div className="space-y-2">
              {rules.map((rule, i) => (
                <div key={i} className={`flex items-start gap-2.5 text-xs ${rule.warn ? 'text-warning-muted-foreground' : 'text-muted-foreground'}`}>
                  <span className="mt-0.5 shrink-0">{rule.icon}</span>
                  <span>{rule.text}</span>
                </div>
              ))}
            </div>
          </Card>
        )
      })()}

      <div className="flex gap-3">
        {inProgressAttempt ? (
          <Button onClick={handleResume}>
            <Play className="h-4 w-4 mr-2" />
            Resume Attempt
          </Button>
        ) : canAttempt ? (
          <Button
            onClick={handleStart}
            disabled={isPending}
          >
            <Play className="h-4 w-4 mr-2" />
            {isPending
              ? 'Starting...'
              : submittedAttempts.length > 0
                ? 'Retry Quiz'
                : 'Start Quiz'}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">All attempts have been used.</p>
        )}
      </div>

      {/* Proctoring acknowledgment dialog */}
      <Dialog open={proctoringDialogOpen} onOpenChange={setProctoringDialogOpen}>
        <DialogContent className="sm:max-w-sm p-0 overflow-hidden">
          {/* Visual header */}
          <div className="bg-muted/30 border-b px-6 pt-8 pb-6 flex flex-col items-center text-center">
            <div className="w-14 h-14 rounded-2xl border border-border bg-background flex items-center justify-center mb-4">
              <AlertTriangle className="h-7 w-7" />
            </div>
            <DialogHeader className="space-y-1.5">
              <DialogTitle className="text-lg font-semibold tracking-tight">
                Before You Begin
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground max-w-[280px]">
                Please read the following instructions carefully.
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="px-6 py-5 space-y-3.5">
            {/* Fullscreen warning */}
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl border border-border bg-muted/50 flex items-center justify-center shrink-0">
                <Maximize className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium">Fullscreen mode</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  The quiz will open in fullscreen. The sidebar and navigation will be hidden.
                </p>
              </div>
            </div>

            {/* No going back warning */}
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl border border-border bg-muted/50 flex items-center justify-center shrink-0">
                <Lock className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium">No exit until submission</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  You cannot leave the quiz or navigate away until you submit your answers.
                </p>
              </div>
            </div>

            {/* Time limit reminder */}
            {(quiz.timeLimitMinutes ?? 0) > 0 && (
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-xl border border-border bg-muted/50 flex items-center justify-center shrink-0">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">{quiz.timeLimitMinutes} minute time limit</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    The quiz will auto-submit when time runs out.
                  </p>
                </div>
              </div>
            )}

            {/* Proctoring notice (conditional) */}
            {quiz.proctoringEnabled && (
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-xl border border-border bg-muted/50 flex items-center justify-center shrink-0">
                  <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">Proctored attempt</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    Your activity will be monitored for academic integrity.
                  </p>
                </div>
              </div>
            )}

            {/* Video proctoring notice (conditional) */}
            {quiz.videoProctoringEnabled && (
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-xl border border-border bg-muted/50 flex items-center justify-center shrink-0">
                  <Camera className="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">Webcam will be active</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    Ensure your camera is enabled and your face is clearly visible throughout the quiz.
                  </p>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2 pt-2">
              <Button
                className="w-full rounded-full"
                onClick={proceedAfterAcknowledge}
                disabled={isPending}
              >
                {isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Starting...</>
                ) : (
                  <>I Understand, Begin</>
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                onClick={() => setProctoringDialogOpen(false)}
              >
                Go Back
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
