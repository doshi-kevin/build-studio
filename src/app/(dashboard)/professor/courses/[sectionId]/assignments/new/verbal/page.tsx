/**
 * New Verbal Assessment - the preset chooser shown before a layout is picked (mirrors the
 * notebook flow). Picking a preset creates the assignment and opens the verbal editor. Below the
 * presets, the professor's own past verbal templates are offered for reuse.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/assignments/new/verbal
 */
import { createClient } from '@/lib/supabase/server'
import { assignmentQueries } from '@/lib/supabase/queries'
import { toTemplateHistory } from '@/lib/assignments/studio/template-history'
import { VerbalCompose } from '@/components/professor/assignments/verbal/VerbalCompose'

interface NewVerbalPageProps {
  params: Promise<{ sectionId: string }>
  searchParams: Promise<{ name?: string; module?: string }>
}

export default async function NewVerbalPage({ params, searchParams }: NewVerbalPageProps) {
  const { sectionId } = await params
  const { name, module } = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const rows = user ? await assignmentQueries.listAuthoredAssignments(supabase, user.id) : []
  const templates = toTemplateHistory(rows, 'verbal')
  return (
    <VerbalCompose sectionId={sectionId} name={name} templates={templates} placementModuleId={module} />
  )
}
