import { notFound } from 'next/navigation'
import { z } from 'zod'
import { PauseCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { canWriteAsProfessor, verifySectionAccess } from '@/lib/auth/section-access'
import { studioKillSwitchEngaged } from '@/lib/studio/access'
import { candidateVersion, resolveViewer, type ReadOnlyReason } from '@/lib/studio/context'
import { getPublicationPanel } from '@/lib/studio/student-visibility'
import { buildPluginCard, cardAdditions } from '@/lib/studio/plugin-card'
import { allowedBridgeMethods } from '@/lib/studio/bridge/catalog'
import { issueFrameUrl } from '@/lib/studio/runtime/frame-ticket'
import { EmptyState } from '@/components/ui/empty-state'
import { StudioRuntimeView } from '@/components/studio/runtime/StudioRuntimeView'

// Why a professor's tool is read-only. Only ever shown to the section's professor.
const READ_ONLY_NOTICE: Record<ReadOnlyReason, string> = {
  installation_archived: 'This tool was removed from the course. Its saved data stays readable.',
  section_archived: 'This course is archived. Saved data stays readable.',
  not_entitled: 'Your institution’s plan no longer includes Studio. Saved data stays readable. Ask your administrator if you need it back.',
  enrollment_completed: 'You can look through it, but changes won’t be saved.',
}

interface StudioRuntimePageProps {
  params: Promise<{ sectionId: string; installationId: string }>
  searchParams: Promise<{ view?: string | string[]; version?: string | string[] }>
}

/**
 * Runs one installed plugin for the section's professor: their own view, a preview of
 * the student view on sample data (rule 8.3), or a preview of another published version
 * before activating it (`?version=`). Anything else is a 404, which also doesn't confirm
 * that the installation exists. Students use /student/courses/[sectionId]/tools/.
 */
export default async function StudioRuntimePage({ params, searchParams }: StudioRuntimePageProps) {
  const { sectionId, installationId } = await params
  if (!z.uuid().safeParse(installationId).success) notFound()

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) notFound()

  // The section layout checks access too, but layouts and pages render in parallel,
  // so the page gates itself before reading anything.
  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok || !canWriteAsProfessor(access.role)) notFound()

  // The professor is told Studio is paused. Their plugins and data are untouched.
  if (await studioKillSwitchEngaged()) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState
          icon={PauseCircle}
          title="Studio is paused right now"
          description="Scholera has paused Studio tools for a while. Your tools and their data are safe. Try again later."
          action={{ label: 'Back to course', href: `/professor/courses/${sectionId}` }}
        />
      </div>
    )
  }

  const viewer = await resolveViewer(installationId)
  if (!viewer || viewer.sectionId !== sectionId || viewer.role !== 'professor') notFound()

  const query = await searchParams
  let candidate: Awaited<ReturnType<typeof candidateVersion>> = null
  if (query.version !== undefined) {
    const id = z.uuid().safeParse(query.version)
    candidate = id.success ? await candidateVersion(viewer, id.data) : null
    if (!candidate) notFound()
  }

  const view = query.view === 'student' ? 'student' : 'professor'
  // A candidate version always runs on sample data: it isn't active here.
  const preview = view === 'student' || candidate !== null
  const manifest = candidate?.manifest ?? viewer.manifest
  const [frameUrl, panel] = await Promise.all([
    issueFrameUrl(installationId, view, candidate?.versionId),
    getPublicationPanel({ sectionId, installationId }),
  ])
  const publication =
    panel.ok && panel.value.card
      ? {
          status: panel.value.status,
          visibility: panel.value.visibility,
          card: panel.value.card,
          blockers: panel.value.blockers,
          warnings: panel.value.warnings,
          validation: panel.value.validation,
          skillSlots: panel.value.skillSlots,
          sectionSkills: panel.value.sectionSkills,
        }
      : null

  // Previewing another version of an active tool: offer to make it the course's version.
  const versions = panel.ok ? panel.value.versions : []
  const useVersion =
    candidate && viewer.writable && panel.ok && panel.value.status === 'active'
      ? {
          older: versions.findIndex((v) => v.id === candidate.versionId) > versions.findIndex((v) => v.id === viewer.versionId),
          visible: panel.value.visibility === 'visible',
          added: cardAdditions(buildPluginCard(candidate.manifest, null), buildPluginCard(viewer.manifest, null)),
        }
      : undefined

  return (
    <StudioRuntimeView
      title={manifest.name}
      view={view}
      installationId={installationId}
      versionId={candidate?.versionId ?? viewer.versionId}
      readOnly={!viewer.writable}
      frameUrl={frameUrl}
      allowedMethods={allowedBridgeMethods(manifest, view)}
      preview={preview ? manifest : undefined}
      candidate={candidate ? { versionId: candidate.versionId, version: candidate.manifest.version } : undefined}
      publication={publication}
      versions={versions}
      useVersion={useVersion}
      activeVersionId={viewer.versionId}
      readOnlyNotice={viewer.readOnlyReason ? READ_ONLY_NOTICE[viewer.readOnlyReason] : undefined}
      sectionId={sectionId}
    />
  )
}
