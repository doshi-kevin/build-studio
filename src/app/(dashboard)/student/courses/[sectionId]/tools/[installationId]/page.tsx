import { notFound } from 'next/navigation'
import { z } from 'zod'
import { resolveViewer } from '@/lib/studio/context'
import { allowedBridgeMethods } from '@/lib/studio/bridge/catalog'
import { issueFrameUrl } from '@/lib/studio/runtime/frame-ticket'
import { StudentToolView } from '@/components/studio/runtime/StudentToolView'

interface StudentToolPageProps {
  params: Promise<{ sectionId: string; installationId: string }>
}

/**
 * Runs one Studio plugin's student view for a student in the section. The section
 * layout checks enrollment too, but layouts and pages render in parallel, so this page
 * decides on its own before anything is read or signed.
 *
 * resolveViewer is the whole decision: session, enrollment (enrolled or completed), the
 * installation shown to students, the release gate, the kill switch. The role and the
 * view come from it, never from the URL. Every refusal is the same 404 (an unknown ID,
 * another section's plugin, a hidden one), so guessing IDs reveals nothing.
 */
export default async function StudentToolPage({ params }: StudentToolPageProps) {
  const { sectionId, installationId } = await params
  if (!z.uuid().safeParse(installationId).success) notFound()

  const viewer = await resolveViewer(installationId)
  if (!viewer || viewer.role !== 'student' || viewer.sectionId !== sectionId) notFound()

  // Signed for the student view only; the frame route serves exactly what's signed.
  const frameUrl = await issueFrameUrl(installationId, 'student')

  return (
    <StudentToolView
      title={viewer.manifest.name}
      installationId={installationId}
      versionId={viewer.versionId}
      readOnly={!viewer.writable}
      frameUrl={frameUrl}
      allowedMethods={allowedBridgeMethods(viewer.manifest, 'student')}
      sectionId={sectionId}
    />
  )
}
