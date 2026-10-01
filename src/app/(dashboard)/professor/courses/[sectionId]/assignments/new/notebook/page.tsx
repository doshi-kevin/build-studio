/**
 * New Notebook — the notebook layout picker (Blank, preset layouts, or .ipynb upload).
 * Picking one creates the assignment and opens the Studio seeded with that layout. The
 * assignment name chosen on the entry page arrives as the `name` search param. Below the
 * layouts, the professor's own past notebook templates are offered for reuse.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/assignments/new/notebook
 */
import { createClient } from '@/lib/supabase/server'
import { assignmentQueries } from '@/lib/supabase/queries'
import { toTemplateHistory } from '@/lib/assignments/studio/template-history'
import { NotebookCompose } from '@/components/professor/assignments/studio/NotebookCompose'

interface NewNotebookPageProps {
  params: Promise<{ sectionId: string }>
  searchParams: Promise<{ name?: string; module?: string }>
}

export default async function NewNotebookPage({ params, searchParams }: NewNotebookPageProps) {
  const { sectionId } = await params
  const { name, module } = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const rows = user ? await assignmentQueries.listAuthoredAssignments(supabase, user.id) : []
  const templates = toTemplateHistory(rows, 'notebook')
  return (
    <NotebookCompose sectionId={sectionId} name={name} templates={templates} placementModuleId={module} />
  )
}
