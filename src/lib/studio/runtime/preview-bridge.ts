/**
 * The preview bridge (rule 8.3): what a plugin talks to when a professor previews it,
 * for example as a student. It lives entirely in the host page, in memory. It never
 * calls /api/studio/bridge or any network, never writes a Studio record, and never
 * touches whether the plugin is published.
 *
 * It answers the same methods as the real bridge, with the same shapes, applying the
 * same pure policy (policy.ts) and the same record validation (record-schema.ts) to
 * sample data, so a plugin behaves in preview the way it will for real.
 */
import type { StudioManifest } from '../manifest'
import { decide, type RecordOperation, type ViewerRole } from '../policy'
import { validateRecordData, type CollectionDef } from '../record-schema'
import type { RequestResult } from './host'
import type { PluginView } from './protocol'

interface PreviewRecord {
  id: string
  data: Record<string, unknown>
  /** Owned or written by the previewing viewer. Others belong to "another student". */
  mine: boolean
  createdAt: string
  updatedAt: string
}

const NOT_AVAILABLE: RequestResult = { ok: false, code: 'not_available', message: 'This isn’t available.' }
const UNSUPPORTED: RequestResult = { ok: false, code: 'unsupported', message: 'This tool asked for something Scholera doesn’t offer.' }
const INVALID: RequestResult = { ok: false, code: 'invalid', message: 'This request’s arguments aren’t valid.' }

const SAMPLE_VALUE = { text: (n: number) => `Sample text ${n}`, number: (n: number) => n, boolean: (n: number) => n % 2 === 0 } as const

function sampleRecords(collection: CollectionDef): PreviewRecord[] {
  const now = new Date().toISOString()
  // One record of the viewer's own and one of someone else's, so a student-view preview
  // shows that other students' perStudent records stay hidden.
  return [1, 2].map((n) => ({
    id: crypto.randomUUID(),
    data: Object.fromEntries(Object.entries(collection.fields).map(([field, type]) => [field, SAMPLE_VALUE[type](n)])),
    mine: n === 1,
    createdAt: now,
    updatedAt: now,
  }))
}

type Args = Record<string, unknown>
const isArgs = (a: unknown): a is Args => a !== null && typeof a === 'object' && !Array.isArray(a)

export interface PreviewBridge {
  handleRequest(method: string, args: unknown): Promise<RequestResult>
}

export function createPreviewBridge(manifest: StudioManifest, view: PluginView, versionKey = 'preview'): PreviewBridge {
  // Staff preview the professor view as a professor; the student view as a student.
  const role: ViewerRole = view === 'student' ? 'student' : 'professor'
  const store = new Map(Object.entries(manifest.collections).map(([name, c]) => [name, sampleRecords(c)]))
  const declared = new Set<string>(manifest.views[view].capabilities)

  function scope(name: unknown, operation: RecordOperation) {
    if (typeof name !== 'string' || !Object.hasOwn(manifest.collections, name)) return null
    const collection = manifest.collections[name]
    const decision = decide(role, collection.access, operation, 'writable')
    if (!decision.allow) return null
    const rows = store.get(name)!
    const visible = decision.ownerFilter === 'self' ? rows.filter((r) => r.mine) : rows
    return { name, collection, rows, visible }
  }

  const strip = ({ id, data, mine, createdAt, updatedAt }: PreviewRecord) => ({ id, data, mine, createdAt, updatedAt })

  const handlers: Record<string, (args: Args) => RequestResult> = {
    'context.get': () => {
      if (!declared.has('context.get')) return NOT_AVAILABLE
      const can = Object.fromEntries(
        Object.entries(manifest.collections).map(([name, c]) => [
          name,
          { read: decide(role, c.access, 'list', 'writable').allow, write: decide(role, c.access, 'create', 'writable').allow },
        ]),
      )
      const options = Intl.DateTimeFormat().resolvedOptions()
      return {
        ok: true,
        data: {
          plugin: { name: manifest.name, version: manifest.version },
          view,
          theme: 'light',
          locale: options.locale,
          timeZone: options.timeZone,
          course: { code: 'PREVIEW', title: 'Preview course' },
          readOnly: false,
          can,
          preview: true,
        },
      }
    },
    'records.list': (a) => {
      const s = scope(a.collection, 'list')
      return s ? { ok: true, data: s.visible.map(strip) } : NOT_AVAILABLE
    },
    'records.get': (a) => {
      const row = scope(a.collection, 'get')?.visible.find((r) => r.id === a.recordId)
      return row ? { ok: true, data: strip(row) } : NOT_AVAILABLE
    },
    'records.create': (a) => {
      const s = scope(a.collection, 'create')
      if (!s) return NOT_AVAILABLE
      const valid = validateRecordData(versionKey, s.name, s.collection, a.data)
      if (!valid.ok) return { ok: false, code: 'invalid', message: 'This record doesn’t match its collection.', issues: valid.issues }
      const now = new Date().toISOString()
      const row = { id: crypto.randomUUID(), data: valid.data, mine: true, createdAt: now, updatedAt: now }
      s.rows.unshift(row)
      return { ok: true, data: strip(row) }
    },
    'records.update': (a) => {
      const s = scope(a.collection, 'update')
      const row = s?.visible.find((r) => r.id === a.recordId)
      if (!s || !row) return NOT_AVAILABLE
      const valid = validateRecordData(versionKey, s.name, s.collection, a.data)
      if (!valid.ok) return { ok: false, code: 'invalid', message: 'This record doesn’t match its collection.', issues: valid.issues }
      row.data = valid.data
      row.updatedAt = new Date().toISOString()
      return { ok: true, data: strip(row) }
    },
    'records.delete': (a) => {
      const s = scope(a.collection, 'delete')
      const index = s ? s.rows.findIndex((r) => r.id === a.recordId && s.visible.includes(r)) : -1
      if (!s || index < 0) return NOT_AVAILABLE
      s.rows.splice(index, 1)
      return { ok: true, data: null }
    },
  }

  return {
    async handleRequest(method, args) {
      if (!Object.hasOwn(handlers, method)) return UNSUPPORTED
      const normalized = args === null || args === undefined ? {} : args
      if (!isArgs(normalized)) return INVALID
      return handlers[method](normalized)
    },
  }
}
