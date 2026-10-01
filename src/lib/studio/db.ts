/**
 * The only module that names the studio_plugin_* tables (a tripwire test enforces it).
 * It runs queries and nothing else: deciding who may see what is context.ts and
 * policy.ts. The admin client is created here and never accepted from a caller, and
 * every record query applies `scopeFilter`, which pins the installation and collection.
 */
import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { STUDIO_PROJECT_VERSIONS_LISTED, STUDIO_SECTION_INSTALLATIONS_LISTED, STUDIO_SKILLS_MAX } from './limits'

const PROJECTS = 'studio_plugin_projects'
const VERSIONS = 'studio_plugin_versions'
const INSTALLATIONS = 'studio_plugin_installations'
const RECORDS = 'studio_plugin_records'
const USAGE = 'studio_plugin_usage'
const LIMITS = 'studio_plugin_limits'
const VALIDATIONS = 'studio_plugin_validations'
const VALIDATION_CHECKS = 'studio_plugin_validation_checks'
const VALIDATION_REVIEWS = 'studio_plugin_validation_reviews'
const VALIDATOR_SETTINGS = 'studio_validator_settings'
const SKILL_BINDINGS = 'studio_plugin_skill_bindings'

/** `duplicate` names which uniqueness rule refused a write, so callers can explain it
 * without knowing constraint names. `full` says which storage allowance refused it: the
 * installation's or the student's own (the usage trigger raises program_limit_exceeded,
 * 54000). */
export type DbError = {
  code: string | null
  message: string
  duplicate?: 'project' | 'installation'
  full?: 'installation' | 'student'
}
export type DbWrite<T> = { ok: true; value: T } | { ok: false; error: DbError }

const DUPLICATES: [string, NonNullable<DbError['duplicate']>][] = [
  ['studio_plugin_projects_institution_id_owner_id_slug_key', 'project'],
  ['uq_studio_installation_active', 'installation'],
]

const QUOTA_REACHED = '54000'

function failed(source: string, error: { code?: string; message: string; hint?: string }): { ok: false; error: DbError } {
  if (error.code === QUOTA_REACHED) {
    // Expected when a plugin fills its storage: not a bug in our code. The usage trigger
    // names the allowance in the hint.
    const full = error.hint === 'student' ? 'student' : 'installation'
    logger.warn(`studio/db.${source}: storage quota reached`, { full })
    return { ok: false, error: { code: QUOTA_REACHED, message: error.message, full } }
  }
  logger.error(`studio/db.${source}`, error)
  const duplicate = error.code === '23505' ? DUPLICATES.find(([name]) => error.message.includes(name))?.[1] : undefined
  return { ok: false, error: { code: error.code ?? null, message: error.message, duplicate } }
}

// ── Lookups ──────────────────────────────────────────────────────────

export interface InstallationRow {
  id: string
  institutionId: string
  sectionId: string
  projectId: string
  status: 'active' | 'archived'
  currentVersionId: string
  studentVisibility: 'hidden' | 'visible'
}

export async function loadInstallation(id: string): Promise<InstallationRow | null> {
  const { data, error } = await createAdminClient()
    .from(INSTALLATIONS)
    .select('id, institution_id, section_id, project_id, status, current_version_id, student_visibility')
    .eq('id', id)
    .maybeSingle()
  if (error) logger.error('studio/db.loadInstallation', error, { id })
  if (!data) return null
  return {
    id: data.id,
    institutionId: data.institution_id,
    sectionId: data.section_id,
    projectId: data.project_id,
    status: data.status,
    currentVersionId: data.current_version_id,
    studentVisibility: data.student_visibility,
  }
}

export interface VersionRow {
  id: string
  projectId: string
  institutionId: string
  version: string
  bridgeVersion: string
  manifest: unknown
  /** Set at publish; null for versions published before artifacts were hashed. */
  artifactSha256?: string | null
  publishedBy?: string
}

export async function loadVersion(id: string): Promise<VersionRow | null> {
  const { data, error } = await createAdminClient()
    .from(VERSIONS)
    .select('id, project_id, institution_id, version, bridge_version, manifest, artifact_sha256, published_by')
    .eq('id', id)
    .maybeSingle()
  if (error) logger.error('studio/db.loadVersion', error, { id })
  if (!data) return null
  return {
    id: data.id,
    projectId: data.project_id,
    institutionId: data.institution_id,
    version: data.version,
    bridgeVersion: data.bridge_version,
    manifest: data.manifest,
    artifactSha256: data.artifact_sha256 ?? null,
    publishedBy: data.published_by,
  }
}

/** A project's published versions, newest first, for the professor's preview picker. */
export async function listProjectVersions(projectId: string): Promise<{ id: string; version: string; publishedAt: string }[]> {
  const { data, error } = await createAdminClient()
    .from(VERSIONS)
    .select('id, version, published_at')
    .eq('project_id', projectId)
    .order('published_at', { ascending: false })
    .limit(STUDIO_PROJECT_VERSIONS_LISTED)
  if (error) {
    logger.error('studio/db.listProjectVersions', error, { projectId })
    return []
  }
  return (data ?? []).map((v) => ({ id: v.id, version: v.version, publishedAt: v.published_at }))
}

/** A project's highest version, for "is a newer one available?". The publish trigger
 * only accepts a version higher than every earlier one, so the newest is the highest. */
export async function loadLatestProjectVersion(projectId: string): Promise<{ id: string; version: string } | null> {
  const { data, error } = await createAdminClient()
    .from(VERSIONS)
    .select('id, version')
    .eq('project_id', projectId)
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) logger.error('studio/db.loadLatestProjectVersion', error, { projectId })
  return data ?? null
}

/** The compiled code for one view of a version, and the plugin's name for the frame title. */
export async function loadVersionBundle(id: string, view: 'student' | 'professor'): Promise<{ code: string; name: string } | null> {
  const column = view === 'student' ? 'student_bundle' : 'professor_bundle'
  const { data, error } = await createAdminClient().from(VERSIONS).select(`${column}, manifest`).eq('id', id).maybeSingle()
  if (error) logger.error('studio/db.loadVersionBundle', error, { id, view })
  // The column is chosen at runtime, so the row is read as a plain record.
  const row = data as Record<string, unknown> | null
  const code = row?.[column]
  if (typeof code !== 'string') return null
  const manifest = row?.manifest as { name?: unknown } | undefined
  return { code, name: typeof manifest?.name === 'string' ? manifest.name : 'Plugin' }
}

/** The course code and title shown to a plugin (context.get). Not a Studio table, but
 * Studio's reads live here. */
export async function loadSectionCourse(sectionId: string): Promise<{ code: string; title: string } | null> {
  const { data, error } = await createAdminClient()
    .from('course_sections')
    .select('courses(code, title)')
    .eq('id', sectionId)
    .maybeSingle()
  if (error) logger.error('studio/db.loadSectionCourse', error, { sectionId })
  // A joined single relation comes back as an object or a one-element array (resolveJoin pattern).
  const raw = (data as { courses?: unknown } | null)?.courses
  const course = (Array.isArray(raw) ? raw[0] : raw) as { code?: unknown; title?: unknown } | undefined
  if (typeof course?.code !== 'string' || typeof course.title !== 'string') return null
  return { code: course.code, title: course.title }
}

/** The section's visible skills, for course.skills: not excluded by the professor and
 * not a suppressed (not yet confirmed) suggestion, the same rule the grade hook uses.
 * IDs are used here only to find each parent's name and never leave this function.
 * A parent that is itself hidden is reported as no parent, so its name can't leak. */
export async function loadSectionSkills(
  sectionId: string,
): Promise<{ name: string; info: string | null; parent: string | null }[] | null> {
  const { data, error } = await createAdminClient()
    .from('skills')
    .select('id, name, info, parent_id')
    .eq('section_id', sectionId)
    .eq('excluded', false)
    .eq('suppressed', false)
    .order('position', { ascending: true })
    .order('name', { ascending: true })
    .range(0, STUDIO_SKILLS_MAX - 1)
  if (error) {
    logger.error('studio/db.loadSectionSkills', error, { sectionId })
    return null
  }
  const rows = (data ?? []) as { id: string; name: string; info: string | null; parent_id: string | null }[]
  const nameOf = new Map(rows.map((r) => [r.id, r.name]))
  return rows.map((r) => ({ name: r.name, info: r.info, parent: (r.parent_id && nameOf.get(r.parent_id)) || null }))
}

/** A section's institution and whether it's archived. Not a Studio table; Studio's
 * reads live here. */
export async function loadSectionState(sectionId: string): Promise<{ institutionId: string; archived: boolean } | null> {
  const { data, error } = await createAdminClient()
    .from('course_sections')
    .select('institution_id, archived_at')
    .eq('id', sectionId)
    .maybeSingle()
  if (error) logger.error('studio/db.loadSectionState', error, { sectionId })
  if (!data) return null
  return { institutionId: data.institution_id, archived: data.archived_at !== null }
}

/** The student's enrollment in the section, if it counts for Studio: `enrolled` or
 * `completed`. Dropped and pending enrollments reach nothing. */
export async function loadEnrollmentStatus(sectionId: string, userId: string): Promise<'enrolled' | 'completed' | null> {
  const { data, error } = await createAdminClient()
    .from('enrollments')
    .select('status')
    .eq('section_id', sectionId)
    .eq('student_id', userId)
    .in('status', ['enrolled', 'completed'])
    .maybeSingle()
  if (error) logger.error('studio/db.loadEnrollmentStatus', error, { sectionId })
  return data?.status === 'enrolled' || data?.status === 'completed' ? data.status : null
}

export interface SectionInstallationRow {
  id: string
  status: 'active' | 'archived'
  studentVisibility: 'hidden' | 'visible'
  currentVersionId: string
  /** The current version's manifest name, or null if it can't be read. */
  name: string | null
}

/** A section's installations in one status, for navigation, history and the
 * publication checks. `onlyVisible` filters in SQL, so hidden installations never leave
 * the database for a student page. */
export async function listSectionInstallations(
  sectionId: string,
  { status, onlyVisible }: { status: 'active' | 'archived'; onlyVisible: boolean },
): Promise<SectionInstallationRow[]> {
  let q = createAdminClient()
    .from(INSTALLATIONS)
    .select('id, status, student_visibility, current_version_id')
    .eq('section_id', sectionId)
    .eq('status', status)
  if (onlyVisible) q = q.eq('student_visibility', 'visible')
  const { data, error } = await q.order('created_at', { ascending: true }).limit(STUDIO_SECTION_INSTALLATIONS_LISTED)
  if (error) {
    logger.error('studio/db.listSectionInstallations', error, { sectionId })
    return []
  }
  const rows = data ?? []
  if (rows.length === 0) return []
  const { data: versions, error: versionsError } = await createAdminClient()
    .from(VERSIONS)
    .select('id, manifest')
    .in('id', rows.map((r) => r.current_version_id))
  if (versionsError) logger.error('studio/db.listSectionInstallations: versions', versionsError, { sectionId })
  const nameOf = new Map(
    (versions ?? []).map((v) => {
      const name = (v.manifest as { name?: unknown } | null)?.name
      return [v.id, typeof name === 'string' ? name : null] as const
    }),
  )
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    studentVisibility: r.student_visibility,
    currentVersionId: r.current_version_id,
    name: nameOf.get(r.current_version_id) ?? null,
  }))
}

export interface ProjectRow {
  id: string
  institutionId: string
  ownerId: string
  slug: string
  status: 'active' | 'archived'
}

export async function loadProject(id: string): Promise<ProjectRow | null> {
  const { data, error } = await createAdminClient()
    .from(PROJECTS)
    .select('id, institution_id, owner_id, slug, status')
    .eq('id', id)
    .maybeSingle()
  if (error) logger.error('studio/db.loadProject', error, { id })
  if (!data) return null
  return { id: data.id, institutionId: data.institution_id, ownerId: data.owner_id, slug: data.slug, status: data.status }
}

// ── Lifecycle writes. Atomicity and integrity live in the database ───

export async function insertProject(row: {
  institutionId: string
  ownerId: string
  slug: string
  name: string
}): Promise<DbWrite<string>> {
  const { data, error } = await createAdminClient()
    .from(PROJECTS)
    .insert({ institution_id: row.institutionId, owner_id: row.ownerId, slug: row.slug, name: row.name })
    .select('id')
    .single()
  return error ? failed('insertProject', error) : { ok: true, value: data.id }
}

export async function insertVersion(row: {
  projectId: string
  institutionId: string
  version: string
  manifest: unknown
  bridgeVersion: string
  source: unknown
  studentBundle: string
  professorBundle: string
  bundleSha256: string
  artifactSha256: string
  publishedBy: string
}): Promise<DbWrite<string>> {
  const { data, error } = await createAdminClient()
    .from(VERSIONS)
    .insert({
      project_id: row.projectId,
      institution_id: row.institutionId,
      version: row.version,
      manifest: row.manifest,
      bridge_version: row.bridgeVersion,
      source: row.source,
      student_bundle: row.studentBundle,
      professor_bundle: row.professorBundle,
      bundle_sha256: row.bundleSha256,
      artifact_sha256: row.artifactSha256,
      published_by: row.publishedBy,
    })
    .select('id')
    .single()
  return error ? failed('insertVersion', error) : { ok: true, value: data.id }
}

export async function installPlugin(sectionId: string, versionId: string, actorId: string): Promise<DbWrite<string>> {
  const { data, error } = await createAdminClient().rpc('studio_install_plugin', {
    p_section_id: sectionId,
    p_version_id: versionId,
    p_actor_id: actorId,
  })
  return error ? failed('installPlugin', error) : { ok: true, value: data as string }
}

/** `expectedVisibility` is what the caller's checks saw. The database refuses
 * (serialization_failure) if it changed before this write. */
export async function activateVersion(
  installationId: string,
  versionId: string,
  actorId: string,
  approve: boolean,
  expectedVisibility: 'hidden' | 'visible',
): Promise<DbWrite<null>> {
  const { error } = await createAdminClient().rpc('studio_activate_version', {
    p_installation_id: installationId,
    p_version_id: versionId,
    p_actor_id: actorId,
    p_approve: approve,
    p_expected_visibility: expectedVisibility,
  })
  return error ? failed('activateVersion', error) : { ok: true, value: null }
}

/** Value is false when there was no active installation to archive. */
export async function archiveInstallation(id: string, actorId: string): Promise<DbWrite<boolean>> {
  const { data, error } = await createAdminClient()
    .from(INSTALLATIONS)
    .update({ status: 'archived', archived_at: new Date().toISOString(), archived_by: actorId })
    .eq('id', id)
    .eq('status', 'active')
    .select('id')
  return error ? failed('archiveInstallation', error) : { ok: true, value: (data ?? []).length > 0 }
}

/** Value is false when nothing changed (it was already in that state). */
/** Showing names the version whose verdict was checked (`expectedVersionId`). The
 * database refuses (serialization_failure) if another version became active since. */
export async function setStudentVisibility(
  installationId: string,
  sectionId: string,
  visibility: 'hidden' | 'visible',
  actorId: string,
  expectedVersionId: string | null = null,
): Promise<DbWrite<boolean>> {
  const { data, error } = await createAdminClient().rpc('studio_set_student_visibility', {
    p_installation_id: installationId,
    p_section_id: sectionId,
    p_visibility: visibility,
    p_actor_id: actorId,
    p_expected_version_id: expectedVersionId,
  })
  return error ? failed('setStudentVisibility', error) : { ok: true, value: data === true }
}

export interface QuotaLimits {
  installationMaxRecords: number
  installationMaxBytes: number
  studentMaxRecords: number
  studentMaxBytes: number
}

/** The storage limits the usage trigger enforces. Null if they can't be read. */
export async function loadQuotaLimits(): Promise<QuotaLimits | null> {
  const { data, error } = await createAdminClient()
    .from(LIMITS)
    .select('installation_max_records, installation_max_bytes, student_max_records, student_max_bytes')
    .eq('id', true)
    .maybeSingle()
  if (error) logger.error('studio/db.loadQuotaLimits', error)
  if (!data) return null
  return {
    installationMaxRecords: Number(data.installation_max_records),
    installationMaxBytes: Number(data.installation_max_bytes),
    studentMaxRecords: Number(data.student_max_records),
    studentMaxBytes: Number(data.student_max_bytes),
  }
}

/** How much of its storage quota an installation uses. */
export async function loadUsage(installationId: string): Promise<{ records: number; bytes: number } | null> {
  const { data, error } = await createAdminClient()
    .from(USAGE)
    .select('record_count, record_bytes')
    .eq('installation_id', installationId)
    .maybeSingle()
  if (error) logger.error('studio/db.loadUsage', error, { installationId })
  if (!data) return null
  return { records: Number(data.record_count), bytes: Number(data.record_bytes) }
}

/** Value is false when there was no active project to archive. */
export async function archiveProject(id: string): Promise<DbWrite<boolean>> {
  const { data, error } = await createAdminClient()
    .from(PROJECTS)
    .update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'active')
    .select('id')
  return error ? failed('archiveProject', error) : { ok: true, value: (data ?? []).length > 0 }
}

// ── Records ──────────────────────────────────────────────────────────

/** Which records a query may touch. `owner: 'any'` is only ever chosen by policy.ts. */
export interface RecordScope {
  installationId: string
  collection: string
  owner: { only: string } | 'any'
}

export interface RecordRow {
  id: string
  ownerId: string | null
  authorId: string
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

const RECORD_COLUMNS = 'id, owner_id, author_id, data, created_at, updated_at'

interface RawRecord {
  id: string
  owner_id: string | null
  author_id: string
  data: Record<string, unknown>
  created_at: string
  updated_at: string
}

const toRecord = (r: RawRecord): RecordRow => ({
  id: r.id,
  ownerId: r.owner_id,
  authorId: r.author_id,
  data: r.data,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

// The one place a record filter is built. Every read, update and delete applies it
// with .match(), plus .is('archived_at', null).
function scopeFilter(scope: RecordScope): Record<string, string> {
  const filter: Record<string, string> = { installation_id: scope.installationId, collection: scope.collection }
  if (scope.owner !== 'any') filter.owner_id = scope.owner.only
  return filter
}

export async function listRecords(scope: RecordScope, page: { limit: number; offset: number }): Promise<RecordRow[] | null> {
  const { data, error } = await createAdminClient()
    .from(RECORDS)
    .select(RECORD_COLUMNS)
    .match(scopeFilter(scope))
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(page.offset, page.offset + page.limit - 1)
  if (error) {
    logger.error('studio/db.listRecords', error, { installationId: scope.installationId })
    return null
  }
  return (data as RawRecord[]).map(toRecord)
}

export async function getRecord(scope: RecordScope, id: string): Promise<RecordRow | null> {
  const { data, error } = await createAdminClient()
    .from(RECORDS)
    .select(RECORD_COLUMNS)
    .eq('id', id)
    .match(scopeFilter(scope))
    .is('archived_at', null)
    .maybeSingle()
  if (error) logger.error('studio/db.getRecord', error, { installationId: scope.installationId })
  return data ? toRecord(data as RawRecord) : null
}

/** Every stamp comes from the trusted context. None of them comes from the request. */
export interface RecordStamps {
  institutionId: string
  sectionId: string
  installationId: string
  versionId: string
  collection: string
  ownerId: string | null
  authorId: string
}

export async function insertRecord(stamps: RecordStamps, data: Record<string, unknown>): Promise<DbWrite<RecordRow>> {
  const { data: row, error } = await createAdminClient()
    .from(RECORDS)
    .insert({
      institution_id: stamps.institutionId,
      section_id: stamps.sectionId,
      installation_id: stamps.installationId,
      version_id: stamps.versionId,
      collection: stamps.collection,
      owner_id: stamps.ownerId,
      author_id: stamps.authorId,
      data,
    })
    .select(RECORD_COLUMNS)
    .single()
  return error ? failed('insertRecord', error) : { ok: true, value: toRecord(row as RawRecord) }
}

/** Value is null when no row matched: missing, outside the scope, or (with
 * expectedUpdatedAt) changed by someone else. */
export async function updateRecord(
  scope: RecordScope,
  id: string,
  change: { data: Record<string, unknown>; versionId: string; expectedUpdatedAt?: string },
): Promise<DbWrite<RecordRow | null>> {
  let q = createAdminClient()
    .from(RECORDS)
    .update({ data: change.data, version_id: change.versionId })
    .eq('id', id)
    .match(scopeFilter(scope))
    .is('archived_at', null)
  if (change.expectedUpdatedAt) q = q.eq('updated_at', change.expectedUpdatedAt)
  const { data, error } = await q.select(RECORD_COLUMNS).maybeSingle()
  if (error) return failed('updateRecord', error)
  return { ok: true, value: data ? toRecord(data as RawRecord) : null }
}

/** Value is false when no row matched the scope. */
export async function deleteRecord(scope: RecordScope, id: string): Promise<DbWrite<boolean>> {
  const { data, error } = await createAdminClient()
    .from(RECORDS)
    .delete()
    .eq('id', id)
    .match(scopeFilter(scope))
    .is('archived_at', null)
    .select('id')
  return error ? failed('deleteRecord', error) : { ok: true, value: (data ?? []).length > 0 }
}

// ── The pre-publish validator ────────────────────────────────────────
// Results are append-only; the database refuses changes to a finished run.

export interface VersionSizes {
  studentBytes: number
  professorBytes: number
  sourceBytes: number
  sourceFiles: number
}

/** Byte sizes only, so an oversized version is refused before its content is loaded. */
export async function loadVersionSizes(id: string): Promise<VersionSizes | null> {
  const { data, error } = await createAdminClient().rpc('studio_version_sizes', { p_version_id: id })
  if (error) logger.error('studio/db.loadVersionSizes', error, { id })
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined
  if (!row) return null
  return {
    studentBytes: Number(row.student_bytes),
    professorBytes: Number(row.professor_bytes),
    sourceBytes: Number(row.source_bytes),
    sourceFiles: Number(row.source_files),
  }
}

export interface VersionArtifactRow {
  id: string
  projectId: string
  institutionId: string
  publishedBy: string
  manifest: unknown
  source: Record<string, unknown>
  studentBundle: string
  professorBundle: string
  artifactSha256: string | null
}

export async function loadVersionArtifact(id: string): Promise<VersionArtifactRow | null> {
  const { data, error } = await createAdminClient()
    .from(VERSIONS)
    .select('id, project_id, institution_id, published_by, manifest, source, student_bundle, professor_bundle, artifact_sha256')
    .eq('id', id)
    .maybeSingle()
  if (error) logger.error('studio/db.loadVersionArtifact', error, { id })
  if (!data) return null
  return {
    id: data.id,
    projectId: data.project_id,
    institutionId: data.institution_id,
    publishedBy: data.published_by,
    manifest: data.manifest,
    source: data.source && typeof data.source === 'object' && !Array.isArray(data.source) ? data.source : {},
    studentBundle: data.student_bundle,
    professorBundle: data.professor_bundle,
    artifactSha256: data.artifact_sha256,
  }
}

/** The minimum accepted ruleset, or null when it can't be read (callers fail closed). */
export async function loadMinAcceptedRuleset(): Promise<number | null> {
  const { data, error } = await createAdminClient().from(VALIDATOR_SETTINGS).select('min_accepted_ruleset').eq('id', true).maybeSingle()
  if (error) logger.error('studio/db.loadMinAcceptedRuleset', error)
  return data ? Number(data.min_accepted_ruleset) : null
}

export interface NewValidation {
  versionId: string
  institutionId: string
  stage: 'static' | 'runtime'
  status: 'pending' | 'running'
  artifactSha256: string
  validatorVersion: string
  rulesetVersion: number
  runtimeVersion: string
  trigger: 'publish' | 'professor' | 'ruleset_change' | 'retry' | 'test'
  requestedBy: string | null
  callbackSha256?: string
}

/** Value is null when an identical run is already active (the unique index refused it). */
export async function insertValidation(row: NewValidation): Promise<DbWrite<string | null>> {
  const { data, error } = await createAdminClient()
    .from(VALIDATIONS)
    .insert({
      version_id: row.versionId,
      institution_id: row.institutionId,
      stage: row.stage,
      status: row.status,
      artifact_sha256: row.artifactSha256,
      validator_version: row.validatorVersion,
      ruleset_version: row.rulesetVersion,
      runtime_version: row.runtimeVersion,
      trigger: row.trigger,
      requested_by: row.requestedBy,
      callback_sha256: row.callbackSha256 ?? null,
      started_at: row.status === 'running' ? new Date().toISOString() : null,
    })
    .select('id')
    .single()
  if (error?.code === '23505') return { ok: true, value: null }
  return error ? failed('insertValidation', error) : { ok: true, value: data.id }
}

export interface ValidationCheckRow {
  checkId: string
  ruleRefs: readonly string[]
  stage: 'static' | 'runtime'
  status: 'passed' | 'failed' | 'warning' | 'needs_review' | 'skipped' | 'error'
  severity: 'security' | 'reliability' | 'policy' | 'quality'
  message: string
  metadata: Record<string, unknown>
}

export async function insertValidationChecks(validationId: string, rows: ValidationCheckRow[]): Promise<DbWrite<null>> {
  if (rows.length === 0) return { ok: true, value: null }
  const { error } = await createAdminClient()
    .from(VALIDATION_CHECKS)
    .insert(
      rows.map((r) => ({
        validation_id: validationId,
        check_id: r.checkId,
        rule_refs: [...r.ruleRefs],
        stage: r.stage,
        status: r.status,
        severity: r.severity,
        message: r.message,
        metadata: r.metadata,
      })),
    )
  return error ? failed('insertValidationChecks', error) : { ok: true, value: null }
}

/** Value is false when the run was no longer open (already finished: a replay). */
export async function finishValidation(
  id: string,
  result: {
    status: 'passed' | 'failed' | 'needs_review' | 'error'
    browser?: string | null
    runner?: string | null
    aiModel?: string | null
    aiRubricVersion?: string | null
    error?: { code: string; message: string } | null
  },
): Promise<DbWrite<boolean>> {
  const { data, error } = await createAdminClient()
    .from(VALIDATIONS)
    .update({
      status: result.status,
      browser: result.browser ?? null,
      runner: result.runner ?? null,
      ai_model: result.aiModel ?? null,
      ai_rubric_version: result.aiRubricVersion ?? null,
      error: result.error ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('status', ['pending', 'running'])
    .select('id')
  return error ? failed('finishValidation', error) : { ok: true, value: (data ?? []).length > 0 }
}

/** pending to running, once. Value is false when it was no longer pending. */
export async function startValidation(id: string): Promise<DbWrite<boolean>> {
  const { data, error } = await createAdminClient()
    .from(VALIDATIONS)
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id')
  return error ? failed('startValidation', error) : { ok: true, value: (data ?? []).length > 0 }
}

export interface ValidationRunRow {
  id: string
  versionId: string
  institutionId: string
  stage: 'static' | 'runtime'
  status: 'pending' | 'running' | 'passed' | 'failed' | 'needs_review' | 'error'
  artifactSha256: string
  rulesetVersion: number
  callbackSha256: string | null
  startedAt: string | null
  createdAt: string
}

const RUN_COLUMNS = 'id, version_id, institution_id, stage, status, artifact_sha256, ruleset_version, callback_sha256, started_at, created_at'

const toRun = (r: Record<string, unknown>): ValidationRunRow => ({
  id: r.id as string,
  versionId: r.version_id as string,
  institutionId: r.institution_id as string,
  stage: r.stage as ValidationRunRow['stage'],
  status: r.status as ValidationRunRow['status'],
  artifactSha256: r.artifact_sha256 as string,
  rulesetVersion: Number(r.ruleset_version),
  callbackSha256: (r.callback_sha256 as string | null) ?? null,
  startedAt: (r.started_at as string | null) ?? null,
  createdAt: r.created_at as string,
})

/** A version's most recent runs, newest first. Bounded. */
export async function listValidations(versionId: string): Promise<ValidationRunRow[] | null> {
  const { data, error } = await createAdminClient()
    .from(VALIDATIONS)
    .select(RUN_COLUMNS)
    .eq('version_id', versionId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) {
    logger.error('studio/db.listValidations', error, { versionId })
    return null
  }
  return (data ?? []).map(toRun)
}

export async function loadValidation(id: string): Promise<ValidationRunRow | null> {
  const { data, error } = await createAdminClient().from(VALIDATIONS).select(RUN_COLUMNS).eq('id', id).maybeSingle()
  if (error) logger.error('studio/db.loadValidation', error, { id })
  return data ? toRun(data) : null
}

export interface StoredCheck {
  validationId: string
  checkId: string
  status: ValidationCheckRow['status']
  severity: ValidationCheckRow['severity']
  message: string
}

export async function listValidationChecks(validationIds: string[]): Promise<StoredCheck[] | null> {
  if (validationIds.length === 0) return []
  const { data, error } = await createAdminClient()
    .from(VALIDATION_CHECKS)
    .select('validation_id, check_id, status, severity, message')
    .in('validation_id', validationIds)
  if (error) {
    logger.error('studio/db.listValidationChecks', error)
    return null
  }
  return (data ?? []).map((r) => ({ validationId: r.validation_id, checkId: r.check_id, status: r.status, severity: r.severity, message: r.message }))
}

export async function listValidationReviews(validationIds: string[]): Promise<{ validationId: string; checkId: string; decision: 'approved' | 'rejected' }[] | null> {
  if (validationIds.length === 0) return []
  const { data, error } = await createAdminClient()
    .from(VALIDATION_REVIEWS)
    .select('validation_id, check_id, decision')
    .in('validation_id', validationIds)
  if (error) {
    logger.error('studio/db.listValidationReviews', error)
    return null
  }
  return (data ?? []).map((r) => ({ validationId: r.validation_id, checkId: r.check_id, decision: r.decision }))
}

export async function insertValidationReview(row: {
  validationId: string
  checkId: string
  decision: 'approved' | 'rejected'
  reviewerId: string
  reason: string
}): Promise<DbWrite<null>> {
  const { error } = await createAdminClient().from(VALIDATION_REVIEWS).insert({
    validation_id: row.validationId,
    check_id: row.checkId,
    decision: row.decision,
    reviewer_id: row.reviewerId,
    reason: row.reason,
  })
  return error ? failed('insertValidationReview', error) : { ok: true, value: null }
}

/** Current versions of active installations, for re-checking after a ruleset change. */
/** One page of active installations' current versions, oldest installation first.
 * `installations` is how many installation rows the page covered, for the next offset. */
export async function listActiveCurrentVersions(
  limit: number,
  offset = 0,
): Promise<{ versions: { versionId: string; institutionId: string }[]; installations: number }> {
  const { data, error } = await createAdminClient()
    .from(INSTALLATIONS)
    .select('current_version_id, institution_id')
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) {
    logger.error('studio/db.listActiveCurrentVersions', error)
    return { versions: [], installations: 0 }
  }
  const seen = new Set<string>()
  const versions = (data ?? [])
    .filter((r) => !seen.has(r.current_version_id) && seen.add(r.current_version_id))
    .map((r) => ({ versionId: r.current_version_id, institutionId: r.institution_id }))
  return { versions, installations: (data ?? []).length }
}

// ── Skill slot bindings ──────────────────────────────────────────────

export async function listSkillBindings(installationId: string): Promise<{ slotKey: string; skillId: string }[] | null> {
  const { data, error } = await createAdminClient()
    .from(SKILL_BINDINGS)
    .select('slot_key, skill_id')
    .eq('installation_id', installationId)
  if (error) {
    logger.error('studio/db.listSkillBindings', error, { installationId })
    return null
  }
  return (data ?? []).map((r) => ({ slotKey: r.slot_key, skillId: r.skill_id }))
}

/** A section's visible skills (not excluded, not suppressed), with IDs, for binding.
 * The professor's page only: plugin frames never receive skill IDs. */
export async function listBindableSkills(sectionId: string): Promise<{ id: string; name: string }[] | null> {
  const { data, error } = await createAdminClient()
    .from('skills')
    .select('id, name')
    .eq('section_id', sectionId)
    .eq('excluded', false)
    .eq('suppressed', false)
    .order('position', { ascending: true })
    .order('name', { ascending: true })
    .range(0, STUDIO_SKILLS_MAX - 1)
  if (error) {
    logger.error('studio/db.listBindableSkills', error, { sectionId })
    return null
  }
  return (data ?? []).map((r) => ({ id: r.id, name: r.name }))
}

export async function upsertSkillBinding(row: {
  installationId: string
  slotKey: string
  skillId: string
  institutionId: string
  boundBy: string
}): Promise<DbWrite<null>> {
  const { error } = await createAdminClient()
    .from(SKILL_BINDINGS)
    .upsert(
      {
        installation_id: row.installationId,
        slot_key: row.slotKey,
        skill_id: row.skillId,
        institution_id: row.institutionId,
        bound_by: row.boundBy,
        bound_at: new Date().toISOString(),
      },
      { onConflict: 'installation_id,slot_key' },
    )
  return error ? failed('upsertSkillBinding', error) : { ok: true, value: null }
}
