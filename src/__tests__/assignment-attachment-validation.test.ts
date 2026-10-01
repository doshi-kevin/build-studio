import { describe, it, expect } from 'vitest'
import { validateAssignmentAttachment, MAX_ASSIGNMENT_ATTACHMENT_SIZE } from '@/lib/validations/assignment'

const ok = (r: ReturnType<typeof validateAssignmentAttachment>) => r.ok === true

describe('validateAssignmentAttachment', () => {
  it('accepts a PDF and a PowerPoint (ppt/pptx) and reports a document contentType', () => {
    expect(validateAssignmentAttachment('brief.pdf', 1000, 'application/pdf')).toEqual({ ok: true, contentType: 'application/pdf' })
    expect(ok(validateAssignmentAttachment('slides.ppt', 1000, 'application/vnd.ms-powerpoint'))).toBe(true)
    expect(ok(validateAssignmentAttachment('slides.pptx', 1000, ''))).toBe(true) // ext drives it when mime is blank
  })

  it('accepts a raster image by its allowlisted extension, deriving contentType from the ext', () => {
    expect(validateAssignmentAttachment('a.png', 1, 'image/png')).toEqual({ ok: true, contentType: 'image/png' })
    expect(validateAssignmentAttachment('a.jpg', 1, 'image/jpeg')).toEqual({ ok: true, contentType: 'image/jpeg' })
    expect(ok(validateAssignmentAttachment('a.heic', 1, 'image/heic'))).toBe(true)
    expect(validateAssignmentAttachment('a.avif', 1, 'image/avif')).toEqual({ ok: true, contentType: 'image/avif' })
    // contentType comes from the EXTENSION, not the (spoofable) client mime.
    expect(validateAssignmentAttachment('a.png', 1, 'image/gif')).toEqual({ ok: true, contentType: 'image/png' })
  })

  it('REJECTS an unknown/spoofable extension even with a valid image mime (stored-XSS guard)', () => {
    // The exact bypass: a script-executable extension smuggled in behind an image mime.
    expect(ok(validateAssignmentAttachment('exploit.html', 1, 'image/png'))).toBe(false)
    expect(ok(validateAssignmentAttachment('x.js', 1, 'image/png'))).toBe(false)
    // Extensionless file with a valid image mime is also rejected — we trust the ext, not the mime.
    expect(ok(validateAssignmentAttachment('photo', 1, 'image/avif'))).toBe(false)
  })

  it('REJECTS SVG (script-bearing vector) by mime and by extension', () => {
    expect(ok(validateAssignmentAttachment('x.svg', 1, 'image/svg+xml'))).toBe(false)
    expect(ok(validateAssignmentAttachment('x.svg', 1, ''))).toBe(false)
    expect(ok(validateAssignmentAttachment('x.png', 1, 'image/svg+xml'))).toBe(false)
  })

  it('rejects oversized (>25MB) and empty files', () => {
    expect(ok(validateAssignmentAttachment('big.pdf', MAX_ASSIGNMENT_ATTACHMENT_SIZE + 1, 'application/pdf'))).toBe(false)
    expect(ok(validateAssignmentAttachment('empty.pdf', 0, 'application/pdf'))).toBe(false)
  })

  it('rejects disallowed types (exe, zip, doc)', () => {
    expect(ok(validateAssignmentAttachment('malware.exe', 10, 'application/octet-stream'))).toBe(false)
    expect(ok(validateAssignmentAttachment('archive.zip', 10, 'application/zip'))).toBe(false)
    expect(ok(validateAssignmentAttachment('paper.docx', 10, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).toBe(false)
  })
})
