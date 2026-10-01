// Schema tests for direct-message send validation. Mirrors the shape
// of schema-discussions but for the DM surface — text/attachment XOR
// and the size/length guards.
import { describe, it, expect } from 'vitest'
import { sendDmMessageSchema } from '@/lib/validations/direct-messages'

describe('sendDmMessageSchema', () => {
  it('accepts a text-only message', () => {
    const r = sendDmMessageSchema.safeParse({ content: 'Hello there' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.content).toBe('Hello there')
  })

  it('accepts an attachment-only message with empty content', () => {
    const r = sendDmMessageSchema.safeParse({
      content: '',
      attachment_url: 'https://example.com/x.pdf',
      attachment_path: 'dms/abc/2026/04/x.pdf',
      attachment_name: 'x.pdf',
      attachment_size: 1024,
      attachment_type: 'application/pdf',
    })
    expect(r.success).toBe(true)
  })

  it('accepts an attachment-only message with a storage path but no url', () => {
    const r = sendDmMessageSchema.safeParse({
      content: '',
      attachment_path: 'dms/abc/2026/04/x.png',
    })
    expect(r.success).toBe(true)
  })

  it('rejects empty content with no attachment', () => {
    const r = sendDmMessageSchema.safeParse({ content: '' })
    expect(r.success).toBe(false)
  })

  it('rejects whitespace-only content with no attachment', () => {
    const r = sendDmMessageSchema.safeParse({ content: '   \n  ' })
    expect(r.success).toBe(false)
  })

  it('rejects content over 10k characters', () => {
    const r = sendDmMessageSchema.safeParse({ content: 'x'.repeat(10001) })
    expect(r.success).toBe(false)
  })

  it('rejects negative attachment sizes', () => {
    const r = sendDmMessageSchema.safeParse({
      content: 'hi',
      attachment_size: -1,
    })
    expect(r.success).toBe(false)
  })

  it('rejects a non-url attachment_url value', () => {
    const r = sendDmMessageSchema.safeParse({
      content: 'hi',
      attachment_url: 'not a url',
    })
    expect(r.success).toBe(false)
  })
})
