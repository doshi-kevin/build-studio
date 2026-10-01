// Tests for announcement validation schemas — business defaults and status enum.
// Trivial Zod built-in tests (min/max/partial/happy-path) removed.

import { describe, it, expect } from 'vitest'
import { createAnnouncementSchema } from '@/lib/validations/announcement'

describe('createAnnouncementSchema', () => {
  const parse = (data: unknown) => createAnnouncementSchema.safeParse(data)

  const validAnnouncement = {
    title: 'Midterm Moved',
    content: 'The midterm has been rescheduled.',
    is_pinned: false,
    status: 'published',
  }

  it('defaults visibility to all', () => {
    const result = parse(validAnnouncement)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.visibility).toBe('all')
  })

  it('defaults allow_reactions and allow_comments to false', () => {
    const result = parse(validAnnouncement)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.allow_reactions).toBe(false)
      expect(result.data.allow_comments).toBe(false)
    }
  })

  it('accepts all valid statuses', () => {
    for (const status of ['draft', 'published', 'scheduled']) {
      expect(parse({ ...validAnnouncement, status }).success).toBe(true)
    }
  })

  it('defaults is_important and requires_acknowledgement to false', () => {
    const result = parse(validAnnouncement)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.is_important).toBe(false)
      expect(result.data.requires_acknowledgement).toBe(false)
    }
  })

  it('accepts additional_section_ids of valid uuids', () => {
    const result = parse({
      ...validAnnouncement,
      additional_section_ids: ['123e4567-e89b-12d3-a456-426614174000'],
    })
    expect(result.success).toBe(true)
  })

  it('rejects additional_section_ids that are not uuids', () => {
    const result = parse({ ...validAnnouncement, additional_section_ids: ['not-a-uuid'] })
    expect(result.success).toBe(false)
  })
})
