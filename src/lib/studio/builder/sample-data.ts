/**
 * write_sample_data: the synthetic records a draft's preview and design review show. Pure.
 *
 * Sample data is model-written, so it is held to the same rules as code: every record must
 * match its collection exactly (record-schema.ts), and the draft gate runs the student-name
 * and course-material checks over its text. It never reaches a published version: the
 * validator and students use their own data. `student` indexes the preview's fixed synthetic
 * roster; it is how a perStudent or staffPerStudent record says whose it is without a name.
 */
import { STUDIO_BUILDER_SAMPLE_MAX_BYTES, STUDIO_BUILDER_SAMPLE_MAX_RECORDS } from '../limits'
import type { StudioManifestV2 } from '../manifest'
import { validateRecordData } from '../record-schema'
import { PREVIEW_ROSTER } from '../runtime/preview-roster'
import { characterProblem, utf8Bytes } from './paths'
import type { SampleData } from './work'

export type SampleResult = { ok: true; sample: SampleData; records: number } | { ok: false; issues: string[] }

const OWNED = new Set(['perStudent', 'staffPerStudent'])

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))

/** Checks sample data against a manifest. Issues name collections and positions, never values. */
export function checkSample(raw: unknown, manifest: StudioManifestV2): SampleResult {
  if (!isPlain(raw)) return { ok: false, issues: ['Sample data must be an object keyed by collection name'] }
  if (utf8Bytes(JSON.stringify(raw)) > STUDIO_BUILDER_SAMPLE_MAX_BYTES) {
    return { ok: false, issues: [`Sample data is larger than ${STUDIO_BUILDER_SAMPLE_MAX_BYTES / 1024} KiB`] }
  }
  const issues: string[] = []
  const sample: SampleData = {}
  let records = 0
  for (const [name, list] of Object.entries(raw)) {
    if (!Object.hasOwn(manifest.collections, name)) {
      issues.push(`${name}: not a collection of this tool`)
      continue
    }
    if (!Array.isArray(list)) {
      issues.push(`${name}: must be a list of records`)
      continue
    }
    const collection = manifest.collections[name]
    const owned = OWNED.has(collection.access)
    sample[name] = []
    list.forEach((item, i) => {
      records += 1
      const at = `${name}[${i}]`
      if (!isPlain(item) || Object.keys(item).some((k) => k !== 'student' && k !== 'data')) {
        issues.push(`${at}: each record is { "student"?: number, "data": { ... } }`)
        return
      }
      if (owned && !(Number.isInteger(item.student) && (item.student as number) >= 0 && (item.student as number) < PREVIEW_ROSTER.length)) {
        issues.push(`${at}: ${collection.access} records need "student", a number from 0 to ${PREVIEW_ROSTER.length - 1}`)
        return
      }
      if (!owned && item.student !== undefined) {
        issues.push(`${at}: only perStudent and staffPerStudent records have a student`)
        return
      }
      const valid = validateRecordData('sample', name, collection, item.data)
      if (!valid.ok) {
        issues.push(...valid.issues.slice(0, 3).map((issue) => `${at}: ${issue}`))
        return
      }
      const bad = Object.values(valid.data).map((v) => (typeof v === 'string' ? characterProblem(v) : null)).find(Boolean)
      if (bad) {
        issues.push(`${at}: ${bad}`)
        return
      }
      sample[name].push(owned ? { student: item.student as number, data: valid.data } : { data: valid.data })
    })
  }
  if (records > STUDIO_BUILDER_SAMPLE_MAX_RECORDS) issues.push(`At most ${STUDIO_BUILDER_SAMPLE_MAX_RECORDS} sample records in all`)
  return issues.length > 0 ? { ok: false, issues: issues.slice(0, 8) } : { ok: true, sample, records }
}

/** Every text value, for the student-name and course-material checks. */
export function sampleTexts(sample: SampleData | null): string[] {
  if (!sample) return []
  return Object.values(sample).flatMap((list) => list.flatMap((r) => Object.values(r.data).filter((v): v is string => typeof v === 'string')))
}
