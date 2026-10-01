// Tests for project-docs validation schemas and helpers. Only custom
// business rules (defaults, max lengths, HTML helper tolerance) are
// covered — trivial Zod built-in shapes are not re-tested.

import { describe, it, expect } from 'vitest'
import {
  DOC_TITLE_MAX,
  DOC_CONTENT_MAX_CHARS,
  createDocSchema,
  updateDocTitleSchema,
  updateDocContentSchema,
  docContentSchema,
  docContentToHtml,
  htmlToDocContent,
} from '@/lib/validations/project-docs'

// ── createDocSchema ──────────────────────────────────────────

describe('createDocSchema', () => {
  const parse = (data: unknown) => createDocSchema.safeParse(data)

  it("defaults title to 'Untitled' when omitted", () => {
    const result = parse({})
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.title).toBe('Untitled')
  })

  it('trims surrounding whitespace from title', () => {
    const result = parse({ title: '   My Doc   ' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.title).toBe('My Doc')
  })

  it('rejects titles that are empty after trimming', () => {
    expect(parse({ title: '   ' }).success).toBe(false)
  })

  it('rejects titles longer than DOC_TITLE_MAX', () => {
    expect(parse({ title: 'a'.repeat(DOC_TITLE_MAX + 1) }).success).toBe(false)
  })
})

// ── updateDocTitleSchema ─────────────────────────────────────

describe('updateDocTitleSchema', () => {
  const parse = (data: unknown) => updateDocTitleSchema.safeParse(data)

  it('requires a non-empty title (no Untitled default on update)', () => {
    expect(parse({}).success).toBe(false)
    expect(parse({ title: '' }).success).toBe(false)
  })

  it('rejects whitespace-only titles', () => {
    expect(parse({ title: '   ' }).success).toBe(false)
  })
})

// ── docContentSchema ─────────────────────────────────────────

describe('docContentSchema', () => {
  const parse = (data: unknown) => docContentSchema.safeParse(data)

  it('accepts the html format discriminator', () => {
    expect(parse({ format: 'html', html: '<p>hi</p>' }).success).toBe(true)
  })

  it('accepts the json format discriminator', () => {
    expect(parse({ format: 'json', json: { type: 'doc' } }).success).toBe(true)
  })

  it('enforces DOC_CONTENT_MAX_CHARS on html payload', () => {
    const tooLarge = { format: 'html', html: 'a'.repeat(DOC_CONTENT_MAX_CHARS + 1) }
    expect(parse(tooLarge).success).toBe(false)
  })

  it('accepts html at exactly the character cap', () => {
    const atLimit = { format: 'html', html: 'a'.repeat(DOC_CONTENT_MAX_CHARS) }
    expect(parse(atLimit).success).toBe(true)
  })

  it('rejects unknown format values', () => {
    expect(parse({ format: 'markdown', md: '# hi' }).success).toBe(false)
  })
})

// ── updateDocContentSchema ───────────────────────────────────

describe('updateDocContentSchema', () => {
  const parse = (data: unknown) => updateDocContentSchema.safeParse(data)

  it('accepts wrapped content payload', () => {
    expect(parse({ content: { format: 'html', html: '' } }).success).toBe(true)
  })

  it('rejects missing content field', () => {
    expect(parse({}).success).toBe(false)
  })
})

// ── htmlToDocContent / docContentToHtml helpers ──────────────

describe('htmlToDocContent', () => {
  it('wraps a string as html format content', () => {
    expect(htmlToDocContent('<p>x</p>')).toEqual({ format: 'html', html: '<p>x</p>' })
  })
})

describe('docContentToHtml', () => {
  it('returns the html field for html-format content', () => {
    expect(docContentToHtml({ format: 'html', html: '<p>hi</p>' })).toBe('<p>hi</p>')
  })

  it('returns empty string for null input', () => {
    expect(docContentToHtml(null)).toBe('')
  })

  it('returns empty string for non-object input', () => {
    expect(docContentToHtml('just a string')).toBe('')
  })

  it('returns empty string for an unknown format', () => {
    expect(docContentToHtml({ format: 'json', json: {} })).toBe('')
  })

  it('returns empty string when html field is missing or non-string', () => {
    expect(docContentToHtml({ format: 'html' })).toBe('')
    expect(docContentToHtml({ format: 'html', html: 42 })).toBe('')
  })
})
