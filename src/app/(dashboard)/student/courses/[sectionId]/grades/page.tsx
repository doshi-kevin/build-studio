// Student Per-Course Grades Page — shows the student's final grade card,
// a tabbed category view (Quizzes, Assignments, Projects), and topic insights.
import { createClient } from '@/lib/supabase/server'
import { resolveAllEntitlementsBySection } from '@/lib/entitlements/check'
import { ENTITLED_FEATURE_KEYS, evaluateEntitlement } from '@/lib/entitlements/entitled-features'
import { createAdminClient } from '@/lib/supabase/admin'
import { studentCatalogQueries } from '@/lib/supabase/queries'
import { GraduationCap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/professor/PageHeader'
import { StudentGradeCategories } from '@/components/student/grades/StudentGradeCategories'
import { getStudentQuizScores, getStudentSkillPerformance, getStudentProjectGrades, getStudentAssignmentGrades } from './actions'

interface StudentCourseGradesPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function StudentCourseGradesPage({ params }: StudentCourseGradesPageProps) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const enrollment = await studentCatalogQueries.getStudentEnrollment(adminDb, sectionId, user.id)

  /* Grades is never entitled — a student always sees their grades. But its tabs
     are per-product views, and an unattempted quiz at a school that no longer
     has quizzes is an obligation the student cannot discharge. */
  const gradeEntitlements = await resolveAllEntitlementsBySection(adminDb, sectionId)
  const gradesNow = new Date()
  const unentitledFeatures = ENTITLED_FEATURE_KEYS.filter(
    (key) => !evaluateEntitlement(gradeEntitlements, key, gradesNow).entitled,
  ) as string[]

  // Fetch quiz scores, topic performance, project grades, and assignment grades in parallel
  const [quizResult, topicResult, projectResult, assignmentResult] = await Promise.all([
    getStudentQuizScores(sectionId),
    getStudentSkillPerformance(sectionId),
    getStudentProjectGrades(sectionId),
    getStudentAssignmentGrades(sectionId),
  ])

  const scoreColor = enrollment?.final_score != null
    ? enrollment.final_score >= 80 ? 'text-success-muted-foreground'
      : enrollment.final_score >= 60 ? 'text-warning-muted-foreground'
      : 'text-destructive'
    : ''

  const statusStyles: Record<string, { dot: string; text: string }> = {
    enrolled:  { dot: 'bg-success', text: 'text-success-muted-foreground' },
    completed: { dot: 'bg-muted-foreground/60', text: 'text-muted-foreground' },
    dropped:   { dot: 'bg-muted-foreground/30', text: 'text-muted-foreground' },
    withdrawn: { dot: 'bg-muted-foreground/30', text: 'text-muted-foreground' },
  }
  const statusStyle = enrollment?.status ? (statusStyles[enrollment.status] ?? statusStyles.enrolled) : null

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Grade"
        description="Your grade and score for this course."
      />

      {enrollment?.final_grade || enrollment?.final_score != null ? (
        <div className="rounded-2xl border border-border bg-card p-6 max-w-md">
          <div className="flex items-center gap-8">
            {enrollment.final_grade && (
              <div className="text-center">
                <p className="text-[11px] font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">Grade</p>
                <p className={cn('text-5xl font-semibold tracking-tight tabular-nums', scoreColor)}>
                  {enrollment.final_grade}
                </p>
              </div>
            )}
            <div className="space-y-3 flex-1">
              {enrollment.final_score != null && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-0.5">Score</p>
                  <p className={cn('text-3xl font-semibold tabular-nums tracking-tight', scoreColor)}>{enrollment.final_score}%</p>
                </div>
              )}
              {statusStyle && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Status</p>
                  <div className={cn('inline-flex items-center gap-1.5 text-xs font-medium capitalize', statusStyle.text)}>
                    <div className={cn('h-1.5 w-1.5 rounded-full', statusStyle.dot)} />
                    {enrollment.status}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border bg-muted/10 p-5 max-w-md">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/50 border border-border">
              <GraduationCap className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">Final grade not posted yet</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Your instructor will post the final grade here. Check your quiz and project scores below.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Category tabs: Quizzes, Assignments, Projects */}
      <StudentGradeCategories
        quizScores={quizResult.data ?? []}
        sectionId={sectionId}
        topicData={topicResult.data}
        projectGrades={projectResult.data}
        assignmentGrades={assignmentResult.data ?? []}
        unentitledFeatures={unentitledFeatures}
      />
    </div>
  )
}
