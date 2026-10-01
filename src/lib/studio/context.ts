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
import { isEnrolled } from '@/lib/live-classroom/room-auth'
import { logger } from '@/lib/logger'
import { loadInstallation, loadVersion } from './db'
import { parseManifest, type StudioManifest } from './manifest'
import type { InstallationState, ViewerRole } from './policy'
import { isPublishedToStudents } from './publication'

// Module-private brands: outside this file a context can't be built without a cast,
// so a caller can't hand-assemble one from request fields.
declare const viewerBrand: unique symbol
declare const professorBrand: unique symbol

export type StudioViewer = Readonly<{
  userId: string
  role: ViewerRole
  installationId: string
  installationState: InstallationState
  sectionId: string
  institutionId: string
  versionId: string
  manifest: StudioManifest
}> & { readonly [viewerBrand]: true }

export type StudioProfessor = Readonly<{
  userId: string
  sectionId: string
  institutionId: string
}> & { readonly [professorBrand]: true }

async function sessionUserId(): Promise<string | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user?.id ?? null
}

/** Who is viewing this installation, in which role, under which version. Null for
 * every reason a viewer can't have one, so callers can't tell "missing" from "denied". */
export async function resolveViewer(installationId: string): Promise<StudioViewer | null> {
  const userId = await sessionUserId()
  if (!userId) return null

  const installation = await loadInstallation(installationId)
  if (!installation) return null

  const access = await verifySectionAccess(installation.sectionId, userId)
  let role: ViewerRole
  if (access.ok) {
    role = access.role
  } else if (
    (await isEnrolled(access.adminDb, installation.sectionId, userId)) &&
    (await isPublishedToStudents(installation))
  ) {
    role = 'student'
  } else {
    return null
  }

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
    versionId: version.id,
    manifest: parsed.manifest,
  } as StudioViewer
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
