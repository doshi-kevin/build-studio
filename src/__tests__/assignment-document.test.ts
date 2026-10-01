import { describe, it, expect } from 'vitest'
import {
  assignmentDocumentSchema,
  parseAssignmentDocument,
  emptyAssignmentDocument,
} from '@/lib/validations/studio'

const doc = (content: unknown[]) => ({ version: 1, doc: { type: 'doc', content } })

describe('emptyAssignmentDocument', () => {
  it('is an empty tiptap doc at version 1', () => {
    expect(emptyAssignmentDocument()).toEqual({ version: 1, doc: { type: 'doc', content: [] } })
  })
})

describe('assignmentDocumentSchema', () => {
  it('accepts a valid tiptap doc and keeps unknown top-level keys', () => {
    const input = { version: 1, doc: { type: 'doc', content: [{ type: 'paragraph' }], attrs: { x: 1 } } }
    const res = assignmentDocumentSchema.safeParse(input)
    expect(res.success).toBe(true)
    // loose object preserves TipTap's extra keys verbatim
    expect((res.data!.doc as Record<string, unknown>).attrs).toEqual({ x: 1 })
  })

  it('rejects a non-doc root', () => {
    expect(assignmentDocumentSchema.safeParse({ version: 1, doc: { type: 'paragraph' } }).success).toBe(false)
  })

  it('rejects a document over the 5MB serialized cap', () => {
    const huge = doc([{ type: 'paragraph', text: 'x'.repeat(5 * 1024 * 1024 + 1) }])
    expect(assignmentDocumentSchema.safeParse(huge).success).toBe(false)
  })
})

describe('parseAssignmentDocument', () => {
  it('reads a document off assignment settings', () => {
    const settings = { kind: 'document', document: doc([{ type: 'paragraph' }]) }
    const parsed = parseAssignmentDocument(settings)
    expect(parsed?.doc.type).toBe('doc')
    expect(parsed?.doc.content).toHaveLength(1)
  })

  it('returns null when there is no document / bad settings', () => {
    expect(parseAssignmentDocument({})).toBeNull()
    expect(parseAssignmentDocument(null)).toBeNull()
    expect(parseAssignmentDocument({ document: { doc: { type: 'paragraph' } } })).toBeNull()
  })
})
