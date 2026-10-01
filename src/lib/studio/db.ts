/**
 * The only module that names the studio_plugin_* tables (a tripwire test enforces it).
 * It runs queries and nothing else: deciding who may see what is context.ts and
 * policy.ts. The admin client is created here and never accepted from a caller, and
 * every record query applies `scopeFilter`, which pins the installation and collection.
 */
import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

const PROJECTS = 'studio_plugin_projects'
const VERSIONS = 'studio_plugin_versions'
const INSTALLATIONS = 'studio_plugin_installations'
const RECORDS = 'studio_plugin_records'

/** `duplicate` names which uniqueness rule refused a write, so callers can explain it
 * without knowing constraint names. */
export type DbError = { code: string | null; message: string; duplicate?: 'project' | 'installation' }
export type DbWrite<T> = { ok: true; value: T } | { ok: false; error: DbError }

const DUPLICATES: [string, NonNullable<DbError['duplicate']>][] = [
  ['studio_plugin_projects_institution_id_owner_id_slug_key', 'project'],
  ['uq_studio_installation_active', 'installation'],
]

function failed(source: string, error: { code?: string; message: string }): { ok: false; error: DbError } {
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
}

export async function loadInstallation(id: string): Promise<InstallationRow | null> {
  const { data, error } = await createAdminClient()
    .from(INSTALLATIONS)
    .select('id, institution_id, section_id, project_id, status, current_version_id')
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
  }
}

export interface VersionRow {
  id: string
  projectId: string
  institutionId: string
  version: string
  manifest: unknown
}

export async function loadVersion(id: string): Promise<VersionRow | null> {
  const { data, error } = await createAdminClient()
    .from(VERSIONS)
    .select('id, project_id, institution_id, version, manifest')
    .eq('id', id)
    .maybeSingle()
  if (error) logger.error('studio/db.loadVersion', error, { id })
  if (!data) return null
  return {
    id: data.id,
    projectId: data.project_id,
    institutionId: data.institution_id,
    version: data.version,
    manifest: data.manifest,
  }
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

export async function activateVersion(
  installationId: string,
  versionId: string,
  actorId: string,
  approve: boolean,
): Promise<DbWrite<null>> {
  const { error } = await createAdminClient().rpc('studio_activate_version', {
    p_installation_id: installationId,
    p_version_id: versionId,
    p_actor_id: actorId,
    p_approve: approve,
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
