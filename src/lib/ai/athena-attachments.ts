/**
 * Athena attachment rules — SHARED, client-safe.
 *
 * Pure data + pure functions: extension classification, the upload whitelist,
 * per-surface limits and the storage path layout. No provider SDK, no admin
 * client, no Node built-ins — so the composer (professor console AND the student
 * dock) can import it for the file-picker `accept` string and advisory
 * pre-checks, while the upload routes import the SAME `validateAthenaUpload` as
 * the authoritative server-side gate.
 *
 * The parts that need the service-role client or Node Buffer (signing,
 * materializing bytes for the model, the file-part IDOR guard) live in
 * `athena-attachments-server.ts`.
 */

import type { AthenaAttachmentLimits } from './professor-assistant/models'

export const ATHENA_ATTACHMENTS_BUCKET = 'athena-attachments'

/** Signed-URL TTL for display on reload (1h). Never persisted — paths are. */
export const ATHENA_SIGNED_URL_TTL_SECONDS = 3600

/** What we do with a given extension before the model sees it. */
export type AttachmentKind = 'passthrough' | 'office' | 'text'

const PASSTHROUGH_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif'])
const OFFICE_EXT = new Set(['docx', 'pptx', 'xlsx', 'doc', 'ppt', 'xls'])
export const TEXT_EXT = new Set(['txt', 'md', 'csv'])

/** Stable, normalized content type per extension — what we store the object as,
 *  so the bucket's allowed_mime_types check is reliable regardless of the wobbly
 *  type the browser reports for .md/.csv. Office files are stored as PDF. */
export const CONTENT_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
}

/**
 * What a STUDENT may attach to an Athena question.
 *
 * Deliberately tighter than the professor console's per-model limits (5 × 20MB):
 * a student attachment is a homework question, a photo of a worked problem or an
 * essay draft — not a course pack. Every attached file is re-inlined into the
 * prompt on every subsequent turn of the thread, so the ceiling here is a
 * recurring per-turn token cost, not a one-off upload cost.
 *
 * Same accepted types as the professor side: both surfaces send to Gemini and
 * share the one Office→PDF conversion path.
 */
export const STUDENT_ATTACHMENTS: AthenaAttachmentLimits = {
  maxFiles: 3,
  maxBytesPerFile: 10 * 1024 * 1024,
  maxOfficeBytes: 10 * 1024 * 1024,
  acceptedExt: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'csv', 'docx', 'pptx', 'xlsx'],
}

export function extOf(filename: string): string {
  return (filename.split('.').pop() || '').toLowerCase()
}

export function classifyExt(ext: string): AttachmentKind | null {
  if (PASSTHROUGH_EXT.has(ext)) return 'passthrough'
  if (OFFICE_EXT.has(ext)) return 'office'
  if (TEXT_EXT.has(ext)) return 'text'
  return null
}

export interface ValidatedUpload {
  ext: string
  kind: AttachmentKind
  /** Content type the STORED object will have (office → application/pdf). */
  storedContentType: string
  /** Media type the model sees (office → application/pdf). */
  modelMediaType: string
}

/**
 * Validate a single upload against a surface's limits. Returns the resolved
 * descriptor, or an `{ error }` with a friendly message. On the server this is
 * the authoritative whitelist; the client may run it first so a rejected file
 * fails instantly, but that copy is advisory only.
 */
export function validateAthenaUpload(
  filename: string,
  sizeBytes: number,
  limits: AthenaAttachmentLimits,
): ValidatedUpload | { error: string } {
  const ext = extOf(filename)
  if (!limits.acceptedExt.includes(ext)) {
    return { error: `Unsupported file type: .${ext || '?'}` }
  }
  const kind = classifyExt(ext)
  if (!kind) return { error: `Unsupported file type: .${ext}` }

  const limit = kind === 'office' ? limits.maxOfficeBytes : limits.maxBytesPerFile
  if (sizeBytes > limit) {
    return { error: `“${filename}” is too large (max ${Math.round(limit / (1024 * 1024))} MB)` }
  }

  const storedContentType = kind === 'office' ? 'application/pdf' : CONTENT_TYPE[ext] || 'application/octet-stream'
  return { ext, kind, storedContentType, modelMediaType: storedContentType }
}

/**
 * Object path: `{institutionId}/{sectionId}/{scopeId}/{uuid}.{ext}`.
 *
 * `scopeId` is the narrowest owner the surface can name at upload time, and it
 * is what the chat route re-derives to bind a returning path to the caller (see
 * `pathInScope`): the CONVERSATION for the professor console (its id is
 * client-generated, so it exists before the first message) and the STUDENT for
 * the dock (their thread row is created lazily on first send, so there is no
 * conversation to hang a file on when they attach from the greeting).
 *
 * Office uploads are stored as PDF, so their stored extension is `pdf`.
 */
export function athenaAttachmentPath(args: {
  institutionId: string
  sectionId: string
  scopeId: string
  storedExt: string
}): string {
  const { institutionId, sectionId, scopeId, storedExt } = args
  return `${institutionId}/${sectionId}/${scopeId}/${crypto.randomUUID()}.${storedExt}`
}

/** Prefix every stored path for this scope shares — the IDOR guard's allow-list. */
export function athenaAttachmentPrefix(args: {
  institutionId: string
  sectionId: string
  scopeId: string
}): string {
  return `${args.institutionId}/${args.sectionId}/${args.scopeId}/`
}

/** Build the HTML file-input `accept` string for a surface's accepted extensions. */
export function acceptAttribute(limits: AthenaAttachmentLimits): string {
  return limits.acceptedExt.map((e) => `.${e}`).join(',')
}
