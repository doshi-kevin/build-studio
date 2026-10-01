/**
 * Verbal Assessment authoring page. Loads the cell-based config from
 * settings.verbalAssessment and signs any cached question audio for playback.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/assignments/[assignmentId]/verbal
 */
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { signOne } from '@/lib/supabase/signed-urls'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { verbalAssessmentSchema } from '@/lib/validations/verbal-assessment'
import { defaultVerbalAssessment } from '@/lib/assignments/verbal/config'
import { VerbalStudio } from '@/components/professor/assignments/verbal/VerbalStudio'

interface VerbalPageProps {
  params: Promise<{ sectionId: string; assignmentId: string }>
}

export default async function VerbalAssessmentPage({ params }: VerbalPageProps) {
  const { sectionId, assignmentId } = await params
  const supabase = await createClient()

  // RLS scopes the read to the professor's section.
  const { data } = await supabase
    .from('assignments')
    .select('id, title, section_id, settings, due_at')
    .eq('id', assignmentId)
    .maybeSingle()

  if (!data || data.section_id !== sectionId) notFound()

  const settings = (data.settings ?? {}) as Record<string, unknown>
  const parsed = verbalAssessmentSchema.safeParse(settings.verbalAssessment)
  const config = parsed.success ? parsed.data : defaultVerbalAssessment()

  // Sign cached question audio for in-editor playback.
  const entries = await Promise.all(
    config.cells.map(async (c) => [c.id, c.audioPath ? await signOne(COURSE_MATERIALS_BUCKET, c.audioPath) : null] as const),
  )
  const audioUrls: Record<string, string | null> = Object.fromEntries(entries)

  return (
    <VerbalStudio
      sectionId={sectionId}
      assignmentId={assignmentId}
      title={data.title}
      initialConfig={config}
      initialAudioUrls={audioUrls}
      initialDueAt={data.due_at}
    />
  )
}
