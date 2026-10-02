/**
 * Lifecycle operations for the professor: create, publish, install, approve and
 * activate, roll back, archive. The actor is always the signed-in professor of the
 * section the request names (rule 8.1). Project-level operations also require that
 * they own the project, because sharing projects is deferred.
 *
 * Integrity and atomicity live in the database (studio_install_plugin,
 * studio_activate_version, and the publish trigger). This module adds what the
 * database can't know: who the session user is, ownership, manifest validation, and
 * whether Studio may take new work (access.ts). Then it turns database refusals into
 * plain language.
 *
 * Creating, publishing, installing, upgrading and rolling back are new work: refused
 * while the kill switch is engaged or the school lacks the Studio entitlement. Archiving
 * only reduces what anyone can reach, so it is always allowed.
 *
 * Plain server module, not 'use server'. Callers are future server actions.
 */
import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { logEvent } from '@/lib/supabase/event-logger'
import { STUDIO_PAUSED, studioAccess } from './access'
import { requireProfessor, type StudioProfessor } from './context'
import * as db from './db'
import { STUDIO_BUNDLE_MAX_BYTES, STUDIO_SOURCE_FILE_MAX_BYTES, STUDIO_SOURCE_MAX_BYTES, STUDIO_SOURCE_MAX_FILES } from './limits'
import { parseManifest, type StudioManifest } from './manifest'
import { runDraftChecks } from './builder/checks'
import { runWorkerCheck } from './builder/check-worker'
import { COMPILER_ID } from './builder/compile'
import type { PluginPath } from './builder/paths'
import { snapshotHash } from './builder/snapshot'
import { skillBindingIssues } from './skill-bindings'
import { artifactHash, canonicalJson } from './validator/artifact'
import { currentVerdict, validateAfterPublish } from './validator/service'

export const LIFECYCLE_NOT_AVAILABLE = 'This isn’t available.'

export type LifecycleResult<T> = { ok: true; value: T } | { ok: false; error: string; issues?: string[] }

const denied = (): { ok: false; error: string } => ({ ok: false, error: LIFECYCLE_NOT_AVAILABLE })

// Database refusals a professor can act on, matched on the trigger's message.
const EXPLANATIONS: [RegExp, string][] = [
  [/must be higher than the last published version/, 'Use a version number higher than the last one you published.'],
  [/breaking collection changes/, 'This version changes or removes a collection the last one had. That isn’t supported yet: keep existing collections as they are and add new ones instead.'],
  [/manifest id must equal the project slug/, 'This version’s manifest belongs to a different plugin.'],
  [/archived and can't publish|needs an active project/, 'This plugin is archived.'],
  [/is not active/, 'This plugin has been removed from the course.'],
  [/changed while it was being checked/, 'This tool changed while it was being checked. Try again.'],
]

function explain(error: db.DbError): string {
  if (error.duplicate === 'project') return 'You already have a plugin with that name.'
  if (error.duplicate === 'installation') return 'This plugin is already installed in this course.'
  if (error.duplicate === 'snapshot_saved') return 'This draft is already saved as a version.'
  for (const [pattern, message] of EXPLANATIONS) if (pattern.test(error.message)) return message
  // A missing or unapproved version, or one from another project.
  if (error.code === '23503') return 'That version can’t be used here.'
  return 'Something went wrong. Try again.'
}

function audit(professor: StudioProfessor, eventType: string, metadata: Record<string, string>) {
  logEvent({ userId: professor.userId, eventType, eventCategory: 'studio', sectionId: professor.sectionId, metadata })
}

/** Why this professor's school can't take new Studio work right now, or null if it can. */
async function newWorkRefused(professor: StudioProfessor): Promise<{ ok: false; error: string } | null> {
  const access = await studioAccess(professor.institutionId)
  if (access === 'off') return { ok: false, error: STUDIO_PAUSED }
  if (access === 'read_only') return { ok: false, error: entitlementRefusalMessage('studio') }
  return null
}

/** The project, only if the professor owns it and it's in their institution. */
async function ownedProject(professor: StudioProfessor, projectId: string) {
  const project = await db.loadProject(projectId)
  return project && project.ownerId === professor.userId && project.institutionId === professor.institutionId
    ? project
    : null
}

/** The installation, only if it's in the professor's section. */
async function sectionInstallation(professor: StudioProfessor, installationId: string) {
  const installation = await db.loadInstallation(installationId)
  return installation && installation.sectionId === professor.sectionId ? installation : null
}

const slug = z.string().max(40).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)

const createProjectInput = z.strictObject({ sectionId: z.uuid(), slug, name: z.string().trim().min(1).max(80) })
export async function createProject(input: z.input<typeof createProjectInput>): Promise<LifecycleResult<string>> {
  const parsed = createProjectInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Check the plugin name.', issues: parsed.error.issues.map((i) => i.message) }
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const refused = await newWorkRefused(professor)
  if (refused) return refused

  const created = await db.insertProject({
    institutionId: professor.institutionId,
    ownerId: professor.userId,
    slug: parsed.data.slug,
    name: parsed.data.name,
  })
  if (!created.ok) return { ok: false, error: explain(created.error) }
  audit(professor, 'studio.project.created', { projectId: created.value })
  return { ok: true, value: created.value }
}

const bytes = (s: string) => new TextEncoder().encode(s).length
const bundle = z.string().min(1).refine((b) => bytes(b) <= STUDIO_BUNDLE_MAX_BYTES, 'Bundle is larger than Studio allows')

const publishInput = z.strictObject({
  sectionId: z.uuid(),
  projectId: z.uuid(),
  manifest: z.unknown(),
  // Rule 10.1: the size limits apply before anything is stored.
  source: z
    .record(z.string().max(200), z.string().refine((f) => bytes(f) <= STUDIO_SOURCE_FILE_MAX_BYTES, 'A source file is too large'))
    .refine((src) => Object.keys(src).length <= STUDIO_SOURCE_MAX_FILES, 'Too many source files')
    .refine((src) => Object.values(src).reduce((n, f) => n + bytes(f), 0) <= STUDIO_SOURCE_MAX_BYTES, 'Source is larger than Studio allows'),
  studentBundle: bundle,
  professorBundle: bundle,
})
export async function publishVersion(input: z.input<typeof publishInput>): Promise<LifecycleResult<string>> {
  const parsed = publishInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const project = await ownedProject(professor, parsed.data.projectId)
  if (!project) return denied()
  const refused = await newWorkRefused(professor)
  if (refused) return refused

  const manifest = parseManifest(parsed.data.manifest)
  if (!manifest.ok) return { ok: false, error: 'This plugin’s manifest isn’t valid.', issues: manifest.issues }

  return insertAndValidate(professor, project, manifest.manifest, parsed.data.source, parsed.data.studentBundle, parsed.data.professorBundle, null)
}

/** The one publish path: insert the immutable version (the database runs its publish
 * checks), audit, then Stage 1 of the pre-publish validator. */
async function insertAndValidate(
  professor: StudioProfessor,
  project: { id: string; institutionId: string },
  manifest: StudioManifest,
  source: Record<string, string>,
  studentBundle: string,
  professorBundle: string,
  sourceSnapshotHash: string | null,
): Promise<LifecycleResult<string>> {
  const published = await db.insertVersion({
    // The verdict binds to exactly this content (validator/artifact.ts).
    artifactSha256: artifactHash({ manifest, source, studentBundle, professorBundle }),
    projectId: project.id,
    institutionId: project.institutionId,
    version: manifest.version,
    manifest,
    bridgeVersion: manifest.bridgeVersion,
    source,
    studentBundle,
    professorBundle,
    bundleSha256: createHash('sha256').update(studentBundle).update('\0').update(professorBundle).digest('hex'),
    publishedBy: professor.userId,
    sourceSnapshotHash,
  })
  if (!published.ok) return { ok: false, error: explain(published.error) }
  audit(professor, 'studio.version.published', { projectId: project.id, versionId: published.value })
  // Stage 1 of the pre-publish validator, right away: it reads the code, never runs it.
  await validateAfterPublish(published.value, professor.userId)
  return { ok: true, value: published.value }
}

/** The next version number: a minor bump of the newest published one, or 1.0.0. */
export function nextVersion(latest: string | null): string {
  if (!latest) return '1.0.0'
  const [major, minor] = latest.split('.').map(Number)
  return `${major}.${minor + 1}.0`
}

const publishDraftInput = z.strictObject({
  sectionId: z.uuid(),
  projectId: z.uuid(),
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
})
/**
 * Save the builder's current draft as a new immutable version (the professor's "Save as
 * version"). Human-only: no builder code calls this. The exact snapshot must still be
 * the project's draft, and it is checked again here, under the rules in force now: the
 * trusted compiler rebuilds both bundles and the whole draft gate re-runs. The version
 * is not installed, activated or shown to anyone.
 */
export async function publishDraft(input: z.input<typeof publishDraftInput>): Promise<LifecycleResult<{ versionId: string; version: string }>> {
  const parsed = publishDraftInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const project = await db.loadBuilderProject(parsed.data.projectId)
  if (!project || project.ownerId !== professor.userId || project.institutionId !== professor.institutionId) return denied()
  const refused = await newWorkRefused(professor)
  if (refused) return refused
  if (project.draftHeadHash !== parsed.data.snapshotHash) {
    return { ok: false, error: 'This draft changed since you opened it. Preview the latest draft, then save it.' }
  }
  const already = await db.loadVersionForSnapshot(project.id, parsed.data.snapshotHash)
  if (already) return { ok: false, error: `This draft is already saved as version ${already.version}.` }

  const snapshot = await db.loadSnapshot(project.id, parsed.data.snapshotHash)
  const stamped = snapshot ? parseManifest(snapshot.manifest) : null
  if (!snapshot || !stamped?.ok || stamped.manifest.manifestVersion !== 2) return denied()
  const files = snapshot.files as Record<PluginPath, string>
  if (snapshot.compiler !== COMPILER_ID || snapshotHash(snapshot.compiler, stamped.manifest, files) !== snapshot.hash) {
    return { ok: false, error: 'Studio was updated since this draft was built. Ask Athena to rebuild it, then save.' }
  }

  const latest = await db.loadLatestProjectManifest(project.id)
  const published = latest ? parseManifest(latest.manifest) : null
  const gate = await runDraftChecks(
    { manifest: stamped.manifest, files },
    { workerCheck: runWorkerCheck, rosterFullNames: await db.loadOwnerRosterFullNames(professor.userId), published: published?.ok ? published.manifest : null },
  ).catch(() => null)
  if (!gate) return { ok: false, error: 'The checks couldn’t run right now. Try again in a moment.' }
  if (!gate.passed || !gate.bundles) {
    return { ok: false, error: 'This draft doesn’t pass Studio’s checks any more. Ask Athena to fix it, then save.' }
  }

  const version = nextVersion(latest?.version ?? null)
  const manifest = { ...stamped.manifest, version }
  const source = { ...files, 'plugin.manifest.json': canonicalJson(manifest) }
  const saved = await insertAndValidate(professor, project, manifest, source, gate.bundles.student, gate.bundles.professor, snapshot.hash)
  if (!saved.ok) return saved
  audit(professor, 'studio.draft.saved', { projectId: project.id, versionId: saved.value })
  return { ok: true, value: { versionId: saved.value, version } }
}

const installInput = z.strictObject({ sectionId: z.uuid(), versionId: z.uuid() })
/** The professor approves the plugin card as part of installing (rule 8.2). */
export async function installPlugin(input: z.input<typeof installInput>): Promise<LifecycleResult<string>> {
  const parsed = installInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const version = await db.loadVersion(parsed.data.versionId)
  if (!version || !(await ownedProject(professor, version.projectId))) return denied()
  const refused = await newWorkRefused(professor)
  if (refused) return refused

  const installed = await db.installPlugin(professor.sectionId, version.id, professor.userId)
  if (!installed.ok) return { ok: false, error: explain(installed.error) }
  audit(professor, 'studio.plugin.installed', { installationId: installed.value, versionId: version.id })
  return { ok: true, value: installed.value }
}

const activateInput = z.strictObject({ sectionId: z.uuid(), installationId: z.uuid(), versionId: z.uuid() })

async function activate(
  input: z.input<typeof activateInput>,
  approve: boolean,
  eventType: string,
): Promise<LifecycleResult<null>> {
  const parsed = activateInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const installation = await sectionInstallation(professor, parsed.data.installationId)
  if (!installation) return denied()
  const refused = await newWorkRefused(professor)
  if (refused) return refused

  // Students can see this tool, so the version it moves to reaches them at once: it must
  // clear the same gates as showing a tool (validator verdict, skill bindings).
  if (installation.studentVisibility === 'visible') {
    const gate = await visibleActivationGate(installation, parsed.data.versionId)
    if (gate) return gate
  }

  // The database refuses if the tool was shown or hidden since the check above.
  const done = await db.activateVersion(installation.id, parsed.data.versionId, professor.userId, approve, installation.studentVisibility)
  if (!done.ok) return { ok: false, error: explain(done.error) }
  audit(professor, eventType, { installationId: installation.id, versionId: parsed.data.versionId })
  return { ok: true, value: null }
}

/** Why a version can't become active in an installation students can see, or null. */
async function visibleActivationGate(installation: db.InstallationRow, versionId: string): Promise<{ ok: false; error: string } | null> {
  const verdict = await currentVerdict(versionId)
  if (verdict.status !== 'passed') {
    return {
      ok: false,
      error: 'Students can see this tool, so this version has to pass Studio’s automatic checks first. Hide the tool from students to switch versions for preview.',
    }
  }
  const version = await db.loadVersion(versionId)
  const manifest = version ? parseManifest(version.manifest) : null
  if (!manifest?.ok) return { ok: false, error: 'That version can’t be used.' }
  const bindings = await skillBindingIssues(installation, manifest.manifest)
  if (!bindings.ok) return { ok: false, error: 'Link each of this version’s skill slots to a course skill first.' }
  return null
}

/** Upgrade: the professor has seen and approved this version's plugin card (rule 8.2). */
export function approveAndActivateVersion(input: z.input<typeof activateInput>) {
  return activate(input, true, 'studio.version.activated')
}

/** Roll back to a version this installation already approved (rule 8.5). */
export function rollbackVersion(input: z.input<typeof activateInput>) {
  return activate(input, false, 'studio.version.rolled_back')
}

const archiveInstallationInput = z.strictObject({ sectionId: z.uuid(), installationId: z.uuid() })
export async function archiveInstallation(input: z.input<typeof archiveInstallationInput>): Promise<LifecycleResult<null>> {
  const parsed = archiveInstallationInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const installation = await sectionInstallation(professor, parsed.data.installationId)
  if (!installation) return denied()

  const archived = await db.archiveInstallation(installation.id, professor.userId)
  if (!archived.ok) return { ok: false, error: explain(archived.error) }
  if (!archived.value) return denied()
  audit(professor, 'studio.installation.archived', { installationId: installation.id })
  return { ok: true, value: null }
}

const archiveProjectInput = z.strictObject({ sectionId: z.uuid(), projectId: z.uuid() })
export async function archiveProject(input: z.input<typeof archiveProjectInput>): Promise<LifecycleResult<null>> {
  const parsed = archiveProjectInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const project = await ownedProject(professor, parsed.data.projectId)
  if (!project) return denied()

  const archived = await db.archiveProject(project.id)
  if (!archived.ok) return { ok: false, error: explain(archived.error) }
  if (!archived.value) return denied()
  audit(professor, 'studio.project.archived', { projectId: project.id })
  return { ok: true, value: null }
}
