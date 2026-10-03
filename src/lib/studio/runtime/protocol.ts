/**
 * The Scholera Bridge envelope, version 1. Pure and dependency-free, because it runs in
 * the browser (the host) and in tests. The runtimes inside the frame speak the same
 * shapes from public/studio-runtime/{v1,v2}/runtime.js. Contract:
 * docs/reference/studio-plugin-runtime.md; v2's roster and size messages:
 * docs/designs/studio/studio-builder-quality.md 3.4.
 *
 * The envelope's `v` stays 1: it versions these message shapes, while the runtime
 * version (hello/welcome) says which of them a frame may send. v2 adds `roster` and
 * `size` from the frame and `event` from the host; the host accepts them only from a
 * frame whose hello said v2.
 *
 * Everything that arrives from a frame is untrusted. parseFrameMessage is the only way
 * a frame message becomes typed data.
 */
import { ROSTER_LIMITS } from './roster-layout'

/** Runtimes the platform serves. Older ones stay served (rule 8.7). */
export const BRIDGE_VERSIONS = ['v1', 'v2'] as const
export type RuntimeVersion = (typeof BRIDGE_VERSIONS)[number]

export const isSupportedRuntime = (runtime: string): runtime is RuntimeVersion =>
  (BRIDGE_VERSIONS as readonly string[]).includes(runtime)

export type PluginView = 'student' | 'professor'

export type RosterTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export type RosterCell =
  | { kind: 'text'; text: string }
  | { kind: 'badge'; text: string; tone: RosterTone }
  | { kind: 'choice'; value: string | null; options: { value: string; label: string; tone: RosterTone }[] }
  | { kind: 'select'; value: string | null; placeholder: string; options: { value: string; label: string }[] }
  | { kind: 'button'; label: string; value: string; variant: 'primary' | 'secondary' | 'danger' }

/** A RosterTable as the plugin describes it: handles and cells, never names. */
export interface RosterPayload {
  label: string
  sort: 'name' | 'given'
  searchable: boolean
  columns: { key: string; header: string }[]
  rows: { student: string; cells: Record<string, RosterCell> }[]
  emptyText: string
}

/** The placeholder's box in the frame's viewport, in CSS px. */
export interface RosterRect {
  x: number
  y: number
  width: number
  height: number
}

/** What the plugin learns when the professor uses a roster control. */
export interface RosterAction {
  slot: string
  student: string
  column: string
  value: string
}

export type FrameMessage =
  | { type: 'hello'; runtime: string }
  | { type: 'request'; session: string; id: string; method: string; args: unknown }
  | { type: 'crash'; session: string; message: string }
  | { type: 'roster'; session: string; op: 'render'; slot: string; payload: RosterPayload }
  | { type: 'roster'; session: string; op: 'place'; slot: string; rect: RosterRect }
  | { type: 'roster'; session: string; op: 'remove'; slot: string }
  | { type: 'size'; session: string; height: number }

/** What the plugin learns in the handshake. No user, section, institution or
 * installation IDs ever go here (rule 2.5). */
export interface WelcomeContext {
  runtime: RuntimeVersion
  view: PluginView
  theme: 'light'
}

/** `unavailable`: this viewer can't use this installation at all any more (hidden,
 * Studio switched off, release gate closed, or it never existed: one answer for all, so
 * it reveals nothing). The host stops the frame. `full`: the installation's storage
 * quota refused a write. */
export type BridgeErrorCode =
  | 'not_available'
  | 'invalid'
  | 'conflict'
  | 'rate_limited'
  | 'unsupported'
  | 'failed'
  | 'stale'
  | 'unavailable'
  | 'full'

/** What the host's status heartbeat learns about its frame. */
export type FrameStatus = 'available' | 'readOnly' | 'unavailable' | 'stale'

export type HostMessage =
  | { type: 'welcome'; session: string; context: WelcomeContext }
  | { type: 'response'; session: string; id: string; ok: true; data: unknown }
  | { type: 'response'; session: string; id: string; ok: false; error: { code: BridgeErrorCode; message: string; issues?: string[] } }
  | { type: 'event'; session: string; name: 'roster.action'; data: RosterAction }

const SESSION = /^[0-9a-f-]{36}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const METHOD = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/
/** A student handle, as catalog.ts STUDENT_HANDLE (handles.ts). Repeated here because this file is dependency-free. */
const HANDLE = /^st_[0-9a-v]{20}$/
const VALUE_MAX = ROSTER_LIMITS.value
/** A full 500-row roster with four choice columns stays well under this. */
export const ROSTER_PAYLOAD_MAX_BYTES = 512 * 1024
const COORD_MAX = 100_000

function sizeOf(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length
  } catch {
    return Number.POSITIVE_INFINITY // cyclic or otherwise unserializable
  }
}

// ── Strict roster parse: exact keys, bounded strings, nothing else ──

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
/** Exactly these keys (all required), so a payload can't smuggle fields the host would ignore today and read tomorrow. */
const keysAre = (o: Obj, keys: readonly string[]) => {
  const own = Object.keys(o)
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k))
}
const str = (v: unknown, max: number, min = 0): v is string => typeof v === 'string' && v.length >= min && v.length <= max
const TONES: readonly string[] = ['neutral', 'info', 'success', 'warning', 'danger']
const isTone = (v: unknown): v is RosterTone => typeof v === 'string' && TONES.includes(v)
const optionalValue = (v: unknown) => v === null || str(v, VALUE_MAX)
const allParsed = <T>(list: (T | null)[]): list is T[] => list.every((x) => x !== null)

function parseCell(v: unknown): RosterCell | null {
  if (!isObj(v)) return null
  switch (v.kind) {
    case 'text':
      return keysAre(v, ['kind', 'text']) && str(v.text, ROSTER_LIMITS.text) ? { kind: 'text', text: v.text } : null
    case 'badge':
      return keysAre(v, ['kind', 'text', 'tone']) && str(v.text, ROSTER_LIMITS.badge) && isTone(v.tone) ? { kind: 'badge', text: v.text, tone: v.tone } : null
    case 'choice': {
      const { min, max } = ROSTER_LIMITS.choiceOptions
      if (!keysAre(v, ['kind', 'value', 'options']) || !optionalValue(v.value) || !Array.isArray(v.options)) return null
      if (v.options.length < min || v.options.length > max) return null
      const options = v.options.map((o) =>
        isObj(o) && keysAre(o, ['value', 'label', 'tone']) && str(o.value, VALUE_MAX, 1) && str(o.label, ROSTER_LIMITS.optionLabel, 1) && isTone(o.tone)
          ? { value: o.value, label: o.label, tone: o.tone }
          : null,
      )
      return allParsed(options) ? { kind: 'choice', value: v.value as string | null, options } : null
    }
    case 'select': {
      if (!keysAre(v, ['kind', 'value', 'placeholder', 'options']) || !optionalValue(v.value) || !str(v.placeholder, ROSTER_LIMITS.selectPlaceholder)) return null
      if (!Array.isArray(v.options) || v.options.length < 1 || v.options.length > ROSTER_LIMITS.selectOptions) return null
      const options = v.options.map((o) =>
        isObj(o) && keysAre(o, ['value', 'label']) && str(o.value, VALUE_MAX, 1) && str(o.label, ROSTER_LIMITS.optionLabel, 1) ? { value: o.value, label: o.label } : null,
      )
      return allParsed(options) ? { kind: 'select', value: v.value as string | null, placeholder: v.placeholder, options } : null
    }
    case 'button':
      return keysAre(v, ['kind', 'label', 'value', 'variant']) &&
        str(v.label, ROSTER_LIMITS.buttonLabel, 1) &&
        str(v.value, VALUE_MAX, 1) &&
        (v.variant === 'primary' || v.variant === 'secondary' || v.variant === 'danger')
        ? { kind: 'button', label: v.label, value: v.value, variant: v.variant }
        : null
    default:
      return null
  }
}

/** A RosterPayload exactly as 3.4 defines it, or null. Duplicate column keys or students,
 * and cells for columns that don't exist, are refused rather than guessed at. */
export function parseRosterPayload(v: unknown): RosterPayload | null {
  if (!isObj(v) || !keysAre(v, ['label', 'sort', 'searchable', 'columns', 'rows', 'emptyText'])) return null
  if (!str(v.label, ROSTER_LIMITS.label, 1) || (v.sort !== 'name' && v.sort !== 'given') || typeof v.searchable !== 'boolean') return null
  if (!str(v.emptyText, ROSTER_LIMITS.emptyText)) return null
  if (!Array.isArray(v.columns) || v.columns.length > ROSTER_LIMITS.columns) return null
  if (!Array.isArray(v.rows) || v.rows.length > ROSTER_LIMITS.rows) return null

  const columns: RosterPayload['columns'] = []
  for (const c of v.columns) {
    if (!isObj(c) || !keysAre(c, ['key', 'header']) || typeof c.key !== 'string' || !ROSTER_LIMITS.columnKey.test(c.key)) return null
    if (!str(c.header, ROSTER_LIMITS.header, 1) || columns.some((x) => x.key === c.key)) return null
    columns.push({ key: c.key, header: c.header })
  }
  const keys = new Set(columns.map((c) => c.key))
  const seen = new Set<string>()
  const rows: RosterPayload['rows'] = []
  for (const r of v.rows) {
    if (!isObj(r) || !keysAre(r, ['student', 'cells']) || typeof r.student !== 'string' || !HANDLE.test(r.student) || seen.has(r.student)) return null
    if (!isObj(r.cells)) return null
    seen.add(r.student)
    const cells: Record<string, RosterCell> = {}
    for (const [key, raw] of Object.entries(r.cells)) {
      const cell = keys.has(key) ? parseCell(raw) : null
      if (!cell) return null
      cells[key] = cell
    }
    rows.push({ student: r.student, cells })
  }
  return { label: v.label, sort: v.sort, searchable: v.searchable, columns, rows, emptyText: v.emptyText }
}

const coord = (v: unknown, min: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= COORD_MAX

function parseRect(v: unknown): RosterRect | null {
  if (!isObj(v) || !keysAre(v, ['x', 'y', 'width', 'height'])) return null
  if (!coord(v.x, -COORD_MAX) || !coord(v.y, -COORD_MAX) || !coord(v.width, 0) || !coord(v.height, 0)) return null
  return { x: v.x as number, y: v.y as number, width: v.width as number, height: v.height as number }
}

function parseRoster(m: Obj, session: string): FrameMessage | null {
  if (typeof m.slot !== 'string' || !ROSTER_LIMITS.slot.test(m.slot)) return null
  if (m.op === 'render') {
    if (sizeOf(m.payload) > ROSTER_PAYLOAD_MAX_BYTES) return null
    const payload = parseRosterPayload(m.payload)
    return payload ? { type: 'roster', session, op: 'render', slot: m.slot, payload } : null
  }
  if (m.op === 'place') {
    const rect = parseRect(m.rect)
    return rect ? { type: 'roster', session, op: 'place', slot: m.slot, rect } : null
  }
  return m.op === 'remove' ? { type: 'roster', session, op: 'remove', slot: m.slot } : null
}

/** A frame message, or null for anything that isn't exactly one of the known shapes.
 * Whether this frame's runtime may send it is the host's decision. */
export function parseFrameMessage(data: unknown, maxBytes: number): FrameMessage | null {
  if (!isObj(data)) return null
  const m = data
  if (m.scholera !== 'bridge' || m.v !== 1) return null

  if (m.type === 'hello') {
    return typeof m.runtime === 'string' && m.runtime.length <= 16 ? { type: 'hello', runtime: m.runtime } : null
  }
  if (typeof m.session !== 'string' || !SESSION.test(m.session)) return null

  if (m.type === 'request') {
    if (typeof m.id !== 'string' || !REQUEST_ID.test(m.id)) return null
    if (typeof m.method !== 'string' || m.method.length > 64 || !METHOD.test(m.method)) return null
    if (sizeOf(m.args) > maxBytes) return null
    return { type: 'request', session: m.session, id: m.id, method: m.method, args: m.args }
  }
  if (m.type === 'crash') {
    return typeof m.message === 'string' ? { type: 'crash', session: m.session, message: m.message.slice(0, 500) } : null
  }
  if (m.type === 'roster') return parseRoster(m, m.session)
  if (m.type === 'size') {
    return coord(m.height, 0) ? { type: 'size', session: m.session, height: m.height as number } : null
  }
  return null
}

/** Adds the envelope header to a host message. */
export const envelope = (message: HostMessage) => ({ scholera: 'bridge' as const, v: 1 as const, ...message })
