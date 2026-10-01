'use client'

// Global grades table shown on /student/grades.
// Summarises all enrollments with grades, scores, credits, and status.

import { useMemo } from 'react'
import { GraduationCap, TrendingUp, BookOpen, Award } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/professor/PageHeader'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

const GRADE_TEXT: Record<string, string> = {
  'A+': 'text-success-muted-foreground',
  'A':  'text-success-muted-foreground',
  'A-': 'text-success-muted-foreground',
  'B+': 'text-success-muted-foreground',
  'B':  'text-success-muted-foreground',
  'B-': 'text-muted-foreground',
  'C+': 'text-warning-muted-foreground',
  'C':  'text-warning-muted-foreground',
  'C-': 'text-warning-muted-foreground',
  'D+': 'text-destructive',
  'D':  'text-destructive',
  'D-': 'text-destructive',
  'F':  'text-destructive',
}

const STATUS_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  enrolled:  { dot: 'bg-success', text: 'text-success-muted-foreground', label: 'Enrolled' },
  completed: { dot: 'bg-muted-foreground/60', text: 'text-muted-foreground', label: 'Completed' },
  dropped:   { dot: 'bg-muted-foreground/30', text: 'text-muted-foreground', label: 'Dropped' },
  withdrawn: { dot: 'bg-muted-foreground/30', text: 'text-muted-foreground', label: 'Withdrawn' },
}

function scoreColorClass(score: number | null): string {
  if (score == null) return 'text-muted-foreground'
  if (score >= 80) return 'text-success-muted-foreground'
  if (score >= 60) return 'text-warning-muted-foreground'
  return 'text-destructive'
}

interface GradesTableProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  enrollments: any[]
}

export function GradesTable({ enrollments }: GradesTableProps) {
  const averageScore = useMemo(() => {
    const scores = enrollments
      .map((e) => e.final_score)
      .filter((s): s is number => s != null)
    if (scores.length === 0) return null
    return parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1))
  }, [enrollments])

  const totalCredits = useMemo(() => {
    return enrollments
      .filter((e) => e.status === 'completed' || e.status === 'enrolled')
      .reduce((sum, e) => {
        const section = resolveJoin(e.section)
        const course = resolveJoin(section?.course)
        return sum + (course?.credits || 0)
      }, 0)
  }, [enrollments])

  if (enrollments.length === 0) {
    return (
      <div className="space-y-8 max-w-5xl mx-auto">
        <PageHeader
          title="Grades"
          description="View your grades across all courses."
        />
        <EmptyState
          variant="teaching"
          icon={GraduationCap}
          title="No grades yet"
          description="You don't have any course enrollments yet. Grades appear here once your administrator enrolls you in courses."
        />
      </div>
    )
  }

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <PageHeader
        title="Grades"
        description="Your academic record across all courses."
      />

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { icon: BookOpen,   label: 'Courses',       value: String(enrollments.length) },
          { icon: TrendingUp, label: 'Average Score', value: averageScore != null ? `${averageScore}%` : '—' },
          { icon: Award,      label: 'Total Credits',  value: totalCredits ? String(totalCredits) : '—' },
        ].map(({ icon: Icon, label, value }) => (
          <div key={label} className="rounded-xl border border-border bg-card px-5 py-4 flex items-start gap-4">
            <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 bg-muted">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-medium">{label}</p>
              <p className="text-3xl font-semibold tabular-nums tracking-tight mt-0.5">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="font-semibold text-xs">Course</TableHead>
              <TableHead className="font-semibold text-xs">Section</TableHead>
              <TableHead className="font-semibold text-xs">Semester</TableHead>
              <TableHead className="font-semibold text-xs">Instructor</TableHead>
              <TableHead className="font-semibold text-xs text-center">Grade</TableHead>
              <TableHead className="font-semibold text-xs text-center">Score</TableHead>
              <TableHead className="font-semibold text-xs text-center">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {enrollments.map((enrollment) => {
              const section = resolveJoin(enrollment.section)
              const course = resolveJoin(section?.course)
              const professor = resolveJoin(section?.professor)
              const gradeText = enrollment.final_grade
                ? (GRADE_TEXT[enrollment.final_grade] || 'text-muted-foreground')
                : ''
              const statusStyle = STATUS_STYLES[enrollment.status] || STATUS_STYLES.enrolled

              return (
                <TableRow key={enrollment.id} className="hover:bg-muted/30">
                  <TableCell>
                    <p className="text-[10px] font-mono text-muted-foreground mb-0.5">{course?.code}</p>
                    <p className="text-sm font-medium">{course?.title}</p>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                      {section?.section_code}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground capitalize">
                    {section?.semester} {section?.year}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {professor?.name || '—'}
                  </TableCell>
                  <TableCell className="text-center">
                    {enrollment.final_grade ? (
                      <span className={cn('text-sm font-bold', gradeText)}>
                        {enrollment.final_grade}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {enrollment.final_score != null ? (
                      <span className={cn('text-sm font-medium tabular-nums', scoreColorClass(enrollment.final_score))}>
                        {enrollment.final_score}%
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <div className={cn('inline-flex items-center gap-1.5 text-xs font-medium', statusStyle.text)}>
                      <div className={cn('h-1.5 w-1.5 rounded-full', statusStyle.dot)} />
                      {statusStyle.label}
                    </div>
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
