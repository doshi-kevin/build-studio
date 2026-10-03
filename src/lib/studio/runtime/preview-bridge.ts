/**
 * The preview bridge (rule 8.3): what a plugin talks to when a professor previews it,
 * for example as a student. It lives entirely in the host page, in memory. It never
 * calls /api/studio/bridge or any network, never writes a Studio record, and never
 * touches whether the plugin is published.
 *
 * It answers the same methods as the real bridge, with the same shapes, in the same
 * order as dispatch.ts (catalog, view and capability, strict arguments), applying the
 * same pure policy (policy.ts) and the same record validation (record-schema.ts) to
 * synthetic data, so a plugin behaves in preview the way it will for real.
 *
 * The class is the fixed synthetic roster (preview-roster.ts). Records come from the
 * builder's sample data when there is some (docs/designs/studio/studio-builder-quality.md
 * 3.7), and otherwise from placeholders chosen by field name.
 */
import { methodAllowed, methodSpec, parseMethodArgs, type MethodArgs, type ServerMethodName } from '../bridge/catalog'
import type { StudioManifest } from '../manifest'
import { decide, type RecordOperation, type ViewerRole } from '../policy'
import { STUDIO_RECORD_PAGE_MAX } from '../limits'
import { validateRecordData, type CollectionDef } from '../record-schema'
import type { RequestResult } from './host'
import { PREVIEW_ROSTER, PREVIEW_VIEWER_STUDENT } from './preview-roster'
import type { PluginView } from './protocol'

/** The builder's write_sample_data, by collection. `student` indexes PREVIEW_ROSTER and is
 * set exactly for perStudent and staffPerStudent records. */
export type PreviewSample = Record<string, { student?: number; data: Record<string, unknown> }[]>

interface PreviewRecord {
  id: string
  data: Record<string, unknown>
  /** The synthetic student it belongs to, for perStudent and staffPerStudent. */
  owner: number | null
  /** Written by the previewing viewer: what `mine` means for a record nobody owns. */
  byViewer: boolean
  createdAt: string
  updatedAt: string
}

const NOT_AVAILABLE = { ok: false, code: 'not_available', message: 'This isn’t available.' } as const
const UNSUPPORTED: RequestResult = { ok: false, code: 'unsupported', message: 'This tool asked for something Scholera doesn’t offer.' }
const INVALID = { ok: false, code: 'invalid', message: 'This request’s arguments aren’t valid.' } as const
const CONFLICT = { ok: false, code: 'conflict', message: 'Someone else changed this while you were editing. Reload and try again.' } as const

const OWNED = new Set(['perStudent', 'staffPerStudent'])
const DAY_MS = 86_400_000

// ── Placeholders, when the builder wrote no sample data ──────────────

const pick = <T>(list: readonly T[], n: number) => list[n % list.length]
const isoDay = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10)

/** By field name, first match wins. Plausible values make a preview read like the tool in
 * use; "Sample text 1" made every tool look unfinished. */
const TEXT_GUESSES: [RegExp, (n: number) => string][] = [
  [/date|day|due|deadline/i, (n) => isoDay(n * 2)],
  [/time/i, (n) => pick(['09:30', '11:00', '14:15'], n)],
  [/status|state/i, (n) => pick(['present', 'late', 'absent'], n)],
  [/title|topic|subject|name|heading/i, (n) => pick(['Photosynthesis', 'Supply and demand', 'Newton’s second law', 'The Treaty of Versailles'], n)],
  [/question|prompt/i, (n) => pick(['What limits the rate of photosynthesis?', 'Why does price fall when supply rises?', 'What happens to acceleration if mass doubles?'], n)],
  [/note|comment|feedback|reflection|answer|response|summary|description|reason|text|body|message/i, (n) =>
    pick([
      'Clear explanation, and the worked example helped.',
      'I followed most of it but got lost at the second graph.',
      'Would like one more practice problem before the quiz.',
    ], n)],
  [/categor|type|kind|tag|group/i, (n) => pick(['Reading', 'Lab', 'Discussion'], n)],
  [/grade|letter/i, (n) => pick(['A-', 'B+', 'A'], n)],
]
const NUMBER_GUESSES: [RegExp, (n: number) => number][] = [
  [/percent|pct|rate/i, (n) => pick([82, 67, 95], n)],
  [/confidence|rating|level|stars|difficulty/i, (n) => pick([4, 2, 5, 3], n)],
  [/score|points|mark|grade/i, (n) => pick([8, 6, 9], n)],
  [/minutes|duration|time/i, (n) => pick([25, 40, 15], n)],
  [/week/i, (n) => n + 1],
]

const words = (field: string) => field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()

function placeholder(field: string, type: CollectionDef['fields'][string], n: number): unknown {
  if (type === 'boolean') return n % 2 === 0
  if (type === 'number') return (NUMBER_GUESSES.find(([re]) => re.test(field))?.[1] ?? ((i: number) => pick([3, 7, 5], i)))(n)
  const guess = TEXT_GUESSES.find(([re]) => re.test(field))?.[1]
  if (guess) return guess(n)
  const label = words(field)
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} ${n + 1}`
}

function stamp(n: number) {
  // Spread over the last few days, newest first, so dates and orderings look real.
  const at = new Date(Date.now() - n * 5 * 3_600_000).toISOString()
  return { id: crypto.randomUUID(), createdAt: at, updatedAt: at }
}

function placeholderRecords(collection: CollectionDef, view: PluginView): PreviewRecord[] {
  const owned = OWNED.has(collection.access)
  // Owned collections get the viewer's own record and two classmates', so a student-view
  // preview shows that other students' records stay hidden.
  return [0, 1, 2].map((n) => ({
    ...stamp(n),
    data: Object.fromEntries(Object.entries(collection.fields).map(([field, type]) => [field, placeholder(field, type, n)])),
    owner: owned ? n : null,
    byViewer: !owned && view === 'professor',
  }))
}

const rosterIndex = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < PREVIEW_ROSTER.length ? v : null

function sampleRecords(name: string, collection: CollectionDef, list: PreviewSample[string], view: PluginView): PreviewRecord[] {
  const owned = OWNED.has(collection.access)
  const out: PreviewRecord[] = []
  for (const [n, item] of list.entries()) {
    // The builder validated it; checked again because this runs on whatever the page was given.
    const valid = validateRecordData('preview-sample', name, collection, item.data)
    const owner = owned ? rosterIndex(item.student) : null
    if (!valid.ok || (owned && owner === null)) continue
    out.push({ ...stamp(n), data: valid.data, owner, byViewer: !owned && view === 'professor' })
  }
  return out
}

// ── course.assignments ───────────────────────────────────────────────

function sampleAssignments() {
  const due = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString()
  return [
    { title: 'Problem set 3', dueAt: due(-4), points: 20 },
    { title: 'Lab 2 write-up', dueAt: due(3), points: 30 },
    { title: 'Reading response 5', dueAt: due(6), points: 10 },
    { title: 'Midterm project proposal', dueAt: due(13), points: 50 },
    { title: 'Weekly reflection', dueAt: null, points: null },
  ]
}

export interface PreviewBridge {
  handleRequest(method: string, args: unknown): Promise<RequestResult>
}

export interface PreviewOptions {
  /** The draft's sample data. Without it, every collection gets placeholders. */
  sample?: PreviewSample | null
}

export function createPreviewBridge(manifest: StudioManifest, view: PluginView, options: PreviewOptions = {}): PreviewBridge {
  // Staff preview the professor view as a professor; the student view as student 0.
  const role: ViewerRole = view === 'student' ? 'student' : 'professor'
  const sample = options.sample ?? null
  const store = new Map(
    Object.entries(manifest.collections).map(([name, c]) => [
      name,
      sample ? sampleRecords(name, c, Object.hasOwn(sample, name) ? sample[name] : [], view) : placeholderRecords(c, view),
    ]),
  )
  const handles = new Map(PREVIEW_ROSTER.map((s, i) => [s.handle, i]))

  function scope(name: string, operation: RecordOperation) {
    if (!Object.hasOwn(manifest.collections, name)) return null
    const collection = manifest.collections[name]
    const decision = decide(role, collection.access, operation, 'writable')
    if (!decision.allow) return null
    const rows = store.get(name)!
    const visible = decision.ownerFilter === 'self' ? rows.filter((r) => r.owner === PREVIEW_VIEWER_STUDENT) : rows
    return { name, collection, rows, visible }
  }

  const strip = (collection: CollectionDef) => ({ id, data, owner, byViewer, createdAt, updatedAt }: PreviewRecord) => ({
    id,
    data,
    mine: role === 'student' ? owner === PREVIEW_VIEWER_STUDENT || (owner === null && byViewer) : owner === null && byViewer,
    createdAt,
    updatedAt,
    // Staff see whom an owned record is about, as a handle. Students never see a handle.
    ...(role !== 'student' && OWNED.has(collection.access) && owner !== null ? { student: PREVIEW_ROSTER[owner].handle } : {}),
  })

  const invalidData = (issues: string[]) =>
    ({ ok: false, code: 'invalid', message: 'This record doesn’t match its collection.', issues }) as const

  function create(name: string, data: unknown, student: string | undefined): RequestResult {
    const s = scope(name, 'create')
    if (!s) return NOT_AVAILABLE
    // `student` names whom a staffPerStudent record is about, and nothing else (3.1).
    const aboutStudent = role !== 'student' && s.collection.access === 'staffPerStudent'
    if (aboutStudent !== (student !== undefined)) return INVALID
    const owner = aboutStudent ? handles.get(student!) : role === 'student' && OWNED.has(s.collection.access) ? PREVIEW_VIEWER_STUDENT : null
    if (owner === undefined) return NOT_AVAILABLE
    const valid = validateRecordData('preview', s.name, s.collection, data)
    if (!valid.ok) return invalidData(valid.issues)
    const now = new Date().toISOString()
    const row: PreviewRecord = { id: crypto.randomUUID(), data: valid.data, owner, byViewer: true, createdAt: now, updatedAt: now }
    s.rows.unshift(row)
    return { ok: true, data: strip(s.collection)(row) }
  }

  function update(name: string, recordId: string, data: unknown, expectedUpdatedAt: string | undefined): RequestResult {
    const s = scope(name, 'update')
    const row = s?.visible.find((r) => r.id === recordId)
    if (!s || !row) return NOT_AVAILABLE
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== row.updatedAt) return CONFLICT
    const valid = validateRecordData('preview', s.name, s.collection, data)
    if (!valid.ok) return invalidData(valid.issues)
    row.data = valid.data
    row.updatedAt = new Date().toISOString()
    return { ok: true, data: strip(s.collection)(row) }
  }

  function remove(name: string, recordId: string): RequestResult {
    const s = scope(name, 'delete')
    const index = s ? s.rows.findIndex((r) => r.id === recordId && s.visible.includes(r)) : -1
    if (!s || index < 0) return NOT_AVAILABLE
    s.rows.splice(index, 1)
    return { ok: true, data: null }
  }

  const BATCH_CODES = new Set(['not_available', 'invalid', 'conflict', 'full', 'failed'])

  // Arguments arrive parsed by the method's catalog schema, as the server's handlers get them.
  const handlers: { [K in ServerMethodName]?: (args: MethodArgs<K>) => RequestResult } = {
    'context.get': () => {
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
    'course.roster': () => ({ ok: true, data: { students: PREVIEW_ROSTER.map((s) => ({ handle: s.handle })).sort((a, b) => (a.handle < b.handle ? -1 : 1)) } }),
    'course.assignments': () => ({ ok: true, data: { assignments: sampleAssignments() } }),
    'records.list': (a) => {
      const s = scope(a.collection, 'list')
      if (!s) return NOT_AVAILABLE
      const offset = a.offset ?? 0
      return { ok: true, data: s.visible.slice(offset, offset + (a.limit ?? STUDIO_RECORD_PAGE_MAX)).map(strip(s.collection)) }
    },
    'records.get': (a) => {
      const s = scope(a.collection, 'get')
      const row = s?.visible.find((r) => r.id === a.recordId)
      return s && row ? { ok: true, data: strip(s.collection)(row) } : NOT_AVAILABLE
    },
    'records.create': (a) => create(a.collection, a.data, a.student),
    'records.update': (a) => update(a.collection, a.recordId, a.data, a.expectedUpdatedAt),
    'records.delete': (a) => remove(a.collection, a.recordId),
    'records.batch': (a) => {
      const results = a.items.map((item) => {
        const result =
          item.op === 'create'
            ? create(a.collection, item.data, item.student)
            : item.op === 'update'
              ? update(a.collection, item.recordId, item.data, item.expectedUpdatedAt)
              : remove(a.collection, item.recordId)
        if (result.ok) return { ok: true, record: result.data ?? null }
        return { ok: false, code: BATCH_CODES.has(result.code) ? result.code : 'failed' }
      })
      return { ok: true, data: { results } }
    },
  }

  return {
    async handleRequest(method, args) {
      const spec = methodSpec(method)
      const handler = spec?.runs === 'server' && Object.hasOwn(handlers, method) ? handlers[method as ServerMethodName] : undefined
      if (!spec || !handler) return UNSUPPORTED
      if (!methodAllowed(spec, manifest, view)) return NOT_AVAILABLE
      const parsed = parseMethodArgs(spec, args)
      if (!parsed.ok) return INVALID
      // The catalog's schema produced these arguments for exactly this handler (as dispatch.ts).
      return (handler as (a: unknown) => RequestResult)(parsed.args)
    },
  }
}
