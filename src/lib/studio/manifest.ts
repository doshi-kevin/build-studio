import { z } from 'zod'
import { CAPABILITIES, CAPABILITY_NAMES, type PluginView } from './capabilities'
import { STUDIO_MANIFEST_MAX_COLLECTIONS, STUDIO_MANIFEST_MAX_FIELDS } from './limits'

// The contract is documented in docs/reference/studio-plugin-manifest.md.

/** Bridge versions the platform serves. Older ones stay served forever (rule 8.7). */
export const STUDIO_BRIDGE_VERSIONS = ['v1'] as const

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

export const manifestSchema = z.strictObject({
  manifestVersion: z.literal(1),
  id: z.string().max(40).regex(SLUG, 'Must be lowercase words joined by hyphens, like exit-ticket'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300),
  version: z.string().regex(SEMVER, 'Must be a version like 1.0.0'),
  bridgeVersion: z.enum(STUDIO_BRIDGE_VERSIONS),
  views: z.strictObject({ student: viewSchema('student'), professor: viewSchema('professor') }),
  collections: namedRecord(collectionSchema, 'collection', STUDIO_MANIFEST_MAX_COLLECTIONS),
})

export type StudioManifest = z.infer<typeof manifestSchema>

export type ManifestResult = { ok: true; manifest: StudioManifest } | { ok: false; issues: string[] }

/** Each issue reads "path: message" so Athena can repair the manifest and a professor
 * can read why a publish was refused. */
export function parseManifest(raw: unknown): ManifestResult {
  const result = manifestSchema.safeParse(raw)
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
