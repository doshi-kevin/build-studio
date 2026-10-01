import { describe, it, expect } from 'vitest'
import {
  athenaAttachmentPath,
  athenaAttachmentPrefix,
  classifyExt,
  validateAthenaUpload,
  STUDENT_ATTACHMENTS,
} from '@/lib/ai/athena-attachments'
import { pathInScope, filePartsToPaths } from '@/lib/ai/athena-attachments-server'
import { ATHENA_MODELS } from '@/lib/ai/professor-assistant/models'

// validateAthenaUpload is the server-side whitelist for uploads — the client's
// own checks are advisory. It must reject unknown extensions and enforce the
// per-kind size caps (Office gets a tighter cap because it's converted to PDF
// synchronously). These cases assert that contract, not the registry contents.
const limits = ATHENA_MODELS.find((m) => m.id === 'gemini-flash')!.attachments
const MB = 1024 * 1024

describe('classifyExt', () => {
  it('buckets extensions into passthrough / office / text', () => {
    expect(classifyExt('pdf')).toBe('passthrough')
    expect(classifyExt('png')).toBe('passthrough')
    expect(classifyExt('docx')).toBe('office')
    expect(classifyExt('pptx')).toBe('office')
    expect(classifyExt('xlsx')).toBe('office')
    expect(classifyExt('md')).toBe('text')
    expect(classifyExt('csv')).toBe('text')
  })

  it('returns null for unknown/dangerous extensions', () => {
    expect(classifyExt('exe')).toBeNull()
    expect(classifyExt('')).toBeNull()
    expect(classifyExt('zip')).toBeNull()
  })
})

describe('validateAthenaUpload', () => {
  it('accepts a PDF and reports it as a passthrough application/pdf', () => {
    const r = validateAthenaUpload('report.pdf', 2 * MB, limits)
    expect('error' in r).toBe(false)
    if (!('error' in r)) {
      expect(r.kind).toBe('passthrough')
      expect(r.modelMediaType).toBe('application/pdf')
    }
  })

  it('treats an Office doc as office and stores it as PDF', () => {
    const r = validateAthenaUpload('syllabus.docx', 1 * MB, limits)
    expect('error' in r).toBe(false)
    if (!('error' in r)) {
      expect(r.kind).toBe('office')
      expect(r.storedContentType).toBe('application/pdf')
    }
  })

  it('rejects an unsupported extension', () => {
    const r = validateAthenaUpload('malware.exe', 1, limits)
    expect('error' in r).toBe(true)
  })

  it('enforces the 20MB cap for PDFs/images', () => {
    expect('error' in validateAthenaUpload('big.pdf', 21 * MB, limits)).toBe(true)
    expect('error' in validateAthenaUpload('ok.pdf', 19 * MB, limits)).toBe(false)
  })

  it('enforces the tighter 10MB cap for Office docs', () => {
    // 11MB is under the 20MB file cap but over the 10MB Office cap → rejected.
    expect('error' in validateAthenaUpload('big.pptx', 11 * MB, limits)).toBe(true)
    expect('error' in validateAthenaUpload('ok.pptx', 9 * MB, limits)).toBe(false)
  })

  it('holds students to their own, tighter ceiling', () => {
    // A file the professor console accepts that a student's does not — the two
    // surfaces share the code path but not the limits.
    expect('error' in validateAthenaUpload('lecture.pdf', 15 * MB, limits)).toBe(false)
    expect('error' in validateAthenaUpload('lecture.pdf', 15 * MB, STUDENT_ATTACHMENTS)).toBe(true)
  })
})

// The IDOR guard: a storage path round-trips through the untrusted client on
// every turn and is then downloaded with the RLS-bypassing admin client, so a
// path outside the caller's own prefix must never be honoured.
describe('pathInScope', () => {
  const mine = athenaAttachmentPrefix({ institutionId: 'inst-1', sectionId: 'sec-1', scopeId: 'student-1' })

  // A real path is exactly what athenaAttachmentPath mints: {prefix}{uuid}.{ext}.
  const owned = athenaAttachmentPath({ institutionId: 'inst-1', sectionId: 'sec-1', scopeId: 'student-1', storedExt: 'pdf' })
  const uuidFile = owned.slice(mine.length) // "<uuid>.pdf"

  it('accepts a path the caller owns', () => {
    expect(pathInScope(owned, mine)).toBe(true)
  })

  it('rejects another student, another section and another institution', () => {
    expect(pathInScope(`inst-1/sec-1/student-2/${uuidFile}`, mine)).toBe(false)
    expect(pathInScope(`inst-1/sec-2/student-1/${uuidFile}`, mine)).toBe(false)
    expect(pathInScope(`inst-2/sec-1/student-1/${uuidFile}`, mine)).toBe(false)
  })

  it('rejects a missing path and traversal attempts', () => {
    expect(pathInScope(undefined, mine)).toBe(false)
    // Leading `..`: never matched the prefix.
    expect(pathInScope(`../inst-2/sec-1/student-1/${uuidFile}`, mine)).toBe(false)
    // The one a bare startsWith would have let through: the prefix matches, but
    // the remainder walks back out with `..`/`/` to another bucket path.
    expect(pathInScope(`${mine}../../../other-bucket/${uuidFile}`, mine)).toBe(false)
    // A remainder with a nested segment is not a single owned filename either.
    expect(pathInScope(`${mine}sub/${uuidFile}`, mine)).toBe(false)
  })
})

// filePartsToPaths is what stands between an untrusted `url` on an incoming turn
// and a row in athena_messages. It matters more than the model-facing guard next
// to it: the copy sent to the model is thrown away after the turn, but a stored
// path is read again on every resume, and each read re-mints a signed URL for it
// with the RLS-bypassing admin client. A forged path persisted once is readable
// for as long as the thread exists.
describe('filePartsToPaths', () => {
  const mine = athenaAttachmentPrefix({ institutionId: 'inst-1', sectionId: 'sec-1', scopeId: 'conv-1' })
  const owned = athenaAttachmentPath({
    institutionId: 'inst-1',
    sectionId: 'sec-1',
    scopeId: 'conv-1',
    storedExt: 'pdf',
  })
  const uuidFile = owned.slice(mine.length)

  const message = (...parts: unknown[]) => ({ id: 'm1', role: 'user', parts }) as never
  const partsOf = (m: { parts: unknown }) => m.parts as Array<Record<string, unknown>>

  it('stores the durable path, not the signed URL the client arrived with', () => {
    const out = filePartsToPaths(
      message({
        type: 'file',
        mediaType: 'application/pdf',
        filename: 'syllabus.pdf',
        url: 'https://storage.example/object/sign/xyz?token=expires-in-an-hour',
        providerMetadata: { athena: { path: owned } },
      }),
      mine,
    )

    // A signed URL goes stale within the hour; the path is what a resumed thread
    // can still resolve months later.
    expect(partsOf(out)).toEqual([
      { type: 'file', mediaType: 'application/pdf', filename: 'syllabus.pdf', url: owned },
    ])
  })

  it('drops a path belonging to another institution/section/conversation', () => {
    const out = filePartsToPaths(
      message({
        type: 'file',
        mediaType: 'application/pdf',
        filename: 'someone-elses.pdf',
        url: 'https://storage.example/signed',
        providerMetadata: { athena: { path: `inst-2/sec-9/conv-9/${uuidFile}` } },
      }),
      mine,
    )

    // Dropped outright, never stored under the caller's own thread — storing it
    // would hand them a fresh signed URL for it on every later resume.
    expect(partsOf(out)).toEqual([])
  })

  it('drops a traversal path that merely STARTS with the caller prefix', () => {
    const out = filePartsToPaths(
      message({
        type: 'file',
        mediaType: 'application/pdf',
        url: `${mine}../../../other-bucket/${uuidFile}`,
      }),
      mine,
    )
    expect(partsOf(out)).toEqual([])
  })

  it('drops every file part when the surface accepts no attachments at all', () => {
    // No production caller passes null today — every Athena route builds a prefix
    // now that Studio attachments are not gated to the About kind. This pins the
    // function's own contract so the null case stays safe for the next surface
    // that needs it: a part that is in-scope by path must still not be persisted.
    const out = filePartsToPaths(
      message({ type: 'file', mediaType: 'application/pdf', url: owned }),
      null,
    )
    expect(partsOf(out)).toEqual([])
  })

  it('leaves non-file parts alone, in order', () => {
    const out = filePartsToPaths(
      message(
        { type: 'text', text: 'Here is the syllabus.' },
        { type: 'file', mediaType: 'application/pdf', url: owned },
        { type: 'text', text: 'Pull the weekly topics out of it.' },
      ),
      mine,
    )

    expect(partsOf(out)).toEqual([
      { type: 'text', text: 'Here is the syllabus.' },
      { type: 'file', mediaType: 'application/pdf', filename: undefined, url: owned },
      { type: 'text', text: 'Pull the weekly topics out of it.' },
    ])
  })
})
