/**
 * New Assignment — full-page template chooser (Assignment Template Studio entry).
 * Reached from the "New assignment" button on the assignments dashboard.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/assignments/new
 */
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { assignmentQueries } from '@/lib/supabase/queries'
import { toAllTemplateHistory } from '@/lib/assignments/studio/template-history'
import { AssignmentStudioEntry } from '@/components/professor/assignments/AssignmentStudioEntry'

interface NewAssignmentPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function NewAssignmentPage({ params }: NewAssignmentPageProps) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const [rows, savedTemplateIds] = user
    ? await Promise.all([
        assignmentQueries.listAuthoredAssignments(supabase, user.id),
        assignmentQueries.listSavedTemplateIds(supabase, user.id),
      ])
    : [[], []]
  // Pass the full authored history: the marketplace's "Your templates" bucket shows all of them.
  const recentTemplates = toAllTemplateHistory(rows, 60)

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Link
          href={`/professor/courses/${sectionId}/assignments`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to assignments
        </Link>
      </div>
      <AssignmentStudioEntry sectionId={sectionId} recentTemplates={recentTemplates} savedTemplateIds={savedTemplateIds} />
    </div>
  )
}
