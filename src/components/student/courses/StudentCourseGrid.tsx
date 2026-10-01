'use client'

// Grid of enrolled courses shown on the student "My Courses" page.
// Clean Modern-Clean cards (no side-stripes): course code, title, semester,
// professor, status dot, and grade. Clicking an active card enters the course.

import Link from 'next/link'
import { BookOpen, GraduationCap, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/professor/PageHeader'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'

const resolveJoin = (val: unknown) => (Array.isArray(val) ? val[0] : val)

const STATUS_STYLES: Record<string, { label: string; dot: string; text: string }> = {
  enrolled:  { label: 'Enrolled',  dot: 'bg-success',             text: 'text-foreground' },
  completed: { label: 'Completed', dot: 'bg-muted-foreground/60', text: 'text-muted-foreground' },
  dropped:   { label: 'Dropped',   dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
  withdrawn: { label: 'Withdrawn', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
}

// Grade color tracks the score bands (≥80 success, ≥60 warning, <60 destructive).
const GRADE_COLORS: Record<string, string> = {
  'A+': 'text-success-muted-foreground',
  'A':  'text-success-muted-foreground',
  'A-': 'text-success-muted-foreground',
  'B+': 'text-success-muted-foreground',
  'B':  'text-success-muted-foreground',
  'B-': 'text-muted-foreground',
  'C+': 'text-warning-muted-foreground',
  'C':  'text-warning-muted-foreground',
  'C-': 'text-warning-muted-foreground',
  'D+': 'text-destructive-muted-foreground',
  'D':  'text-destructive-muted-foreground',
  'D-': 'text-destructive-muted-foreground',
  'F':  'text-destructive-muted-foreground',
}

interface Enrollment {
  id: string
  status: string
  final_grade?: string | null
  final_score?: number | null
  section?: unknown
}

interface StudentCourseGridProps {
  studentName: string
  enrollments: Enrollment[]
}

export function StudentCourseGrid({ studentName, enrollments }: StudentCourseGridProps) {
  const sorted = [...enrollments].sort((a, b) => {
    const order: Record<string, number> = { enrolled: 0, completed: 1, dropped: 2, withdrawn: 3 }
    return (order[a.status] ?? 4) - (order[b.status] ?? 4)
  })

  const activeCount = enrollments.filter((e) => e.status === 'enrolled').length

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <PageHeader
        title="My Courses"
        description={
          activeCount > 0
            ? `Welcome back, ${studentName}. You have ${activeCount} active ${activeCount === 1 ? 'enrollment' : 'enrollments'}.`
            : `Welcome back, ${studentName}. Courses appear here once your administrator enrolls you.`
        }
      />

      {sorted.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No courses yet"
          description="You're not enrolled in any courses. Your administrator adds you to courses — contact them if something is missing."
        />
      ) : (
        <AnimatedList className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {sorted.map((enrollment) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const section = resolveJoin(enrollment.section) as any
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const course = resolveJoin(section?.course) as any
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const professor = resolveJoin(section?.profiles) || resolveJoin(section?.professor) as any
            const status = STATUS_STYLES[enrollment.status] || STATUS_STYLES.enrolled
            const isActive = enrollment.status === 'enrolled' || enrollment.status === 'completed'
            const gradeColor = enrollment.final_grade
              ? (GRADE_COLORS[enrollment.final_grade] || 'text-muted-foreground')
              : ''

            const card = (
              <div
                className={cn(
                  'group h-full rounded-xl border border-border bg-card p-5 space-y-3 transition duration-200 ease-out',
                  isActive && 'hover:border-ring/40 hover:shadow-sm',
                  !isActive && 'opacity-55',
                )}
              >
                {/* Status row */}
                <div className="flex items-center justify-between gap-2">
                  <div className={cn('flex items-center gap-1.5 text-xs font-medium', status.text)}>
                    <div className={cn('h-1.5 w-1.5 rounded-full', status.dot)} />
                    {status.label}
                  </div>
                  {enrollment.final_grade && (
                    <span className={cn('text-sm font-bold tabular-nums', gradeColor)}>
                      {enrollment.final_grade}
                      {enrollment.final_score != null && (
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          {enrollment.final_score}%
                        </span>
                      )}
                    </span>
                  )}
                </div>

                {/* Course identity */}
                <div>
                  <p className="text-[10px] font-mono text-muted-foreground tracking-wide mb-0.5">
                    {course?.code}
                  </p>
                  <h3 className="text-sm font-semibold leading-snug line-clamp-2">
                    {course?.title || 'Untitled Course'}
                  </h3>
                </div>

                {/* Meta row */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                    <span className="font-mono">{section?.section_code}</span>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="capitalize">
                      {section?.semester} {section?.year}
                    </span>
                  </div>
                  {isActive && (
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 -translate-x-1 group-hover:translate-x-0 transition duration-200 ease-out" />
                  )}
                </div>

                {/* Professor */}
                {professor?.name && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <GraduationCap className="h-3 w-3 shrink-0" />
                    {professor.name}
                  </div>
                )}
              </div>
            )

            return (
              <AnimatedItem key={enrollment.id}>
                {isActive && section?.id ? (
                  <Link href={`/student/courses/${section.id}`} className="block h-full">
                    {card}
                  </Link>
                ) : (
                  card
                )}
              </AnimatedItem>
            )
          })}
        </AnimatedList>
      )}
    </div>
  )
}
