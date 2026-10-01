// Professor Grades Page — shows a spreadsheet-style gradebook with
// all enrolled students x all published quizzes, class statistics,
// and a cross-quiz analytics tab with topic performance and at-risk students.
// TAs and graders can view this page too; write gating happens in actions.
import { GraduationCap } from 'lucide-react'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveAllEntitlementsBySection } from '@/lib/entitlements/check'
import { ENTITLED_FEATURE_KEYS, evaluateEntitlement } from '@/lib/entitlements/entitled-features'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/professor/PageHeader'
import { GradebookTable } from '@/components/professor/grades/GradebookTable'
import { getGradebookData, getClassAnalytics, getProjectGradebook, getAssignmentGradebook } from './actions'

interface GradesPageProps {
  params: Promise<{ sectionId: string }>
  searchParams?: Promise<{ tab?: string }>
}

const GRADES_TABS = ['gradebook', 'assignments', 'projects', 'analytics', 'atrisk'] as const
type GradesTab = (typeof GRADES_TABS)[number]

function resolveGradesTab(tab: string | undefined): GradesTab {
  return (GRADES_TABS as readonly string[]).includes(tab ?? '') ? (tab as GradesTab) : 'gradebook'
}

export default async function GradesPage({ params, searchParams }: GradesPageProps) {
  const { sectionId } = await params
  const initialTab = resolveGradesTab((await searchParams)?.tab)
  const [result, analyticsResult, projectResult, assignmentResult] = await Promise.all([
    getGradebookData(sectionId),
    getClassAnalytics(sectionId),
    getProjectGradebook(sectionId),
    getAssignmentGradebook(sectionId),
  ])

  if (result.error || !result.data) {
    return (
      <EmptyState
        icon={GraduationCap}
        title="Unable to load grades"
        description={result.error || 'Something went wrong.'}
      />
    )
  }

  const { data } = result

  if (data.students.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Grades" description="View and manage student grades for this course." />
        <EmptyState
          icon={GraduationCap}
          title="No students enrolled"
          description="Once students enroll in this course, their grades will appear here."
        />
      </div>
    )
  }

  /* Grades itself is never entitled — a school always sees its grades. But three
     of its tabs are views of PRODUCTS, and an empty state reading "publish
     quizzes to see scores here" is nonsense at a school with no quizzes. */
  const entitlements = await resolveAllEntitlementsBySection(createAdminClient(), sectionId)
  const gradesNow = new Date()
  const unentitledFeatures = ENTITLED_FEATURE_KEYS.filter(
    (key) => !evaluateEntitlement(entitlements, key, gradesNow).entitled,
  ) as string[]

  return (
    <div className="space-y-6">
      <PageHeader title="Grades" description="View and manage student grades for this course." />
      <GradebookTable
        data={data}
        sectionId={sectionId}
        analytics={analyticsResult.data ?? null}
        projectGrades={projectResult.data ?? []}
        assignmentGrades={assignmentResult.data ?? null}
        initialTab={initialTab}
        unentitledFeatures={unentitledFeatures}
      />
    </div>
  )
}
