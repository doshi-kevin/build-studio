/**
 * Builds the trusted context every Studio operation runs in, from the signed-in
 * session and the database alone. Nothing a caller sends can set the user, role,
 * institution, section or version: callers pass an installation or section ID, and
 * that ID is a claim this module checks, never a grant.
 *
 * Plain server module, not 'use server', so none of this is a callable endpoint.
 */
import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { canWriteAsProfessor, verifySectionAccess } from '@/lib/auth/section-access'
import { logger } from '@/lib/logger'
import { studioAccess } from './access'
import { loadBuilderProject, loadEnrollmentStatus, loadInstallation, loadSectionState, loadVersion } from './db'
import { parseManifest, type StudioManifest } from './manifest'
import type { InstallationState, ViewerRole } from './policy'
import { isPublishedToStudents } from './publication'

// Module-private brands: outside this file a context can't be built without a cast,
// so a caller can't hand-assemble one from request fields.
declare const viewerBrand: unique symbol
declare const professorBrand: unique symbol
declare const builderActorBrand: unique symbol

export type StudioViewer = Readonly<{
  userId: string
  role: ViewerRole
  installationId: string
  installationState: InstallationState
  sectionId: string
  institutionId: string
  projectId: string
  versionId: string
  manifest: StudioManifest
  /** Whether this viewer may write right now. False when the installation is archived,
   * the section is archived, the school has lost the Studio entitlement, or the viewer
   * is a student whose enrollment is completed. Reads are unaffected. */
  writable: boolean
  /** Why `writable` is false, for the professor's notice; null when writable. Students
   * are shown a generic notice instead. */
  readOnlyReason: ReadOnlyReason | null
}> & { readonly [viewerBrand]: true }

export type ReadOnlyReason = 'installation_archived' | 'section_archived' | 'not_entitled' | 'enrollment_completed'

export type StudioProfessor = Readonly<{
  userId: string
  sectionId: string
  institutionId: string
}> & { readonly [professorBrand]: true }

/** The signed-in user's ID from the session cookie, or null. */
export async function sessionUserId(): Promise<string | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user?.id ?? null
}

/** Who is viewing this installation, in which role, under which version, and whether
 * they may write. Null for every reason a viewer can't have one (no session, unknown
 * installation, not in the section, hidden from students, Studio switched off), so
 * callers can't tell "missing" from "denied". */
export async function resolveViewer(installationId: string): Promise<StudioViewer | null> {
  const userId = await sessionUserId()
  if (!userId) return null

  const installation = await loadInstallation(installationId)
  if (!installation) return null

  const access = await verifySectionAccess(installation.sectionId, userId)
  let role: ViewerRole
  let enrollment: 'enrolled' | 'completed' | null = null
  if (access.ok) {
    role = access.role
  } else {
    // Visibility and the release gate first: they need no query.
    if (!isPublishedToStudents(installation)) return null
    enrollment = await loadEnrollmentStatus(installation.sectionId, userId)
    if (!enrollment) return null
    role = 'student'
  }

  // The kill switch stops every viewer, professors included.
  const studio = await studioAccess(installation.institutionId)
  if (studio === 'off') return null
  const section = await loadSectionState(installation.sectionId)
  if (!section) return null

  const readOnlyReason: ReadOnlyReason | null =
    installation.status !== 'active'
      ? 'installation_archived'
      : section.archived
        ? 'section_archived'
        : studio !== 'full'
          ? 'not_entitled'
          : role === 'student' && enrollment !== 'enrolled'
            ? 'enrollment_completed'
            : null

  // Always the installation's current version. The request never names one.
  const version = await loadVersion(installation.currentVersionId)
  const parsed = version ? parseManifest(version.manifest) : null
  if (!version || !parsed?.ok) {
    logger.error('studio/context.resolveViewer: current version unreadable', null, {
      installationId,
      versionId: installation.currentVersionId,
    })
    return null
  }

  return {
    userId,
    role,
    installationId: installation.id,
    installationState: installation.status,
    sectionId: installation.sectionId,
    institutionId: installation.institutionId,
    projectId: installation.projectId,
    versionId: version.id,
    manifest: parsed.manifest,
    writable: readOnlyReason === null,
    readOnlyReason,
  } as StudioViewer
}

/** Another published version of this installation's project, for the professor to
 * preview before activating it (rule 8.3). Only the section's professor, only a version
 * of the same project in the same institution, and only one whose manifest still parses.
 * Approval isn't needed: a preview runs on sample data and reaches no one else. */
export async function candidateVersion(
  viewer: StudioViewer,
  versionId: string,
): Promise<{ versionId: string; manifest: StudioManifest } | null> {
  if (viewer.role !== 'professor') return null
  const version = await loadVersion(versionId)
  if (!version || version.projectId !== viewer.projectId || version.institutionId !== viewer.institutionId) return null
  const parsed = parseManifest(version.manifest)
  return parsed.ok ? { versionId: version.id, manifest: parsed.manifest } : null
}

/** The section's professor, acting in that section (rule 8.1). Null otherwise. */
export async function requireProfessor(sectionId: string): Promise<StudioProfessor | null> {
  const userId = await sessionUserId()
  if (!userId) return null

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsProfessor(access.role)) return null

  const { data: section } = await access.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section) return null

  return { userId, sectionId, institutionId: section.institution_id } as StudioProfessor
}

/** What a builder slice acts as. It has no session: everything comes from the run row and
 * is re-verified on every model turn. A distinct brand, not assignable to StudioProfessor,
 * so builder code can never be handed to a Step 5 operation (publish, install, show). */
export type StudioBuilderActor = Readonly<{
  ownerId: string
  sectionId: string
  institutionId: string
  projectId: string
}> & { readonly [builderActorBrand]: true }

export type BuilderActorRefusal = 'access_lost' | 'project_archived'

/** The run's owner, still the professor of the run's section, and the project still
 * active and theirs. A professor removed from the section loses the build at its next turn. */
export async function builderActor(run: {
  ownerId: string
  sectionId: string | null
  institutionId: string
  projectId: string
}): Promise<{ ok: true; actor: StudioBuilderActor } | { ok: false; reason: BuilderActorRefusal }> {
  if (!run.sectionId) return { ok: false, reason: 'access_lost' }
  const [access, project, section] = await Promise.all([
    verifySectionAccess(run.sectionId, run.ownerId),
    loadBuilderProject(run.projectId),
    loadSectionState(run.sectionId),
  ])
  if (!access.ok || !canWriteAsProfessor(access.role) || !section || section.institutionId !== run.institutionId) {
    return { ok: false, reason: 'access_lost' }
  }
  if (!project || project.ownerId !== run.ownerId || project.institutionId !== run.institutionId || project.status !== 'active') {
    return { ok: false, reason: 'project_archived' }
  }
  return {
    ok: true,
    actor: { ownerId: run.ownerId, sectionId: run.sectionId, institutionId: run.institutionId, projectId: run.projectId } as StudioBuilderActor,
  }
}
