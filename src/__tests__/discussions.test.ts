// Tests for discussion validation schemas — transforms and content/attachment XOR refinement
import { describe, it, expect } from 'vitest'
import {
  createDiscussionChannelSchema,
  renameDiscussionChannelSchema,
  sendDiscussionMessageSchema,
} from '@/lib/validations/discussion'

// ── createDiscussionChannelSchema ────────────────────────────────

describe('createDiscussionChannelSchema', () => {
  it('lowercases and hyphenates spaces', () => {
    const result = createDiscussionChannelSchema.safeParse({ name: 'Team Updates' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.name).toBe('team-updates')
  })

  it('strips special characters without leaving their gaps behind', () => {
    const result = createDiscussionChannelSchema.safeParse({ name: 'Hello World! @#$' })
    expect(result.success).toBe(true)
    /* Was 'hello-world-' — the trailing hyphen is the stripped "! @#$" leaving its own
       whitespace-turned-hyphen behind, because the whitespace pass ran BEFORE the strip
       (#674). Repeated and edge hyphens are now collapsed and trimmed. */
    if (result.success) expect(result.data.name).toBe('hello-world')
  })

  it('trims whitespace', () => {
    const result = createDiscussionChannelSchema.safeParse({ name: '  resources  ' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.name).toBe('resources')
  })

  it('rejects whitespace-only string', () => {
    const result = createDiscussionChannelSchema.safeParse({ name: '   ' })
    expect(result.success).toBe(false)
  })

})

// ── renameDiscussionChannelSchema ────────────────────────────────

describe('renameDiscussionChannelSchema', () => {
  it('transforms name same as create schema', () => {
    const result = renameDiscussionChannelSchema.safeParse({ name: 'New Name Here' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.name).toBe('new-name-here')
  })

})

// ── sendDiscussionMessageSchema ──────────────────────────────────

describe('sendDiscussionMessageSchema', () => {
  it('accepts a text-only message', () => {
    const result = sendDiscussionMessageSchema.safeParse({ content: 'Hello!' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.content).toBe('Hello!')
  })

  it('accepts an attachment-only message (empty content)', () => {
    const result = sendDiscussionMessageSchema.safeParse({
      content: '',
      attachment_url: 'https://example.com/file.pdf',
      attachment_name: 'file.pdf',
      attachment_size: 1024,
      attachment_type: 'application/pdf',
    })
    expect(result.success).toBe(true)
  })

  it('accepts an attachment-only message with only a path (no signed url)', () => {
    // The client no longer persists the expiring signed URL — it sends only
    // attachment_path and readers mint fresh URLs. An attachment-only message
    // must still validate on the path alone.
    const result = sendDiscussionMessageSchema.safeParse({
      content: '',
      attachment_path: 'discussions/section-1/channel-1/123.png',
      attachment_name: 'image.png',
      attachment_size: 2048,
      attachment_type: 'image/png',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a message with both text and attachment', () => {
    const result = sendDiscussionMessageSchema.safeParse({
      content: 'Check this out',
      attachment_url: 'https://example.com/image.png',
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty content with no attachment', () => {
    const result = sendDiscussionMessageSchema.safeParse({ content: '' })
    expect(result.success).toBe(false)
  })

  it('rejects whitespace-only content with no attachment', () => {
    const result = sendDiscussionMessageSchema.safeParse({ content: '   ' })
    expect(result.success).toBe(false)
  })

  it('trims content whitespace', () => {
    const result = sendDiscussionMessageSchema.safeParse({ content: '  hello  ' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.content).toBe('hello')
  })

})
