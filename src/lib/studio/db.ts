/**
 * The only module that names the studio_plugin_* tables (a tripwire test enforces it).
 * It runs queries and nothing else: deciding who may see what is context.ts and
 * policy.ts. The admin client is created here and never accepted from a caller, and
 * every record query applies `scopeFilter`, which pins the installation and collection.
 */
import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import type { CourseUnitRow, MaterialSourceEntry } from './builder/course-material'
import type { MemoryKind, MemorySlot, MemoryTopic } from './builder/memory'
import { STUDIO_COURSE_TIMEOUT_MS, STUDIO_MEMORY_MAX_ACTIVE, STUDIO_PROJECT_VERSIONS_LISTED, STUDIO_SECTION_INSTALLATIONS_LISTED, STUDIO_SKILLS_MAX } from './limits'

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
const SNAPSHOTS = 'studio_plugin_snapshots'
const RUNS = 'studio_plugin_builder_runs'
const STEPS = 'studio_plugin_builder_steps'
const MEMORIES = 'studio_plugin_memories'

/** `duplicate` names which uniqueness rule refused a write, so callers can explain it
 * without knowing constraint names. `full` says which storage allowance refused it: the
 * installation's or the student's own (the usage trigger raises program_limit_exceeded,
 * 54000). */
export type DbError = {
  code: string | null
  message: string
  duplicate?: 'project' | 'installation' | 'snapshot_saved'
  full?: 'installation' | 'student'
}
export type DbWrite<T> = { ok: true; value: T } | { ok: false; error: DbError }

const DUPLICATES: [string, NonNullable<DbError['duplicate']>][] = [
  ['studio_plugin_projects_institution_id_owner_id_slug_key', 'project'],
  ['uq_studio_installation_active', 'installation'],
  ['uq_studio_versions_source_snapshot', 'snapshot_saved'],
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
  // Code and message only. A CHECK violation's `details` is the whole failing row, which
  // for Studio tables can be a professor's request, plugin source or record content.
  logger.error(`studio/db.${source}`, { code: error.code, message: error.message })
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
  /** The draft snapshot this version was saved from, when it came from the builder. */
  sourceSnapshotHash?: string | null
  /** Course sources the project's builds read (keys and build section only), copied at Save. */
  materialSources?: MaterialSourceEntry[]
  /** The project dropped unopened sources for its cap: the release review says its list is incomplete. */
  materialIncomplete?: boolean
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
      source_snapshot_hash: row.sourceSnapshotHash ?? null,
      material_sources: row.materialSources ?? [],
      material_incomplete: row.materialIncomplete ?? false,
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

// ── The builder: snapshots, runs and their trajectory ───────────────
// Every write is one security definer function (supabase/migrations/
// 20261002160000_studio_builder.sql). The functions re-check the claim token, the run's
// status, Stop, the working copy's revision and the caps under the run's row lock, so
// nothing here decides; it calls and reports.

export type BuilderRunStatus =
  | 'queued' | 'running' | 'waiting_for_approval' | 'waiting_for_professor'
  | 'preview_ready' | 'completed' | 'blocked' | 'cancelled' | 'budget_exhausted' | 'failed'

export interface BuilderRunRow {
  id: string
  projectId: string
  institutionId: string
  ownerId: string
  sectionId: string | null
  request: string | null
  status: BuilderRunStatus
  phase: string | null
  errorCode: string | null
  plan: Record<string, unknown> | null
  work: Record<string, unknown> | null
  pendingApproval: Record<string, unknown> | null
  questions: { id: string; question: string; answer: string | null; askedAt: string }[]
  waitingUntil: string | null
  result: Record<string, unknown> | null
  baseHash: string | null
  baseRev: number
  resultHash: string | null
  counters: {
    modelTurns: number
    toolCalls: number
    writes: number
    bytesWritten: number
    repairRounds: number
    checkRuns: number
    consecutiveErrors: number
    inputTokens: number
    cachedTokens: number
    outputTokens: number
    costUsd: number
    activeMs: number
  }
  sliceNo: number
  resumeCount: number
  cancelRequested: boolean
  createdAt: string
  endedAt: string | null
}

const RUN_FIELDS =
  'id, project_id, institution_id, owner_id, section_id, request, status, phase, error_code, plan, work, pending_approval, questions, waiting_until, result, base_hash, base_rev, result_hash, model_turns, tool_calls, writes, bytes_written, repair_rounds, check_runs, consecutive_errors, input_tokens, cached_tokens, output_tokens, cost_usd, active_ms, slice_no, resume_count, cancel_requested_at, created_at, ended_at'

const safeError = (error: { code?: string; message: string }) => ({ code: error.code, message: error.message })

function toRunRow(r: Record<string, unknown>): BuilderRunRow {
  const n = (k: string) => Number(r[k] ?? 0)
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    institutionId: r.institution_id as string,
    ownerId: r.owner_id as string,
    sectionId: (r.section_id as string | null) ?? null,
    request: (r.request as string | null) ?? null,
    status: r.status as BuilderRunStatus,
    phase: (r.phase as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    plan: (r.plan as Record<string, unknown> | null) ?? null,
    work: (r.work as Record<string, unknown> | null) ?? null,
    pendingApproval: (r.pending_approval as Record<string, unknown> | null) ?? null,
    questions: Array.isArray(r.questions) ? (r.questions as BuilderRunRow['questions']) : [],
    waitingUntil: (r.waiting_until as string | null) ?? null,
    result: (r.result as Record<string, unknown> | null) ?? null,
    baseHash: (r.base_hash as string | null) ?? null,
    baseRev: n('base_rev'),
    resultHash: (r.result_hash as string | null) ?? null,
    counters: {
      modelTurns: n('model_turns'),
      toolCalls: n('tool_calls'),
      writes: n('writes'),
      bytesWritten: n('bytes_written'),
      repairRounds: n('repair_rounds'),
      checkRuns: n('check_runs'),
      consecutiveErrors: n('consecutive_errors'),
      inputTokens: n('input_tokens'),
      cachedTokens: n('cached_tokens'),
      outputTokens: n('output_tokens'),
      costUsd: n('cost_usd'),
      activeMs: n('active_ms'),
    },
    sliceNo: n('slice_no'),
    resumeCount: n('resume_count'),
    cancelRequested: r.cancel_requested_at !== null && r.cancel_requested_at !== undefined,
    createdAt: r.created_at as string,
    endedAt: (r.ended_at as string | null) ?? null,
  }
}

export async function loadBuilderRun(id: string): Promise<BuilderRunRow | null> {
  const { data, error } = await createAdminClient().from(RUNS).select(RUN_FIELDS).eq('id', id).maybeSingle()
  if (error) logger.error('studio/db.loadBuilderRun', safeError(error), { id })
  return data ? toRunRow(data as Record<string, unknown>) : null
}

export interface BuilderStepRow {
  seq: number
  kind: 'model_turn' | 'tool' | 'check' | 'approval' | 'answer' | 'system'
  tool: string | null
  toolCallId: string
  status: 'done' | 'refused' | 'error' | 'interrupted'
  label: string
  argsSummary: Record<string, unknown>
  resultSummary: Record<string, unknown>
  ms: number
}

/** A run's steps after `afterSeq`, in order. Bounded. */
export async function listBuilderSteps(runId: string, afterSeq = 0, limit = 200): Promise<BuilderStepRow[] | null> {
  const { data, error } = await createAdminClient()
    .from(STEPS)
    .select('seq, kind, tool, tool_call_id, status, label, args_summary, result_summary, ms')
    .eq('run_id', runId)
    .gt('seq', afterSeq)
    .order('seq', { ascending: true })
    .limit(limit)
  if (error) {
    logger.error('studio/db.listBuilderSteps', safeError(error), { runId })
    return null
  }
  return (data ?? []).map((r) => ({
    seq: Number(r.seq),
    kind: r.kind,
    tool: r.tool,
    toolCallId: r.tool_call_id,
    status: r.status,
    label: r.label,
    argsSummary: r.args_summary ?? {},
    resultSummary: r.result_summary ?? {},
    ms: Number(r.ms ?? 0),
  }))
}

/** A project's most recent runs, newest first: the conversation. */
export async function listProjectRuns(projectId: string, limit: number): Promise<BuilderRunRow[] | null> {
  const { data, error } = await createAdminClient()
    .from(RUNS)
    .select(RUN_FIELDS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    logger.error('studio/db.listProjectRuns', safeError(error), { projectId })
    return null
  }
  return (data ?? []).map((r) => toRunRow(r as Record<string, unknown>))
}

export interface BuilderProjectRow {
  id: string
  institutionId: string
  ownerId: string
  slug: string
  name: string
  status: 'active' | 'archived'
  draftHeadHash: string | null
  draftRev: number
  /** The head before the last successful build: what Undo goes back to. */
  draftUndoHash: string | null
  updatedAt: string
  /** Scheduled course sources any build of the project showed the model (keys only). */
  materialSources: MaterialSourceEntry[]
  /** Unopened sources were dropped for the provenance cap. */
  materialIncomplete: boolean
}

const PROJECT_FIELDS = 'id, institution_id, owner_id, slug, name, status, draft_head_hash, draft_rev, draft_undo_hash, updated_at, material_sources, material_incomplete'
const toBuilderProject = (r: Record<string, unknown>): BuilderProjectRow => ({
  id: r.id as string,
  institutionId: r.institution_id as string,
  ownerId: r.owner_id as string,
  slug: r.slug as string,
  name: r.name as string,
  status: r.status as 'active' | 'archived',
  draftHeadHash: (r.draft_head_hash as string | null) ?? null,
  draftRev: Number(r.draft_rev ?? 0),
  draftUndoHash: (r.draft_undo_hash as string | null) ?? null,
  updatedAt: r.updated_at as string,
  materialSources: toMaterialSources(r.material_sources),
  materialIncomplete: r.material_incomplete === true,
})

/** Provenance entries as stored: {k, s} objects with the unit-key and uuid shapes. Anything else is dropped. */
export function toMaterialSources(raw: unknown): MaterialSourceEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((e) => {
    const k = (e as { k?: unknown } | null)?.k
    const sec = (e as { s?: unknown } | null)?.s
    return typeof k === 'string' && typeof sec === 'string' && UNIT_KEY.test(k) && UUID.test(sec) ? [{ k, s: sec }] : []
  })
}

export async function loadBuilderProject(id: string): Promise<BuilderProjectRow | null> {
  const { data, error } = await createAdminClient().from(PROJECTS).select(PROJECT_FIELDS).eq('id', id).maybeSingle()
  if (error) logger.error('studio/db.loadBuilderProject', safeError(error), { id })
  return data ? toBuilderProject(data as Record<string, unknown>) : null
}

/** The owner's own active projects, most recently changed first. */
export async function listOwnedProjects(ownerId: string, institutionId: string, limit: number): Promise<BuilderProjectRow[] | null> {
  const { data, error } = await createAdminClient()
    .from(PROJECTS)
    .select(PROJECT_FIELDS)
    .eq('owner_id', ownerId)
    .eq('institution_id', institutionId)
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (error) {
    logger.error('studio/db.listOwnedProjects', safeError(error))
    return null
  }
  return (data ?? []).map((r) => toBuilderProject(r as Record<string, unknown>))
}

/** The newest run of each listed project, for the drafts list. One query. */
export async function listLatestRuns(projectIds: string[]): Promise<Map<string, BuilderRunRow>> {
  const latest = new Map<string, BuilderRunRow>()
  if (projectIds.length === 0) return latest
  const { data, error } = await createAdminClient()
    .from(RUNS)
    .select(RUN_FIELDS)
    .in('project_id', projectIds)
    .order('created_at', { ascending: false })
    .limit(projectIds.length * 5)
  if (error) {
    logger.error('studio/db.listLatestRuns', safeError(error))
    return latest
  }
  for (const r of data ?? []) {
    const row = toRunRow(r as Record<string, unknown>)
    if (!latest.has(row.projectId)) latest.set(row.projectId, row)
  }
  return latest
}

/** For the drafts list: each head snapshot's tool name, and the version it was saved as.
 * Two queries for the whole list. */
export async function loadDraftHeads(heads: { projectId: string; hash: string }[]): Promise<Map<string, { name: string | null; savedVersion: string | null }>> {
  const out = new Map<string, { name: string | null; savedVersion: string | null }>()
  if (heads.length === 0) return out
  const hashes = heads.map((h) => h.hash)
  const admin = createAdminClient()
  const [snaps, versions] = await Promise.all([
    admin.from(SNAPSHOTS).select('project_id, hash, name:manifest->>name').in('hash', hashes).limit(heads.length * 2),
    admin.from(VERSIONS).select('project_id, version, source_snapshot_hash').in('source_snapshot_hash', hashes).limit(heads.length * 2),
  ])
  if (snaps.error) logger.error('studio/db.loadDraftHeads', safeError(snaps.error))
  if (versions.error) logger.error('studio/db.loadDraftHeads: versions', safeError(versions.error))
  for (const h of heads) {
    const snap = (snaps.data ?? []).find((r) => r.project_id === h.projectId && r.hash === h.hash) as { name?: unknown } | undefined
    const saved = (versions.data ?? []).find((r) => r.project_id === h.projectId && r.source_snapshot_hash === h.hash)
    out.set(h.projectId, { name: typeof snap?.name === 'string' ? snap.name : null, savedVersion: saved?.version ?? null })
  }
  return out
}

export interface SnapshotRow {
  projectId: string
  hash: string
  compiler: string
  manifest: unknown
  files: Record<string, string>
  studentBundle: string
  professorBundle: string
  checkSummary: Record<string, unknown>
}

export async function loadSnapshot(projectId: string, hash: string): Promise<SnapshotRow | null> {
  const { data, error } = await createAdminClient()
    .from(SNAPSHOTS)
    .select('project_id, hash, compiler, manifest, files, student_bundle, professor_bundle, check_summary')
    .eq('project_id', projectId)
    .eq('hash', hash)
    .maybeSingle()
  if (error) logger.error('studio/db.loadSnapshot', safeError(error), { projectId })
  if (!data) return null
  return {
    projectId: data.project_id,
    hash: data.hash,
    compiler: data.compiler,
    manifest: data.manifest,
    files: data.files ?? {},
    studentBundle: data.student_bundle,
    professorBundle: data.professor_bundle,
    checkSummary: data.check_summary ?? {},
  }
}

/** One view's bundle of a snapshot, for the draft frame. Pinned to the project. */
export async function loadSnapshotBundle(projectId: string, hash: string, view: 'student' | 'professor'): Promise<{ code: string; name: string } | null> {
  const column = view === 'student' ? 'student_bundle' : 'professor_bundle'
  const { data, error } = await createAdminClient().from(SNAPSHOTS).select(`${column}, manifest`).eq('project_id', projectId).eq('hash', hash).maybeSingle()
  if (error) logger.error('studio/db.loadSnapshotBundle', safeError(error), { projectId, view })
  const row = data as Record<string, unknown> | null
  const code = row?.[column]
  if (typeof code !== 'string') return null
  const manifest = row?.manifest as { name?: unknown } | undefined
  return { code, name: typeof manifest?.name === 'string' ? manifest.name : 'Draft' }
}

/** The project's newest published version's manifest: its collections are frozen. */
export async function loadLatestProjectManifest(projectId: string): Promise<{ version: string; manifest: unknown } | null> {
  const { data, error } = await createAdminClient()
    .from(VERSIONS)
    .select('version, manifest')
    .eq('project_id', projectId)
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) logger.error('studio/db.loadLatestProjectManifest', safeError(error), { projectId })
  return data ? { version: data.version, manifest: data.manifest } : null
}

export interface DraftHistoryRow {
  runId: string
  request: string | null
  hash: string
  snapshotCreatedAt: string | null
  savedVersion: string | null
}

/** The project's draft history, newest first: one row per snapshot, from the newest run
 * that produced it. Three queries for the whole list. Never selects source, bundles,
 * manifest, plan or any model-written text. */
export async function listDraftHistory(projectId: string, limit: number): Promise<DraftHistoryRow[] | null> {
  const admin = createAdminClient()
  const runs = await admin
    .from(RUNS)
    .select('id, request, result_hash')
    .eq('project_id', projectId)
    .eq('status', 'preview_ready')
    .not('result_hash', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit * 2)
  if (runs.error) {
    logger.error('studio/db.listDraftHistory', safeError(runs.error), { projectId })
    return null
  }
  const newest = new Map<string, { runId: string; request: string | null }>()
  for (const r of runs.data ?? []) {
    if (!newest.has(r.result_hash)) newest.set(r.result_hash, { runId: r.id, request: r.request ?? null })
  }
  const hashes = [...newest.keys()].slice(0, limit)
  if (hashes.length === 0) return []
  const [snaps, versions] = await Promise.all([
    admin.from(SNAPSHOTS).select('hash, created_at').eq('project_id', projectId).in('hash', hashes).limit(hashes.length),
    admin.from(VERSIONS).select('version, source_snapshot_hash').eq('project_id', projectId).in('source_snapshot_hash', hashes).limit(hashes.length),
  ])
  const failure = snaps.error ?? versions.error
  if (failure) {
    logger.error('studio/db.listDraftHistory: snapshots', safeError(failure), { projectId })
    return null
  }
  const created = new Map((snaps.data ?? []).map((s) => [s.hash as string, s.created_at as string]))
  const saved = new Map((versions.data ?? []).map((v) => [v.source_snapshot_hash as string, v.version as string]))
  return [...newest].slice(0, limit).map(([hash, run]) => ({
    ...run,
    hash,
    snapshotCreatedAt: created.get(hash) ?? null,
    savedVersion: saved.get(hash) ?? null,
  }))
}

/** The version a snapshot was already saved as, if any. */
export async function loadVersionForSnapshot(projectId: string, hash: string): Promise<{ id: string; version: string } | null> {
  const { data, error } = await createAdminClient()
    .from(VERSIONS)
    .select('id, version')
    .eq('project_id', projectId)
    .eq('source_snapshot_hash', hash)
    .maybeSingle()
  if (error) logger.error('studio/db.loadVersionForSnapshot', safeError(error), { projectId })
  return data ?? null
}

const ROSTER_SECTIONS_MAX = 200
const ROSTER_MAX = 5000

/** Full names ("First Last") of students in every section the owner teaches or staffs,
 * for the builder's student-name check. Null when any read fails or a list is larger than
 * checked: the check then fails closed rather than passing on a partial roster. */
export async function loadOwnerRosterFullNames(ownerId: string): Promise<string[] | null> {
  try {
    return await readOwnerRosterFullNames(ownerId)
  } catch (error) {
    logger.error('studio/db.loadOwnerRosterFullNames', { name: error instanceof Error ? error.name : 'unknown', message: 'roster read threw' })
    return null
  }
}

async function readOwnerRosterFullNames(ownerId: string): Promise<string[] | null> {
  const admin = createAdminClient()
  const [owned, staffed] = await Promise.all([
    admin.from('course_sections').select('id').eq('professor_id', ownerId).limit(ROSTER_SECTIONS_MAX),
    admin.from('section_staff').select('section_id').eq('staff_id', ownerId).eq('status', 'active').limit(ROSTER_SECTIONS_MAX),
  ])
  if (owned.error || staffed.error || !Array.isArray(owned.data) || !Array.isArray(staffed.data)) return null
  if (owned.data.length >= ROSTER_SECTIONS_MAX || staffed.data.length >= ROSTER_SECTIONS_MAX) return null
  const sections = [...new Set([...owned.data.map((r) => r.id as string), ...staffed.data.map((r) => r.section_id as string)])]
  if (sections.length === 0) return []
  const { data, error } = await admin.from('enrollments').select('student:profiles(first_name, last_name)').in('section_id', sections).limit(ROSTER_MAX)
  if (error || !Array.isArray(data) || data.length >= ROSTER_MAX) return null
  const names: string[] = []
  for (const row of data as Record<string, unknown>[]) {
    const p = (Array.isArray(row.student) ? row.student[0] : row.student) as { first_name?: string | null; last_name?: string | null } | null
    // A missing profile means the roster read is not the roster that exists.
    if (!p) return null
    const full = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
    if (full.includes(' ')) names.push(full)
  }
  return names
}

// RPC calls. Each returns the function's jsonb outcome, or null when the call failed.
async function builderRpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const { data, error } = await createAdminClient().rpc(name, args)
  if (error) {
    logger.error(`studio/db.${name}`, safeError(error))
    return null
  }
  return (data as Record<string, unknown> | null) ?? {}
}

export interface StartBuildArgs {
  ownerId: string
  institutionId: string
  sectionId: string
  projectId: string | null
  newSlug: string
  newName: string
  request: string
  clientRequestId: string
  replaceRunId: string | null
  maxDailyRuns: number
  maxLiveRuns: number
  maxDailyCost: number
}

export interface ApplyArgs {
  runId: string
  token: string
  step: Record<string, unknown>
  expectedWorkRev: number
  work: Record<string, unknown> | null
  plan: Record<string, unknown> | null
  phase: string | null
  delta: Record<string, unknown>
  caps: Record<string, number>
  activeMs: number
}

export interface PauseArgs {
  runId: string
  token: string
  step: Record<string, unknown>
  interrupted: Record<string, unknown>[]
  pending: Record<string, unknown> | null
  question: Record<string, unknown> | null
  delta: Record<string, unknown>
  caps: Record<string, number>
  waitingMs: number
  activeMs: number
}

export interface EndArgs {
  runId: string
  token: string
  status: BuilderRunStatus
  errorCode: string | null
  result: Record<string, unknown>
  snapshot: Record<string, unknown> | null
  activeMs: number
}

/** The institution's builder spend over the last 24 hours, or null if it can't be read. */
export async function loadInstitutionBuilderSpend(institutionId: string): Promise<number | null> {
  const { data, error } = await createAdminClient().rpc('studio_builder_spend', { p_institution: institutionId })
  if (error) {
    logger.error('studio/db.loadInstitutionBuilderSpend', safeError(error))
    return null
  }
  return Number(data ?? 0)
}

export const builderRpcs = {
  start: (a: StartBuildArgs) =>
    builderRpc('studio_builder_start', {
      p_owner: a.ownerId, p_institution: a.institutionId, p_section: a.sectionId, p_project: a.projectId,
      p_new_slug: a.newSlug, p_new_name: a.newName, p_request: a.request, p_client_request_id: a.clientRequestId,
      p_replace_run: a.replaceRunId, p_max_daily_runs: a.maxDailyRuns, p_max_live_runs: a.maxLiveRuns, p_max_daily_cost: a.maxDailyCost,
    }),
  claim: (runId: string, jobId: string, sliceNo: number, staleMs: number, maxResumes: number) =>
    builderRpc('studio_builder_claim', { p_run: runId, p_job: jobId, p_slice: sliceNo, p_stale_ms: staleMs, p_max_resumes: maxResumes }),
  heartbeat: (runId: string, token: string) => builderRpc('studio_builder_heartbeat', { p_run: runId, p_token: token }),
  addCost: (runId: string, u: { input: number; cached: number; output: number; costUsd: number }) =>
    builderRpc('studio_builder_add_cost', { p_run: runId, p_input: u.input, p_cached: u.cached, p_output: u.output, p_cost: u.costUsd }),
  recordTurn: (runId: string, token: string, step: Record<string, unknown>, activeMs: number, refused: boolean) =>
    builderRpc('studio_builder_record_turn', { p_run: runId, p_token: token, p_step: step, p_active_ms: activeMs, p_refused: refused }),
  apply: (a: ApplyArgs) =>
    builderRpc('studio_builder_apply', {
      p_run: a.runId, p_token: a.token, p_step: a.step, p_expected_work_rev: a.expectedWorkRev, p_work: a.work,
      p_plan: a.plan, p_phase: a.phase, p_delta: a.delta, p_caps: a.caps, p_active_ms: a.activeMs,
    }),
  pause: (a: PauseArgs) =>
    builderRpc('studio_builder_pause', {
      p_run: a.runId, p_token: a.token, p_step: a.step, p_interrupted: a.interrupted, p_pending: a.pending,
      p_question: a.question, p_delta: a.delta, p_caps: a.caps, p_waiting_ms: a.waitingMs, p_active_ms: a.activeMs,
    }),
  decide: (runId: string, ownerId: string, proposalId: string, deltaHash: string, approve: boolean, maxLiveRuns: number) =>
    builderRpc('studio_builder_decide', { p_run: runId, p_owner: ownerId, p_proposal_id: proposalId, p_delta_hash: deltaHash, p_approve: approve, p_max_live_runs: maxLiveRuns }),
  answer: (runId: string, ownerId: string, questionId: string, answer: string, maxLiveRuns: number) =>
    builderRpc('studio_builder_answer', { p_run: runId, p_owner: ownerId, p_question_id: questionId, p_answer: answer, p_max_live_runs: maxLiveRuns }),
  handoff: (runId: string, token: string, maxSlices: number, activeMs: number) =>
    builderRpc('studio_builder_handoff', { p_run: runId, p_token: token, p_max_slices: maxSlices, p_active_ms: activeMs }),
  end: (a: EndArgs) =>
    builderRpc('studio_builder_end', {
      p_run: a.runId, p_token: a.token, p_status: a.status, p_error_code: a.errorCode, p_result: a.result,
      p_snapshot: a.snapshot, p_active_ms: a.activeMs,
    }),
  stop: (runId: string, ownerId: string, staleMs: number) => builderRpc('studio_builder_stop', { p_run: runId, p_owner: ownerId, p_stale_ms: staleMs }),
  tend: (runId: string, ownerId: string, staleMs: number, maxResumes: number) =>
    builderRpc('studio_builder_tend', { p_run: runId, p_owner: ownerId, p_stale_ms: staleMs, p_max_resumes: maxResumes }),
  /** The job worker's upkeep across every school: per-outcome counts and the requeued job ids. */
  sweep: (staleMs: number, maxResumes: number, limit: number) =>
    builderRpc('studio_builder_sweep', { p_stale_ms: staleMs, p_max_resumes: maxResumes, p_limit: limit }),
  undo: (projectId: string, actorId: string, expectedHead: string, expectedRev: number) =>
    builderRpc('studio_builder_undo', { p_project: projectId, p_actor: actorId, p_expected_head: expectedHead, p_expected_rev: expectedRev }),
}

// ── Project memory ───────────────────────────────────────────────────
// The professor's lasting decisions about one tool (supabase/migrations/
// 20261002210000_studio_project_memory.sql). Server-only like the rest. Reads pin the
// project and its institution; every write is a security definer function that re-checks
// the owner, the project and the state under a lock.

export interface MemoryRow {
  id: string
  projectId: string
  institutionId: string
  ownerId: string
  topic: MemoryTopic
  slot: MemorySlot
  kind: MemoryKind
  statement: string
  origin: 'professor_edit' | 'approved_proposal'
  evidence: string | null
  sourceRunId: string | null
  status: 'proposed' | 'active' | 'superseded' | 'removed' | 'rejected'
  createdAt: string
  updatedAt: string
  /** For a proposal: the statements of every active decision approval would supersede. */
  replacesStatements: string[]
}

const MEMORY_FIELDS = 'id, project_id, institution_id, owner_id, topic, slot_key, kind, statement, origin, evidence, source_run_id, status, created_at, updated_at'

function toMemoryRow(r: Record<string, unknown>): MemoryRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    institutionId: r.institution_id as string,
    ownerId: r.owner_id as string,
    topic: r.topic as MemoryTopic,
    slot: r.slot_key as MemorySlot,
    kind: r.kind as MemoryKind,
    statement: r.statement as string,
    origin: r.origin as MemoryRow['origin'],
    evidence: (r.evidence as string | null) ?? null,
    sourceRunId: (r.source_run_id as string | null) ?? null,
    status: r.status as MemoryRow['status'],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    replacesStatements: Array.isArray(r.replaces) ? (r.replaces as string[]) : [],
  }
}

/**
 * A project's active decisions, oldest first, or null when they can't be read. Pinned to the
 * project and its institution, and joined to an active project: an archived tool loads none.
 */
export async function listActiveMemories(projectId: string, institutionId: string): Promise<MemoryRow[] | null> {
  const { data, error } = await createAdminClient()
    .from(MEMORIES)
    .select(`${MEMORY_FIELDS}, project:${PROJECTS}!inner(status)`)
    .eq('project_id', projectId)
    .eq('institution_id', institutionId)
    .eq('status', 'active')
    .eq('project.status', 'active')
    .order('created_at', { ascending: true })
    .limit(STUDIO_MEMORY_MAX_ACTIVE + 5)
  if (error) {
    logger.error('studio/db.listActiveMemories', safeError(error), { projectId })
    return null
  }
  return (data ?? []).map((r) => toMemoryRow(r as Record<string, unknown>))
}

/**
 * The proposals one run raised that still wait for the professor, owner-pinned. Each carries
 * every statement approval would supersede, exactly as studio_memory_decide does: the active
 * decision it named, and the active decision in its own topic and slot. The card shows that, so nothing is lost silently.
 */
export async function listRunMemoryProposals(runId: string, ownerId: string): Promise<MemoryRow[] | null> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from(MEMORIES)
    .select(`${MEMORY_FIELDS}, replaces_id`)
    .eq('source_run_id', runId)
    .eq('owner_id', ownerId)
    .eq('origin', 'approved_proposal')
    .eq('status', 'proposed')
    .order('created_at', { ascending: true })
    .limit(10)
  if (error) {
    logger.error('studio/db.listRunMemoryProposals', safeError(error), { runId })
    return null
  }
  const proposals = (data ?? []) as Record<string, unknown>[]
  if (proposals.length === 0) return []
  const { data: active, error: activeError } = await admin
    .from(MEMORIES)
    .select('id, topic, slot_key, statement')
    .eq('project_id', proposals[0].project_id as string)
    .eq('status', 'active')
    .limit(STUDIO_MEMORY_MAX_ACTIVE + 5)
  if (activeError) {
    logger.error('studio/db.listRunMemoryProposals.active', safeError(activeError), { runId })
    return null
  }
  return proposals.map((p) => {
    const superseded = (active ?? []).filter((a) => a.id === p.replaces_id || (a.topic === p.topic && a.slot_key === p.slot_key))
    // The named decision first, then the one in the slot.
    superseded.sort((x, y) => Number(y.id === p.replaces_id) - Number(x.id === p.replaces_id))
    return toMemoryRow({ ...p, replaces: superseded.map((a) => a.statement) })
  })
}

export interface ProposeMemoryArgs {
  runId: string
  token: string
  step: Record<string, unknown>
  topic: MemoryTopic
  slot: MemorySlot
  kind: MemoryKind
  statement: string
  evidence: string
  replacesId: string | null
  caps: { tool_calls: number; memory_proposals: number; memory_active: number }
  activeMs: number
}

export const memoryRpcs = {
  propose: (a: ProposeMemoryArgs) =>
    builderRpc('studio_memory_propose', {
      p_run: a.runId, p_token: a.token, p_step: a.step, p_topic: a.topic, p_slot: a.slot, p_kind: a.kind, p_statement: a.statement,
      p_evidence: a.evidence, p_replaces: a.replacesId, p_caps: a.caps, p_active_ms: a.activeMs,
    }),
  decide: (memoryId: string, runId: string, ownerId: string, approve: boolean, maxActive: number, ttlMs: number) =>
    builderRpc('studio_memory_decide', { p_memory: memoryId, p_run: runId, p_owner: ownerId, p_approve: approve, p_max_active: maxActive, p_ttl_ms: ttlMs }),
  save: (projectId: string, ownerId: string, topic: MemoryTopic, slot: MemorySlot, kind: MemoryKind, statement: string, replaceId: string | null, maxActive: number) =>
    builderRpc('studio_memory_save', { p_project: projectId, p_owner: ownerId, p_topic: topic, p_slot: slot, p_kind: kind, p_statement: statement, p_replace: replaceId, p_max_active: maxActive }),
  remove: (memoryId: string, ownerId: string, projectId: string) => builderRpc('studio_memory_remove', { p_memory: memoryId, p_owner: ownerId, p_project: projectId }),
  /** The builder's upkeep: rejects proposals nobody answered. Returns how many. */
  expire: async (ttlMs: number, limit: number): Promise<number | null> => {
    const { data, error } = await createAdminClient().rpc('studio_memory_expire', { p_ttl_ms: ttlMs, p_limit: limit })
    if (error) {
      logger.error('studio/db.studio_memory_expire', safeError(error))
      return null
    }
    return Number(data ?? 0)
  },
}

// ── Course material (Step 9). Not Studio tables: the eligibility functions read the
// professor's existing course content. Every call is pinned to an institution and section
// that came from a gated run or installation, never from a caller's input, and the SQL
// filters both again. ──

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UNIT_KEY = /^(p:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,4}|[ma]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|s:[0-9]{1,2}:[0-9]{1,2})$/

const asUnitRow = (r: Record<string, unknown>): CourseUnitRow => ({
  unitKey: r.unit_key as string,
  sourceKind: r.source_kind as CourseUnitRow['sourceKind'],
  moduleTitle: (r.module_title as string | null) ?? null,
  weekNumber: typeof r.week_number === 'number' ? r.week_number : null,
  itemType: (r.item_type as string | null) ?? null,
  page: typeof r.page === 'number' ? r.page : null,
  title: (r.title as string | null) ?? null,
  heading: (r.heading as string | null) ?? null,
  disclosure: r.disclosure as CourseUnitRow['disclosure'],
  opensAt: (r.opens_at as string | null) ?? null,
  excerpt: (r.excerpt as string | null) ?? '',
})

/** Ranked search. Null on any failure, including the client-side timeout. */
export async function courseSearch(
  institutionId: string,
  sectionId: string,
  query: string,
  focusModuleIds: string[],
  limit: number,
): Promise<{ rows: CourseUnitRow[]; withheld: number } | null> {
  try {
    const { data, error } = await createAdminClient()
      .rpc('studio_course_search', {
        p_institution: institutionId,
        p_section: sectionId,
        p_now: new Date().toISOString(),
        p_query: query,
        p_focus: focusModuleIds.filter((id) => UUID.test(id)),
        p_limit: limit,
      })
      .abortSignal(AbortSignal.timeout(STUDIO_COURSE_TIMEOUT_MS))
    if (error || !Array.isArray(data)) {
      logger.warn('studio/db.courseSearch', { code: error?.code ?? null })
      return null
    }
    const rows = data as Record<string, unknown>[]
    const withheld = Number(rows.find((r) => r.unit_key === null)?.withheld_matches ?? 0)
    return { rows: rows.filter((r) => typeof r.unit_key === 'string').map(asUnitRow), withheld }
  } catch (error) {
    logger.warn('studio/db.courseSearch', { name: error instanceof Error ? error.name : 'unknown' })
    return null
  }
}

/** The per-turn re-read of one search's keys, still released or scheduled. Null on failure. */
export async function courseExcerpts(institutionId: string, sectionId: string, query: string, keys: string[]): Promise<CourseUnitRow[] | null> {
  const wanted = keys.filter((k) => UNIT_KEY.test(k))
  if (wanted.length === 0) return []
  try {
    const { data, error } = await createAdminClient()
      .rpc('studio_course_excerpts', { p_institution: institutionId, p_section: sectionId, p_now: new Date().toISOString(), p_query: query, p_keys: wanted })
      .abortSignal(AbortSignal.timeout(STUDIO_COURSE_TIMEOUT_MS))
    if (error || !Array.isArray(data)) {
      logger.warn('studio/db.courseExcerpts', { code: error?.code ?? null })
      return null
    }
    return (data as Record<string, unknown>[]).map(asUnitRow)
  } catch (error) {
    logger.warn('studio/db.courseExcerpts', { name: error instanceof Error ? error.name : 'unknown' })
    return null
  }
}

export interface CourseSourceRow {
  unitKey: string
  sourceKind: CourseUnitRow['sourceKind']
  moduleTitle: string | null
  weekNumber: number | null
  itemType: string | null
  page: number | null
  title: string | null
  disclosure: 'released' | 'scheduled' | 'withheld'
  opensAt: string | null
  body: string
}

/** The given keys in every disclosure class, with their text: the copy guard's and the release review's read. Null on failure. */
export async function courseSources(institutionId: string, sectionId: string, keys: string[]): Promise<CourseSourceRow[] | null> {
  const wanted = keys.filter((k) => UNIT_KEY.test(k))
  if (wanted.length === 0) return []
  try {
    const { data, error } = await createAdminClient()
      .rpc('studio_course_sources', { p_institution: institutionId, p_section: sectionId, p_now: new Date().toISOString(), p_keys: wanted })
      .abortSignal(AbortSignal.timeout(STUDIO_COURSE_TIMEOUT_MS))
    if (error || !Array.isArray(data)) {
      logger.warn('studio/db.courseSources', { code: error?.code ?? null })
      return null
    }
    return (data as Record<string, unknown>[]).map((r) => ({
      unitKey: r.unit_key as string,
      sourceKind: r.source_kind as CourseUnitRow['sourceKind'],
      moduleTitle: (r.module_title as string | null) ?? null,
      weekNumber: typeof r.week_number === 'number' ? r.week_number : null,
      itemType: (r.item_type as string | null) ?? null,
      page: typeof r.page === 'number' ? r.page : null,
      title: (r.title as string | null) ?? null,
      disclosure: r.disclosure as CourseSourceRow['disclosure'],
      opensAt: (r.opens_at as string | null) ?? null,
      body: (r.body as string | null) ?? '',
    }))
  } catch (error) {
    logger.warn('studio/db.courseSources', { name: error instanceof Error ? error.name : 'unknown' })
    return null
  }
}

/** The section's modules (no system modules) and start date, for resolving a week focus. Null on failure. */
export async function loadSectionFocus(
  institutionId: string,
  sectionId: string,
): Promise<{ startDate: string | null; modules: { id: string; weekNumber: number | null; unlockDate: string | null; isPublished: boolean }[] } | null> {
  const admin = createAdminClient()
  const [section, modules] = await Promise.all([
    admin.from('course_sections').select('start_date').eq('id', sectionId).eq('institution_id', institutionId).maybeSingle(),
    admin.from('modules').select('id, week_number, unlock_date, is_published').eq('section_id', sectionId).is('system_kind', null).limit(400),
  ])
  if (section.error || modules.error || !section.data) {
    logger.warn('studio/db.loadSectionFocus', { code: section.error?.code ?? modules.error?.code ?? null })
    return null
  }
  return {
    startDate: (section.data as { start_date: string | null }).start_date ?? null,
    modules: ((modules.data ?? []) as { id: string; week_number: number | null; unlock_date: string | null; is_published: boolean | null }[]).map((m) => ({
      id: m.id,
      weekNumber: m.week_number,
      unlockDate: m.unlock_date,
      isPublished: m.is_published === true,
    })),
  }
}
