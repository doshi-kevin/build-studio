'use client'

// Displays quiz results after a student submits an attempt. Shows score circle,
// summary stats, class average comparison, topic breakdown, leaderboard, and
// question-by-question review. Consumes the unified result shape (getUnifiedResult)
// so standard and adaptive quizzes share one grade/pass/topics data layer.

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Clock, Award, Target, BarChart3, Loader2, Users } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Progress } from '@/components/ui/progress'
import { PageHeader } from '@/components/professor/PageHeader'
import { ScoreCircle } from './ScoreCircle'
import { QuestionReviewCard } from './QuestionReviewCard'
import { QuizLeaderboard } from './QuizLeaderboard'
import { getUnifiedResult, getQuizClassAverage } from '@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions'
import { formatTime, formatDate, isPastDue } from '@/lib/quiz/utils'
import type { Question, Answer, ExplanationTiming } from '@/lib/validations/quiz'
import type { UnifiedResult } from '@/lib/quiz/unified-result'

interface QuizResultsProps {
  sectionId: string
  quizId: string
  attemptId: string
}

// The slice of the getUnifiedResult payload this view needs.
interface ResultData {
  result: UnifiedResult
  quizTitle: string
  showExplanations: ExplanationTiming
  dueDate: string | null
  showLeaderboard: boolean
  timeSpentSeconds: number
  questions: Question[]
  answers: Record<string, Answer>
}

export function QuizResults({ sectionId, quizId, attemptId }: QuizResultsProps) {
  const router = useRouter()
  const [data, setData] = useState<ResultData | null>(null)
  const [classAvg, setClassAvg] = useState<{ average: number; submissionCount: number; totalStudents: number; isDueDatePassed: boolean } | null>(null)

  useEffect(() => {
    async function load() {
      const [res, avgResult] = await Promise.all([
        getUnifiedResult(sectionId, attemptId),
        getQuizClassAverage(sectionId, quizId),
      ])

      if ('error' in res) {
        toast.error(res.error || 'Results not found')
        router.push(`/student/courses/${sectionId}/quizzes`)
        return
      }

      setData({
        result: res.result,
        quizTitle: res.quizTitle,
        showExplanations: res.showExplanations,
        dueDate: res.dueDate,
        showLeaderboard: res.showLeaderboard,
        timeSpentSeconds: res.timeSpentSeconds,
        questions: res.questions,
        answers: res.answers,
      })
      if (avgResult.data) setClassAvg(avgResult.data)
    }
    load()
  }, [sectionId, quizId, attemptId, router])

  if (!data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const { result, questions, answers } = data
  const score = result.grade
  const topics = result.topics.topics

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link
        href={`/student/courses/${sectionId}/quizzes`}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to Quizzes
      </Link>

      <PageHeader title={data.quizTitle} description="Results" />

      {/* Score Circle */}
      <div className="flex justify-center">
        <ScoreCircle score={score} passThreshold={result.passThreshold} />
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <Award className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Score</span>
          </div>
          <p className="text-3xl font-semibold tabular-nums">{result.earnedPoints ?? '—'}/{result.totalPoints ?? '—'}</p>
        </Card>
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <Target className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Threshold</span>
          </div>
          <p className="text-3xl font-semibold tabular-nums">{result.passThreshold}%</p>
        </Card>
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Time</span>
          </div>
          <p className="text-3xl font-semibold tabular-nums">{formatTime(data.timeSpentSeconds)}</p>
        </Card>
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Questions</span>
          </div>
          <p className="text-3xl font-semibold tabular-nums">{questions.length}</p>
        </Card>
      </div>

      {/* Class Average */}
      {classAvg && classAvg.submissionCount > 0 && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Class Average</h3>
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-semibold tabular-nums">
              {classAvg.average}%
            </span>
            <span className={`text-sm font-medium tabular-nums ${score > classAvg.average ? 'text-success-muted-foreground' : score < classAvg.average ? 'text-destructive' : 'text-muted-foreground'}`}>
              {score > classAvg.average
                ? `+${score - classAvg.average}% above average`
                : score < classAvg.average
                  ? `${classAvg.average - score}% below average`
                  : 'At class average'}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            {classAvg.isDueDatePassed
              ? `Based on ${classAvg.submissionCount} of ${classAvg.totalStudents} students`
              : `Based on ${classAvg.submissionCount} submission${classAvg.submissionCount !== 1 ? 's' : ''} so far`}
          </p>
        </Card>
      )}

      {/* Skill Breakdown — per-tag accuracy, shared with the adaptive results view */}
      {topics.length > 0 && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Skill Breakdown</h3>
          </div>
          <div className="space-y-3">
            {topics.map((t) => (
              <div key={t.tag}>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="font-medium text-foreground">{t.tag}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {t.accuracy}% · {t.totalCount} item{t.totalCount === 1 ? '' : 's'}
                  </span>
                </div>
                <Progress value={t.accuracy} />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Leaderboard */}
      {data.showLeaderboard && (
        <QuizLeaderboard sectionId={sectionId} quizId={quizId} />
      )}

      <Separator />

      {/* Question-by-Question Review */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Question Review</h2>
        {data.showExplanations === 'never' && (
          <p className="text-xs text-muted-foreground mb-3">Explanations are not available for this quiz.</p>
        )}
        {/* Same predicate and same formatter the reveal gate uses. This promised a
            date one day early, in a format used nowhere else in the app (#311). */}
        {data.showExplanations === 'after_due_date' && data.dueDate && !isPastDue(data.dueDate) && (
          <p className="text-xs text-muted-foreground mb-3">
            Explanations unlock after the due date ({formatDate(data.dueDate)}).
          </p>
        )}
        <div className="space-y-3">
          {questions.map((question, index) => (
            <QuestionReviewCard
              key={question.id}
              question={question}
              answer={answers[question.id]}
              questionNumber={index + 1}
              showExplanations={data.showExplanations}
              dueDate={data.dueDate}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
