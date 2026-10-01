// Per-course quiz scores breakdown for students. Shows a summary row
// (average score, quizzes completed, passed) and a detailed table.
'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { ClipboardCheck, CheckCircle, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { StudentQuizScore } from '@/app/(dashboard)/student/courses/[sectionId]/grades/actions'

interface StudentQuizScoresTableProps {
  scores: StudentQuizScore[]
  sectionId: string
}

export function StudentQuizScoresTable({ scores, sectionId }: StudentQuizScoresTableProps) {
  const router = useRouter()

  const stats = useMemo(() => {
    const attempted = scores.filter((s) => s.score != null)
    const passed = scores.filter((s) => s.passed)
    const avgScore =
      attempted.length > 0
        ? parseFloat(
            (attempted.reduce((sum, s) => sum + (s.score ?? 0), 0) / attempted.length).toFixed(1)
          )
        : null
    return {
      avgScore,
      completed: attempted.length,
      passed: passed.length,
      total: scores.length,
    }
  }, [scores])

  if (scores.length === 0) {
    // Matches the Assignments and Projects tabs beside it, which already use the
    // shared component. A bare line here was the odd one out.
    return (
      <EmptyState
        variant="teaching"
        icon={ClipboardCheck}
        title="No quizzes yet"
        description="Your instructor has not published any quizzes for this course. Scores appear here once they do."
      />
    )
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return '—'
    // Pin the timeZone so the server (UTC) and the browser (local TZ) render the
    // same calendar day — otherwise dates near a day boundary mismatch on
    // hydration (React #418) and the SSR markup is discarded on every load.
    return new Date(dateStr).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  function isOverdue(submittedAt: string | null, dueDate: string | null) {
    if (!submittedAt || !dueDate) return false
    return new Date(submittedAt) > new Date(dueDate)
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Quiz Scores</h2>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Average Score</p>
            </div>
            <p className="text-3xl font-semibold tabular-nums tracking-tight">
              {stats.avgScore != null ? `${stats.avgScore}%` : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Completed</p>
            </div>
            <p className="text-3xl font-semibold tabular-nums tracking-tight">
              {stats.completed} / {stats.total}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Passed</p>
            </div>
            <p className="text-3xl font-semibold tabular-nums tracking-tight">{stats.passed}</p>
          </CardContent>
        </Card>
      </div>

      {/* Scores table */}
      <div className="border border-border rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Quiz</TableHead>
              <TableHead className="text-center">Score</TableHead>
              <TableHead className="text-center">Points</TableHead>
              <TableHead className="text-center">Status</TableHead>
              <TableHead className="text-center">Submitted</TableHead>
              <TableHead className="text-center">Due Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scores.map((s) => {
              const hasAttempt = s.score != null
              const overdue = isOverdue(s.submittedAt, s.dueDate)

              return (
                <TableRow
                  key={s.quizId}
                  className={cn(
                    hasAttempt && s.attemptId && 'cursor-pointer hover:bg-muted/60'
                  )}
                  onClick={() => {
                    if (hasAttempt && s.attemptId) {
                      router.push(
                        `/student/courses/${sectionId}/quizzes/${s.quizId}/results/${s.attemptId}`
                      )
                    }
                  }}
                >
                  <TableCell className="font-medium text-sm">{s.quizTitle}</TableCell>
                  <TableCell className="text-center">
                    {hasAttempt ? (
                      <span
                        className={cn(
                          'text-sm font-semibold tabular-nums',
                          s.passed ? 'text-success-muted-foreground' : 'text-destructive'
                        )}
                      >
                        {s.score}%
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">
                    {hasAttempt
                      ? `${s.earnedPoints ?? 0} / ${s.totalPoints ?? 0}`
                      : '—'}
                  </TableCell>
                  <TableCell className="text-center">
                    {hasAttempt ? (
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px]',
                          s.passed
                            ? 'bg-success-muted text-success-muted-foreground border-success/30'
                            : 'bg-destructive-muted text-destructive border-destructive/30'
                        )}
                      >
                        {s.passed ? 'Pass' : 'Fail'}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        Not Attempted
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">
                    {formatDate(s.submittedAt)}
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    <span className="text-muted-foreground">{formatDate(s.dueDate)}</span>
                    {overdue && (
                      <Badge variant="outline" className="ml-1 text-[10px] bg-warning-muted text-warning-muted-foreground border-warning/30">
                        Late
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
