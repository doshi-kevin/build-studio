/**
 * New STEM Problem Set — the subject picker (Maths / Physics / Chemistry / Biology / Blank).
 * Picking a subject creates the assignment seeded with the chosen number of question blocks
 * and opens the Studio. The assignment name chosen on the entry page arrives as `name`. Below
 * the subjects, the professor's own past STEM templates are offered for reuse.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/assignments/new/stem
 */
import { createClient } from '@/lib/supabase/server'
import { assignmentQueries } from '@/lib/supabase/queries'
import { toTemplateHistory } from '@/lib/assignments/studio/template-history'
import { StemCompose } from '@/components/professor/assignments/studio/StemCompose'

interface NewStemPageProps {
  params: Promise<{ sectionId: string }>
  searchParams: Promise<{ name?: string }>
}

export default async function NewStemPage({ params, searchParams }: NewStemPageProps) {
  const { sectionId } = await params
  const { name } = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const rows = user ? await assignmentQueries.listAuthoredAssignments(supabase, user.id) : []
  const templates = toTemplateHistory(rows, 'stem')
  return <StemCompose sectionId={sectionId} name={name} templates={templates} />
}
