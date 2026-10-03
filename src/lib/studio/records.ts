/**
 * The trusted record service: list, get, create, update and delete plugin records, one at
 * a time or in a batch.
 *
 * A request carries only an installation ID, a collection name, a record ID where
 * one is needed, data for writes, and for a staffPerStudent create the handle of the
 * student it is about. It can't carry a user, role, institution, section, owner or
 * version: the input schemas are strict, and every one of those comes from resolveViewer.
 * A handle is resolved against the installation's own section (handles.ts). Not found,
 * not permitted and an unknown handle return the same message, so a caller can't use it
 * to probe which installations, records or students exist.
 *
 * Plain server module, not 'use server'. Callers are future server actions.
 */
import 'server-only'
import { z } from 'zod'
import { logEvent } from '@/lib/supabase/event-logger'
import { STUDENT_HANDLE } from './bridge/catalog'
import { resolveViewer, type StudioViewer } from './context'
import * as db from './db'
import { loadHandleKey, loadHandleRoster, type HandleKey } from './handles'
import { STUDIO_RECORD_BATCH_MAX, STUDIO_RECORD_PAGE_MAX } from './limits'
import { decide, type RecordOperation } from './policy'
import { validateRecordData, type CollectionDef } from './record-schema'

export const RECORD_NOT_AVAILABLE = 'This isn’t available.'
const RECORD_FAILED = 'Something went wrong saving this. Try again.'
export const RECORD_CONFLICT = 'Someone else changed this while you were editing. Reload and try again.'
export const RECORD_FULL = 'This tool has run out of storage space, so this wasn’t saved.'
export const RECORD_FULL_STUDENT = 'You’ve used all the storage this tool gives you, so this wasn’t saved.'
const RECORD_MISMATCH = 'This record doesn’t match its collection.'

/** What a plugin sees of a record. No user IDs (rule 2.1): `mine` says whether the
 * viewer owns or wrote it. */
export interface PluginRecord {
  id: string
  data: Record<string, unknown>
  mine: boolean
  createdAt: string
  updatedAt: string
  /** Staff viewers only, on perStudent and staffPerStudent collections: the handle of the
   * student the record belongs to. A student's own view never gets one. */
  student?: string
}

export type RecordResult<T> = { ok: true; value: T } | { ok: false; error: string; issues?: string[] }

const collectionName = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/)
const target = { installationId: z.uuid(), collection: collectionName }
const handle = z.string().regex(STUDENT_HANDLE)
const createItem = { data: z.unknown(), student: handle.optional() }
const updateItem = { recordId: z.uuid(), data: z.unknown(), expectedUpdatedAt: z.string().max(64).optional() }
const deleteItem = { recordId: z.uuid() }

const listInput = z.strictObject({
  ...target,
  limit: z.number().int().min(1).max(STUDIO_RECORD_PAGE_MAX).optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
})
const getInput = z.strictObject({ ...target, recordId: z.uuid() })
const createInput = z.strictObject({ ...target, ...createItem })
const updateInput = z.strictObject({ ...target, ...updateItem })
const deleteInput = z.strictObject({ ...target, ...deleteItem })
const batchInput = z.strictObject({
  ...target,
  items: z
    .array(
      z.discriminatedUnion('op', [
        z.strictObject({ op: z.literal('create'), ...createItem }),
        z.strictObject({ op: z.literal('update'), ...updateItem }),
        z.strictObject({ op: z.literal('delete'), ...deleteItem }),
      ]),
    )
    .min(1)
    .max(STUDIO_RECORD_BATCH_MAX),
})

export type ListRecordsInput = z.input<typeof listInput>
export type GetRecordInput = z.input<typeof getInput>
export type CreateRecordInput = z.input<typeof createInput>
export type UpdateRecordInput = z.input<typeof updateInput>
export type DeleteRecordInput = z.input<typeof deleteInput>
export type BatchRecordsInput = z.input<typeof batchInput>
type BatchItem = z.output<typeof batchInput>['items'][number]
export type BatchItemResult = RecordResult<PluginRecord | null>

const denied = (): { ok: false; error: string } => ({ ok: false, error: RECORD_NOT_AVAILABLE })
const failed = (): { ok: false; error: string } => ({ ok: false, error: RECORD_FAILED })
const mismatch = (issue: string) => ({ ok: false as const, error: RECORD_MISMATCH, issues: [issue] })

interface Authorized {
  viewer: StudioViewer
  collection: CollectionDef
  scope: db.RecordScope
  /** The viewer's own ID, the named student's ('student'), or null. */
  ownerStamp: string | 'student' | null
}

/** Steps 4 to 8: collection and policy, for a viewer resolveViewer already built. Null
 * for every refusal. */
function authorizeFor(viewer: StudioViewer, name: string, operation: RecordOperation): Authorized | null {
  // hasOwn, so a name like "constructor" can't resolve through the prototype.
  if (!Object.hasOwn(viewer.manifest.collections, name)) return null
  const collection = viewer.manifest.collections[name]

  const decision = decide(viewer.role, collection.access, operation, viewer.writable ? 'writable' : 'readOnly')
  if (!decision.allow) return null

  return {
    viewer,
    collection,
    scope: {
      installationId: viewer.installationId,
      collection: name,
      owner: decision.ownerFilter === 'self' ? { only: viewer.userId } : 'any',
    },
    ownerStamp: decision.ownerStamp === 'self' ? viewer.userId : decision.ownerStamp === 'student' ? 'student' : null,
  }
}

/** Steps 1 to 8: session, installation, role, current version, manifest, collection, policy. */
async function authorize(installationId: string, name: string, operation: RecordOperation): Promise<Authorized | null> {
  const viewer = await resolveViewer(installationId)
  return viewer ? authorizeFor(viewer, name, operation) : null
}

/** Handles for one call, each loaded at most once and only when needed: the key when a
 * staff viewer reads owned records, the roster when a write names a student. */
function callHandles(viewer: StudioViewer) {
  let key: Promise<HandleKey | null> | undefined
  let byHandle: Promise<Map<string, string> | null> | undefined
  const loadKey = () => (key ??= loadHandleKey(viewer.installationId))
  return {
    /** The key, when records read in this collection carry a student handle; undefined
     * when they don't; null when they should but the salt can't be read. */
    async forRecords(auth: Authorized): Promise<HandleKey | null | undefined> {
      const owned = auth.collection.access === 'perStudent' || auth.collection.access === 'staffPerStudent'
      return owned && viewer.role !== 'student' ? loadKey() : undefined
    },
    /** The section student a handle names, or null when it names no one here. */
    async resolve(handle: string): Promise<string | null | 'error'> {
      byHandle ??= loadKey().then(async (k) => {
        const roster = k && (await loadHandleRoster(k, viewer.sectionId))
        return roster ? new Map(roster.map((r) => [r.handle, r.student.id])) : null
      })
      const map = await byHandle
      return map ? (map.get(handle) ?? null) : 'error'
    },
  }
}
type CallHandles = ReturnType<typeof callHandles>

function toPlugin(row: db.RecordRow, viewer: StudioViewer, key: HandleKey | undefined): PluginRecord {
  return {
    id: row.id,
    data: row.data,
    mine: row.ownerId === viewer.userId || (row.ownerId === null && row.authorId === viewer.userId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(key && row.ownerId ? { student: key.of(row.ownerId) } : {}),
  }
}

/** Rule 3.5: every write is audited. The record's contents never go into the event, and
 * neither does the student it is about. */
function audit(viewer: StudioViewer, operation: 'create' | 'update' | 'delete', collection: string, recordId: string) {
  logEvent({
    userId: viewer.userId,
    eventType: `studio.record.${operation}`,
    eventCategory: 'studio',
    sectionId: viewer.sectionId,
    metadata: { installationId: viewer.installationId, versionId: viewer.versionId, collection, recordId },
  })
}

/** A write the storage quota refused. Logged so a professor's "students can't save"
 * report can be traced; identifiers only, never the record. */
function saveFailed(viewer: StudioViewer, operation: 'create' | 'update', collection: string, error: db.DbError) {
  if (!error.full) return failed()
  logEvent({
    userId: viewer.userId,
    eventType: 'studio.record.quota_refused',
    eventCategory: 'studio',
    sectionId: viewer.sectionId,
    metadata: { installationId: viewer.installationId, versionId: viewer.versionId, collection, operation, limit: error.full },
  })
  return { ok: false as const, error: error.full === 'student' ? RECORD_FULL_STUDENT : RECORD_FULL }
}

export async function listRecords(input: ListRecordsInput): Promise<RecordResult<PluginRecord[]>> {
  const parsed = listInput.safeParse(input)
  if (!parsed.success) return denied()
  const auth = await authorize(parsed.data.installationId, parsed.data.collection, 'list')
  if (!auth) return denied()

  const [rows, key] = await Promise.all([
    db.listRecords(auth.scope, { limit: parsed.data.limit ?? STUDIO_RECORD_PAGE_MAX, offset: parsed.data.offset ?? 0 }),
    callHandles(auth.viewer).forRecords(auth),
  ])
  if (!rows || key === null) return failed()
  return { ok: true, value: rows.map((r) => toPlugin(r, auth.viewer, key)) }
}

export async function getRecord(input: GetRecordInput): Promise<RecordResult<PluginRecord>> {
  const parsed = getInput.safeParse(input)
  if (!parsed.success) return denied()
  const auth = await authorize(parsed.data.installationId, parsed.data.collection, 'get')
  if (!auth) return denied()

  const [row, key] = await Promise.all([db.getRecord(auth.scope, parsed.data.recordId), callHandles(auth.viewer).forRecords(auth)])
  if (!row) return denied()
  return key === null ? failed() : { ok: true, value: toPlugin(row, auth.viewer, key) }
}

async function create(auth: Authorized, handles: CallHandles, item: { data: unknown; student?: string }): Promise<RecordResult<PluginRecord>> {
  const { viewer, scope } = auth
  const named = auth.ownerStamp === 'student' ? item.student : null
  if (named === undefined) return mismatch('student: Say which student this record is about')
  if (named === null && item.student !== undefined) {
    return mismatch('student: Only a staffPerStudent collection’s records name a student')
  }

  const valid = validateRecordData(viewer.versionId, scope.collection, auth.collection, item.data)
  if (!valid.ok) return { ok: false, error: RECORD_MISMATCH, issues: valid.issues }

  let ownerId = auth.ownerStamp === 'student' ? null : auth.ownerStamp
  if (named !== null) {
    const resolved = await handles.resolve(named)
    if (resolved === 'error') return failed()
    // A handle from another installation, a student who left, or a guess.
    if (!resolved) return denied()
    ownerId = resolved
  }

  const [saved, key] = await Promise.all([
    db.insertRecord(
      {
        institutionId: viewer.institutionId,
        sectionId: viewer.sectionId,
        installationId: viewer.installationId,
        versionId: viewer.versionId,
        collection: scope.collection,
        ownerId,
        authorId: viewer.userId,
      },
      valid.data,
    ),
    handles.forRecords(auth),
  ])
  if (!saved.ok) return saveFailed(viewer, 'create', scope.collection, saved.error)
  audit(viewer, 'create', scope.collection, saved.value.id)
  // Saved and audited; the handle is the only part missing if the salt can't be read.
  return { ok: true, value: toPlugin(saved.value, viewer, key ?? undefined) }
}

async function update(
  auth: Authorized,
  handles: CallHandles,
  item: { recordId: string; data: unknown; expectedUpdatedAt?: string },
): Promise<RecordResult<PluginRecord>> {
  const valid = validateRecordData(auth.viewer.versionId, auth.scope.collection, auth.collection, item.data)
  if (!valid.ok) return { ok: false, error: RECORD_MISMATCH, issues: valid.issues }

  const [saved, key] = await Promise.all([
    db.updateRecord(auth.scope, item.recordId, { data: valid.data, versionId: auth.viewer.versionId, expectedUpdatedAt: item.expectedUpdatedAt }),
    handles.forRecords(auth),
  ])
  if (!saved.ok) return saveFailed(auth.viewer, 'update', auth.scope.collection, saved.error)
  if (!saved.value) {
    // Zero rows: missing, outside the viewer's scope, or changed by someone else.
    // Re-read in the same scope, so a conflict is reported only on a record the
    // viewer can already see.
    const stillThere = item.expectedUpdatedAt && (await db.getRecord(auth.scope, item.recordId))
    return stillThere ? { ok: false, error: RECORD_CONFLICT } : denied()
  }
  audit(auth.viewer, 'update', auth.scope.collection, saved.value.id)
  return { ok: true, value: toPlugin(saved.value, auth.viewer, key ?? undefined) }
}

async function remove(auth: Authorized, recordId: string): Promise<RecordResult<null>> {
  const removed = await db.deleteRecord(auth.scope, recordId)
  if (!removed.ok) return failed()
  if (!removed.value) return denied()
  audit(auth.viewer, 'delete', auth.scope.collection, recordId)
  return { ok: true, value: null }
}

export async function createRecord(input: CreateRecordInput): Promise<RecordResult<PluginRecord>> {
  const parsed = createInput.safeParse(input)
  if (!parsed.success) return denied()
  const auth = await authorize(parsed.data.installationId, parsed.data.collection, 'create')
  if (!auth) return denied()
  return create(auth, callHandles(auth.viewer), parsed.data)
}

export async function updateRecord(input: UpdateRecordInput): Promise<RecordResult<PluginRecord>> {
  const parsed = updateInput.safeParse(input)
  if (!parsed.success) return denied()
  const auth = await authorize(parsed.data.installationId, parsed.data.collection, 'update')
  if (!auth) return denied()
  return update(auth, callHandles(auth.viewer), parsed.data)
}

export async function deleteRecord(input: DeleteRecordInput): Promise<RecordResult<null>> {
  const parsed = deleteInput.safeParse(input)
  if (!parsed.success) return denied()
  const auth = await authorize(parsed.data.installationId, parsed.data.collection, 'delete')
  if (!auth) return denied()
  return remove(auth, parsed.data.recordId)
}

/** Many writes to one collection. Each item runs exactly as its single method would (the
 * same policy, validation, quota and audit), in order, and gets its own result: a batch is
 * not a transaction, and one refused item doesn't stop the rest. The viewer is resolved
 * once, and the roster at most once. */
export async function batchRecords(input: BatchRecordsInput): Promise<RecordResult<BatchItemResult[]>> {
  const parsed = batchInput.safeParse(input)
  if (!parsed.success) return denied()
  const viewer = await resolveViewer(parsed.data.installationId)
  if (!viewer) return denied()

  const handles = callHandles(viewer)
  const results: BatchItemResult[] = []
  for (const item of parsed.data.items as BatchItem[]) {
    const auth = authorizeFor(viewer, parsed.data.collection, item.op)
    if (!auth) results.push(denied())
    else if (item.op === 'create') results.push(await create(auth, handles, item))
    else if (item.op === 'update') results.push(await update(auth, handles, item))
    else results.push(await remove(auth, item.recordId))
  }
  return { ok: true, value: results }
}
