import { z } from 'zod'
import { CAPABILITIES, CAPABILITY_NAMES, type PluginView } from './capabilities'
import { AI_FALLBACK_NAMES, PURPOSE_CATEGORY_NAMES, SIGNAL_NAMES } from './edtech'
import { STUDIO_MANIFEST_MAX_COLLECTIONS, STUDIO_MANIFEST_MAX_FIELDS } from './limits'
import { BRIDGE_VERSIONS } from './runtime/protocol'

// The contract is documented in docs/reference/studio-plugin-manifest.md.

/** Bridge versions the platform serves; one list, shared with the runtime host. */
export const STUDIO_BRIDGE_VERSIONS = BRIDGE_VERSIONS

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const NAME = /^[a-z][a-zA-Z0-9]{0,39}$/
// A relative .tsx path inside the plugin's own source: no "..", no leading slash, no URL.
const ENTRY = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\.tsx$/

// The platform stamps who and where on every record (rules 2.1, 3.3). A plugin field
// with one of these names could be mistaken for the real stamp, so none may be declared.
const RESERVED_FIELDS = new Set([
  'id', 'institutionid', 'sectionid', 'installationid', 'pluginid', 'pluginversion',
  'userid', 'studentid', 'authorid', 'createdat', 'updatedat',
])

/** Object keys a plugin chose. They're checked on the raw input: z.record silently drops a
 * "__proto__" key, so checking its output would accept a manifest that differs from the file. */
function namedRecord<T extends z.ZodType>(value: T, what: string, max: number, reserved?: Set<string>) {
  return z.unknown().superRefine((raw, ctx) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const keys = Object.keys(raw)
    if (keys.length > max) ctx.addIssue({ code: 'custom', message: `At most ${max} ${what}s` })
    for (const key of keys) {
      if (!NAME.test(key)) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${what} names are camelCase letters and digits, starting lowercase` })
      } else if (reserved?.has(key.toLowerCase())) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is stamped by the platform and can’t be declared` })
      }
    }
  }).pipe(z.record(z.string(), value))
}

/** perStudent: each record belongs to one student, who sees only their own; staff see all.
 * shared: staff write, everyone in the section reads.
 * staffOnly: never sent to a student's frame, e.g. answer keys (rule 5.2). */
const collectionSchema = z.strictObject({
  access: z.enum(['perStudent', 'shared', 'staffOnly']),
  fields: namedRecord(z.enum(['text', 'number', 'boolean']), 'field', STUDIO_MANIFEST_MAX_FIELDS, RESERVED_FIELDS)
    .refine((fields) => Object.keys(fields).length > 0, 'A collection needs at least one field'),
})

function viewSchema(view: PluginView) {
  return z
    .strictObject(
      {
        entry: z.string().regex(ENTRY, 'Must be a relative .tsx path inside the plugin, like views/student.tsx'),
        capabilities: z.array(z.enum(CAPABILITY_NAMES)).max(CAPABILITY_NAMES.length),
      },
      { error: (issue) => (issue.input === undefined ? `Every plugin needs a ${view} view` : undefined) },
    )
    .superRefine(({ capabilities }, ctx) => {
      capabilities.forEach((name, i) => {
        if (!CAPABILITIES[name].views.includes(view)) {
          ctx.addIssue({ code: 'custom', path: ['capabilities', i], message: `${name} isn’t available in the ${view} view` })
        }
      })
    })
}

const common = {
  id: z.string().max(40).regex(SLUG, 'Must be lowercase words joined by hyphens, like exit-ticket'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300),
  version: z.string().regex(SEMVER, 'Must be a version like 1.0.0'),
  bridgeVersion: z.enum(STUDIO_BRIDGE_VERSIONS),
  views: z.strictObject({ student: viewSchema('student'), professor: viewSchema('professor') }),
  collections: namedRecord(collectionSchema, 'collection', STUDIO_MANIFEST_MAX_COLLECTIONS),
}

/** Version 1: the original contract. Published v1 versions keep being read exactly as
 * written; nothing here reinterprets them. They have no purpose, signals, skill slots or
 * AI fallback, so they can't pass the pre-publish validator, which needs those. */
export const manifestV1Schema = z.strictObject({ manifestVersion: z.literal(1), ...common })

/** Rule 9.6: what the tool is for, in a structured form the validator can check. */
const purposeSchema = z.strictObject({
  category: z.enum(PURPOSE_CATEGORY_NAMES),
  summary: z.string().trim().min(20, 'Say in a sentence what students do and how it helps them learn').max(300),
  audience: z.enum(['students', 'staff', 'both']),
})

/** Rule 4.3: a reusable "what this counts toward", never a section's skill ID. Each
 * installation binds its slots to its own section's skills. */
const skillSlotSchema = z.strictObject({
  key: z.string().regex(NAME, 'Slot keys are camelCase letters and digits, starting lowercase'),
  label: z.string().trim().min(1).max(80),
})

export const STUDIO_MANIFEST_MAX_SKILL_SLOTS = 10

/** Version 2: adds what the pre-publish validator checks. New Studio versions use it. */
export const manifestV2Schema = z
  .strictObject({
    manifestVersion: z.literal(2),
    ...common,
    purpose: purposeSchema,
    signals: z
      .array(z.enum(SIGNAL_NAMES))
      .max(SIGNAL_NAMES.length)
      .refine((s) => new Set(s).size === s.length, 'Each signal is listed once'),
    skillSlots: z
      .array(skillSlotSchema)
      .max(STUDIO_MANIFEST_MAX_SKILL_SLOTS)
      .refine((slots) => new Set(slots.map((x) => x.key)).size === slots.length, 'Each skill slot key is used once'),
    aiFallback: z.enum(AI_FALLBACK_NAMES),
  })
  .superRefine((m, ctx) => {
    // Rule 6.2: a tool that uses AI says what happens without it; one that doesn't, says so.
    const usesAi = (['student', 'professor'] as const).some((v) =>
      m.views[v].capabilities.some((c) => CAPABILITIES[c].usesAi === true),
    )
    if (usesAi && m.aiFallback === 'not-applicable') {
      ctx.addIssue({ code: 'custom', path: ['aiFallback'], message: 'This tool uses AI, so say what it does when AI is switched off' })
    }
    if (!usesAi && m.aiFallback !== 'not-applicable') {
      ctx.addIssue({ code: 'custom', path: ['aiFallback'], message: 'This tool uses no AI, so its fallback is not-applicable' })
    }
  })

export type StudioManifestV1 = z.infer<typeof manifestV1Schema>
export type StudioManifestV2 = z.infer<typeof manifestV2Schema>
export type StudioManifest = StudioManifestV1 | StudioManifestV2

export const MANIFEST_VERSIONS = [1, 2] as const

/** The schema for a raw manifest's declared version, or null for any other. */
function schemaFor(raw: unknown) {
  const declared = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).manifestVersion : undefined
  if (declared === 1) return manifestV1Schema
  if (declared === 2) return manifestV2Schema
  return null
}

export type ManifestResult = { ok: true; manifest: StudioManifest } | { ok: false; issues: string[] }

/** Each issue reads "path: message" so Athena can repair the manifest and a professor
 * can read why a publish was refused. */
export function parseManifest(raw: unknown): ManifestResult {
  const schema = schemaFor(raw)
  if (!schema) return { ok: false, issues: ['manifestVersion: Must be 1 or 2'] }
  const result = schema.safeParse(raw)
  if (result.success) return { ok: true, manifest: result.data }
  return {
    ok: false,
    issues: result.error.issues.map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message)),
  }
}

export function parseManifestFile(text: string): ManifestResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, issues: ['plugin.manifest.json is not valid JSON'] }
  }
  return parseManifest(raw)
}
