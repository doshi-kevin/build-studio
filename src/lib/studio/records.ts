/**
 * The trusted record service: list, get, create, update and delete plugin records.
 *
 * A request carries only an installation ID, a collection name, a record ID where
 * one is needed, and data for writes. It can't carry a user, role, institution,
 * section, owner or version: the input schemas are strict, and every one of those
 * comes from resolveViewer. Not found and not permitted return the same message, so a
 * caller can't use it to probe which installations or records exist.
 *
 * Plain server module, not 'use server'. Callers are future server actions.
 */
import 'server-only'
import { z } from 'zod'
import { logEvent } from '@/lib/supabase/event-logger'
import { resolveViewer, type StudioViewer } from './context'
import * as db from './db'
import { STUDIO_RECORD_PAGE_MAX } from './limits'
import { decide, type RecordOperation } from './policy'
import { validateRecordData, type CollectionDef } from './record-schema'

export const RECORD_NOT_AVAILABLE = 'This isn’t available.'
const RECORD_FAILED = 'Something went wrong saving this. Try again.'
const RECORD_CONFLICT = 'Someone else changed this while you were editing. Reload and try again.'

/** What a plugin sees of a record. No user IDs (rule 2.1): `mine` says whether the
 * viewer owns or wrote it. */
export interface PluginRecord {
  id: string
  data: Record<string, unknown>
  mine: boolean
  createdAt: string
  updatedAt: string
}

export type RecordResult<T> = { ok: true; value: T } | { ok: false; error: string; issues?: string[] }

const collectionName = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/)
const target = { installationId: z.uuid(), collection: collectionName }

const listInput = z.strictObject({
  ...target,
  limit: z.number().int().min(1).max(STUDIO_RECORD_PAGE_MAX).optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
})
const getInput = z.strictObject({ ...target, recordId: z.uuid() })
const createInput = z.strictObject({ ...target, data: z.unknown() })
const updateInput = z.strictObject({ ...target, recordId: z.uuid(), data: z.unknown(), expectedUpdatedAt: z.string().max(64).optional() })
const deleteInput = getInput

export type ListRecordsInput = z.input<typeof listInput>
export type GetRecordInput = z.input<typeof getInput>
export type CreateRecordInput = z.input<typeof createInput>
export type UpdateRecordInput = z.input<typeof updateInput>
export type DeleteRecordInput = z.input<typeof deleteInput>

const denied = (): { ok: false; error: string } => ({ ok: false, error: RECORD_NOT_AVAILABLE })

interface Authorized {
  viewer: StudioViewer
  collection: CollectionDef
  scope: db.RecordScope
  ownerStamp: string | null
}

/** Steps 1 to 8: session, installation, role, current version, manifest, collection,
 * policy. Null for every refusal. */
async function authorize(installationId: string, name: string, operation: RecordOperation): Promise<Authorized | null> {
  const viewer = await resolveViewer(installationId)
  if (!viewer) return null
  // hasOwn, so a name like "constructor" can't resolve through the prototype.
  if (!Object.hasOwn(viewer.manifest.collections, name)) return null
  const collection = viewer.manifest.collections[name]

  const decision = decide(viewer.role, collection.access, operation, viewer.installationState)
  if (!decision.allow) return null

  return {
    viewer,
    collection,
    scope: {
      installationId: viewer.installationId,
      collection: name,
      owner: decision.ownerFilter === 'self' ? { only: viewer.userId } : 'any',
    },
    ownerStamp: decision.ownerStamp === 'self' ? viewer.userId : null,
  }
}

function toPlugin(row: db.RecordRow, viewer: StudioViewer): PluginRecord {
  return {
    id: row.id,
    data: row.data,
    mine: row.ownerId === viewer.userId || (row.ownerId === null && row.authorId === viewer.userId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Rule 3.5: every write is audited. The record's contents never go into the event. */
function audit(viewer: StudioViewer, operation: 'create' | 'update' | 'delete', collection: string, recordId: string) {
  logEvent({
    userId: viewer.userId,
    eventType: `studio.record.${operation}`,
    eventCategory: 'studio',
    sectionId: viewer.sectionId,
    metadata: { installationId: viewer.installationId, versionId: viewer.versionId, collection, recordId },
  })
}

export async function listRecords(input: ListRecordsInput): Promise<RecordResult<PluginRecord[]>> {
  const parsed = listInput.safeParse(input)
  if (!parsed.success) return denied()
  const auth = await authorize(parsed.data.installationId, parsed.data.collection, 'list')
  if (!auth) return denied()

  const rows = await db.listRecords(auth.scope, {
    limit: parsed.data.limit ?? STUDIO_RECORD_PAGE_MAX,
    offset: parsed.data.offset ?? 0,
  })
  if (!rows) return { ok: false, error: RECORD_FAILED }
  return { ok: true, value: rows.map((r) => toPlugin(r, auth.viewer)) }
}

export async function getRecord(input: GetRecordInput): Promise<RecordResult<PluginRecord>> {
  const parsed = getInput.safeParse(input)
  if (!parsed.success) return denied()
  const auth = await authorize(parsed.data.installationId, parsed.data.collection, 'get')
  if (!auth) return denied()

  const row = await db.getRecord(auth.scope, parsed.data.recordId)
  return row ? { ok: true, value: toPlugin(row, auth.viewer) } : denied()
}

export async function createRecord(input: CreateRecordInput): Promise<RecordResult<PluginRecord>> {
  const parsed = createInput.safeParse(input)
  if (!parsed.success) return denied()
  const auth = await authorize(parsed.data.installationId, parsed.data.collection, 'create')
  if (!auth) return denied()

  const valid = validateRecordData(auth.viewer.versionId, parsed.data.collection, auth.collection, parsed.data.data)
  if (!valid.ok) return { ok: false, error: 'This record doesn’t match its collection.', issues: valid.issues }

  const { viewer } = auth
  const saved = await db.insertRecord(
    {
      institutionId: viewer.institutionId,
      sectionId: viewer.sectionId,
      installationId: viewer.installationId,
      versionId: viewer.versionId,
      collection: parsed.data.collection,
      ownerId: auth.ownerStamp,
      authorId: viewer.userId,
    },
    valid.data,
  )
  if (!saved.ok) return { ok: false, error: RECORD_FAILED }
  audit(viewer, 'create', parsed.data.collection, saved.value.id)
  return { ok: true, value: toPlugin(saved.value, viewer) }
}

export async function updateRecord(input: UpdateRecordInput): Promise<RecordResult<PluginRecord>> {
  const parsed = updateInput.safeParse(input)
  if (!parsed.success) return denied()
  const auth = await authorize(parsed.data.installationId, parsed.data.collection, 'update')
  if (!auth) return denied()

  const valid = validateRecordData(auth.viewer.versionId, parsed.data.collection, auth.collection, parsed.data.data)
  if (!valid.ok) return { ok: false, error: 'This record doesn’t match its collection.', issues: valid.issues }

  const saved = await db.updateRecord(auth.scope, parsed.data.recordId, {
    data: valid.data,
    versionId: auth.viewer.versionId,
    expectedUpdatedAt: parsed.data.expectedUpdatedAt,
  })
  if (!saved.ok) return { ok: false, error: RECORD_FAILED }
  if (!saved.value) {
    // Zero rows: missing, outside the viewer's scope, or changed by someone else.
    // Re-read in the same scope, so a conflict is reported only on a record the
    // viewer can already see.
    const stillThere = parsed.data.expectedUpdatedAt && (await db.getRecord(auth.scope, parsed.data.recordId))
    return stillThere ? { ok: false, error: RECORD_CONFLICT } : denied()
  }
  audit(auth.viewer, 'update', parsed.data.collection, saved.value.id)
  return { ok: true, value: toPlugin(saved.value, auth.viewer) }
}

export async function deleteRecord(input: DeleteRecordInput): Promise<RecordResult<null>> {
  const parsed = deleteInput.safeParse(input)
  if (!parsed.success) return denied()
  const auth = await authorize(parsed.data.installationId, parsed.data.collection, 'delete')
  if (!auth) return denied()

  const removed = await db.deleteRecord(auth.scope, parsed.data.recordId)
  if (!removed.ok) return { ok: false, error: RECORD_FAILED }
  if (!removed.value) return denied()
  audit(auth.viewer, 'delete', parsed.data.collection, parsed.data.recordId)
  return { ok: true, value: null }
}
