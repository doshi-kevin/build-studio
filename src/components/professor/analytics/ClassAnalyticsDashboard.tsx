// Cross-quiz class analytics dashboard — summary cards, quiz trend chart,
// score distribution, topic performance, and at-risk students section.
'use client'

import {
  Users,
  ClipboardCheck,
  Award,
  Target,
  TrendingUp,
  AlertTriangle,
  BookOpen,
  ListTree,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { QuizTrendChart } from './QuizTrendChart'
import { SkillPerformanceChart } from './SkillPerformanceChart'
import type { ClassAnalytics } from '@/app/(dashboard)/professor/courses/[sectionId]/grades/actions'

interface ClassAnalyticsDashboardProps {
  analytics: ClassAnalytics
  /** Only for the empty-state CTA — an empty state with no way out is not finished. */
  sectionId: string
}

// Semantic score color: ≥70% success, ≥50% warning, else destructive.
function scoreColorClass(score: number): string {
  if (score >= 70) return 'text-success-muted-foreground'
  if (score >= 50) return 'text-warning-muted-foreground'
  return 'text-destructive'
}

export function ClassAnalyticsDashboard({ analytics, sectionId }: ClassAnalyticsDashboardProps) {
  const { summary, quizPerformance, overallScoreDistribution, topicPerformance, metricLabel, atRiskThreshold, trackedSkillCount, masteryUnavailable, atRiskStudents } = analytics

  /* No blanket "no quizzes, no analytics" return. Mastery folds in assignments
     and live-classroom quizzes, so a course that grades only assignments has
     real skill data — gating the whole tab on quizzes existing hid it, and hid
     both of the empty states below with it. Each block now owns its own empty
     state, and the quiz-derived widgets are the only ones that need quizzes. */
  const hasQuizData = summary.totalQuizzes > 0

  return (
    <div className="space-y-6">
      {/* Summary Cards — quiz-derived, so only when quizzes exist. */}
      {hasQuizData && (
      <AnimatedList className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <SummaryCard
          icon={Users}
          label="Students"
          value={summary.totalStudents.toString()}
        />
        <SummaryCard
          icon={ClipboardCheck}
          label="Quizzes"
          value={summary.totalQuizzes.toString()}
        />
        <SummaryCard
          icon={Award}
          label="Class average"
          value={summary.classAverage != null ? `${summary.classAverage}%` : '--'}
          colorClass={summary.classAverage != null ? scoreColorClass(summary.classAverage) : undefined}
        />
        <SummaryCard
          icon={Target}
          label="Avg pass rate"
          value={summary.averagePassRate != null ? `${summary.averagePassRate}%` : '--'}
          colorClass={summary.averagePassRate != null ? scoreColorClass(summary.averagePassRate) : undefined}
        />
        <SummaryCard
          icon={TrendingUp}
          label="Total attempts"
          value={summary.totalAttempts.toString()}
        />
      </AnimatedList>
      )}

      {/* Quiz Trend + Score Distribution — also quiz-derived. */}
      {hasQuizData && (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <QuizTrendChart data={quizPerformance} />

        {/* Score Distribution */}
        <Card className="rounded-xl border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Overall score distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {summary.totalAttempts === 0 ? (
              <p className="text-sm text-muted-foreground">No attempts yet.</p>
            ) : (
              <div className="space-y-3">
                {overallScoreDistribution.map((bucket) => {
                  const pct = summary.totalAttempts > 0
                    ? (bucket.count / summary.totalAttempts) * 100
                    : 0
                  return (
                    <div key={bucket.range} className="flex items-center gap-3">
                      <span className="w-16 text-right text-xs font-medium tabular-nums text-muted-foreground">
                        {bucket.range}
                      </span>
                      <div className="relative h-7 flex-1 overflow-hidden rounded-full bg-muted/50">
                        {pct > 0 && (
                          <div
                            className="h-full rounded-full bg-primary transition duration-200 ease-out"
                            style={{ width: `${Math.max(pct, 4)}%` }}
                          />
                        )}
                        {bucket.count > 0 && (
                          <span className="absolute inset-y-0 left-2 flex items-center text-xs font-semibold tabular-nums text-primary-foreground mix-blend-difference">
                            {bucket.count}
                          </span>
                        )}
                      </div>
                      <span className="w-8 text-xs font-medium tabular-nums text-muted-foreground">
                        {bucket.count}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      )}

      {/* Skill mastery. Two distinct empty states, because a chart that simply
          vanishes cannot be told from a chart that is broken. Matches the wording
          the roadmap's class lens already uses for the same two cases. */}
      {masteryUnavailable ? (
        /* A failed read is not an empty course. Saying "no skills set up" here
           would assert something we do not know, and the Modules CTA would send
           a professor to recreate skills they already have. */
        <EmptyState
          variant="teaching"
          icon={ListTree}
          title="Couldn't load skill mastery"
          description="The scores didn't come back. This is usually temporary, so reload the page in a moment."
        />
      ) : topicPerformance.length > 0 ? (
        <SkillPerformanceChart
          data={topicPerformance}
          metricLabel={metricLabel}
          atRiskThreshold={atRiskThreshold}
          totalTracked={trackedSkillCount}
        />
      ) : trackedSkillCount === 0 ? (
        <EmptyState
          variant="teaching"
          icon={ListTree}
          title="No skills set up yet"
          description="Upload course material in Modules and Scholera extracts the skills it covers, or add them yourself from the roadmap."
          action={{ label: 'Go to Modules', href: `/professor/courses/${sectionId}/modules` }}
        />
      ) : (
        <EmptyState
          variant="teaching"
          icon={ListTree}
          title="No mastery data yet"
          description="This course tracks skills, but nothing has been graded against them yet. Scores appear here once students submit graded work."
        />
      )}

      {/* At-Risk Students */}
      {atRiskStudents.length > 0 && (
        <Card className="rounded-xl border-border">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              At-risk students
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {atRiskStudents.map((student) => (
                <div key={student.studentId} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{student.studentName}</p>
                    <p className="truncate text-xs text-muted-foreground">{student.studentEmail}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {student.averagePct != null && (
                      <div className="text-right">
                        <p className={cn('text-sm font-semibold tabular-nums', scoreColorClass(student.averagePct))}>
                          {student.averagePct}%
                        </p>
                        <p className="text-[10px] text-muted-foreground">avg score</p>
                      </div>
                    )}
                    {student.belowCount > 0 && (
                      <Badge variant="secondary" className="bg-destructive-muted text-[10px] text-destructive-muted-foreground">
                        {student.belowCount} below threshold
                      </Badge>
                    )}
                    {student.missingCount > 0 && (
                      <Badge variant="secondary" className="bg-warning-muted text-[10px] text-warning-muted-foreground">
                        <BookOpen className="mr-0.5 h-3 w-3" />
                        {student.missingCount} missing
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// --- Summary Card Helper ---

function SummaryCard({ icon: Icon, label, value, colorClass }: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  colorClass?: string
}) {
  return (
    <AnimatedItem>
      <Card className="rounded-xl border-border transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm">
        <CardContent className="pt-5 pb-4">
          <div className="mb-2 flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
          </div>
          <p className={cn('text-3xl font-semibold tabular-nums', colorClass ?? 'text-foreground')}>
            {value}
          </p>
        </CardContent>
      </Card>
    </AnimatedItem>
  )
}
