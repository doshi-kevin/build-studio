/**
 * Turns a manifest collection into the Zod schema its records must match. Pure, so
 * it is unit-tested on its own; the record service calls it before every write.
 */
import { z } from 'zod'
import { STUDIO_RECORD_MAX_BYTES } from './limits'
import type { StudioManifest } from './manifest'

export type CollectionDef = StudioManifest['collections'][string]

// Manifest v1 has no optional fields and no null, so every field is required as-is.
const FIELD_SCHEMAS = {
  text: () => z.string().max(STUDIO_RECORD_MAX_BYTES),
  number: () => z.number().finite(),
  boolean: () => z.boolean(),
} as const

export function compileRecordSchema(collection: CollectionDef) {
  const shape = Object.fromEntries(Object.entries(collection.fields).map(([name, type]) => [name, FIELD_SCHEMAS[type]()]))
  return z.strictObject(shape)
}

// Versions are immutable, so a schema compiled for (version, collection) never goes
// stale. The cap only bounds memory.
const cache = new Map<string, ReturnType<typeof compileRecordSchema>>()
const CACHE_MAX = 500

function schemaFor(versionId: string, name: string, collection: CollectionDef) {
  const key = `${versionId}:${name}`
  let schema = cache.get(key)
  if (!schema) {
    if (cache.size >= CACHE_MAX) cache.clear()
    schema = compileRecordSchema(collection)
    cache.set(key, schema)
  }
  return schema
}

export type RecordDataResult = { ok: true; data: Record<string, unknown> } | { ok: false; issues: string[] }

export function validateRecordData(
  versionId: string,
  name: string,
  collection: CollectionDef,
  raw: unknown,
): RecordDataResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: ['Record data must be an object'] }
  }
  const proto = Object.getPrototypeOf(raw)
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, issues: ['Record data must be a plain object'] }
  }
  // Checked on the raw keys: z.strictObject accepts an own "__proto__" key (the kind
  // JSON.parse creates) without reporting it.
  const unknownKeys = Object.keys(raw).filter((key) => !Object.hasOwn(collection.fields, key))
  if (unknownKeys.length) {
    return { ok: false, issues: unknownKeys.map((key) => `${key}: not a field of ${name}`) }
  }

  const result = schemaFor(versionId, name, collection).safeParse(raw)
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message)),
    }
  }
  // After the schema, so an oversized string fails its own length check first and is
  // never stringified.
  if (new TextEncoder().encode(JSON.stringify(result.data)).length > STUDIO_RECORD_MAX_BYTES) {
    return { ok: false, issues: [`Record is larger than ${STUDIO_RECORD_MAX_BYTES / 1024} KiB`] }
  }
  return { ok: true, data: result.data }
}
