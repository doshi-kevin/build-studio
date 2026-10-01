// Unit tests for Live Classroom M1 validation schemas.

import { describe, it, expect } from 'vitest'
import {
  createRoomDraftSchema,
  advanceSlideSchema,
  endRoomSchema,
  renderDeckJsonBodySchema,
  createDeckUploadUrlSchema,
  MAX_DECK_BYTES,
  MAX_DECK_PAGES,
  STALE_ROOM_THRESHOLD_MS,
  SLIDE_ADVANCE_THROTTLE_MS,
} from '@/lib/validations/live-classroom'

describe('live-classroom validations', () => {
  describe('createRoomDraftSchema', () => {
    it('accepts valid UUID sectionId', () => {
      const result = createRoomDraftSchema.safeParse({
        sectionId: '123e4567-e89b-12d3-a456-426614174000',
      })
      expect(result.success).toBe(true)
    })

    it('rejects non-UUID sectionId', () => {
      const result = createRoomDraftSchema.safeParse({
        sectionId: 'not-a-uuid',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('UUID')
      }
    })

    it('rejects missing sectionId', () => {
      const result = createRoomDraftSchema.safeParse({})
      expect(result.success).toBe(false)
    })
  })

  describe('advanceSlideSchema', () => {
    it('accepts valid roomId and slideIndex', () => {
      const result = advanceSlideSchema.safeParse({
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        slideIndex: 5,
      })
      expect(result.success).toBe(true)
    })

    it('accepts slideIndex of 0', () => {
      const result = advanceSlideSchema.safeParse({
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        slideIndex: 0,
      })
      expect(result.success).toBe(true)
    })

    it('rejects negative slideIndex', () => {
      const result = advanceSlideSchema.safeParse({
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        slideIndex: -1,
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('non-negative')
      }
    })

    it('rejects non-integer slideIndex', () => {
      const result = advanceSlideSchema.safeParse({
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        slideIndex: 1.5,
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('integer')
      }
    })

    it('rejects non-UUID roomId', () => {
      const result = advanceSlideSchema.safeParse({
        roomId: 'invalid',
        slideIndex: 0,
      })
      expect(result.success).toBe(false)
    })
  })

  describe('endRoomSchema', () => {
    it('accepts valid UUID roomId', () => {
      const result = endRoomSchema.safeParse({
        roomId: '123e4567-e89b-12d3-a456-426614174000',
      })
      expect(result.success).toBe(true)
    })

    it('rejects non-UUID roomId', () => {
      const result = endRoomSchema.safeParse({
        roomId: 'not-a-uuid',
      })
      expect(result.success).toBe(false)
    })

    it('rejects missing roomId', () => {
      const result = endRoomSchema.safeParse({})
      expect(result.success).toBe(false)
    })
  })

  describe('renderDeckJsonBodySchema', () => {
    it('accepts roomId + deckId and defaults activate to true', () => {
      const result = renderDeckJsonBodySchema.safeParse({
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        deckId: '223e4567-e89b-12d3-a456-426614174000',
      })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.activate).toBe(true)
    })

    it('ignores a client-supplied source path (derived server-side now)', () => {
      // The render core derives the source path from the deck row, so a stray
      // client "sourcePath" must be stripped, not trusted (IDOR hardening).
      const result = renderDeckJsonBodySchema.safeParse({
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        deckId: '223e4567-e89b-12d3-a456-426614174000',
        sourcePath: '../another-tenant/secret.pdf',
      })
      expect(result.success).toBe(true)
      if (result.success) expect('sourcePath' in result.data).toBe(false)
    })

    it('rejects non-UUID roomId', () => {
      const result = renderDeckJsonBodySchema.safeParse({
        roomId: 'invalid',
        deckId: '223e4567-e89b-12d3-a456-426614174000',
      })
      expect(result.success).toBe(false)
    })

    it('rejects missing deckId', () => {
      const result = renderDeckJsonBodySchema.safeParse({
        roomId: '123e4567-e89b-12d3-a456-426614174000',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('createDeckUploadUrlSchema', () => {
    it('accepts valid UUID roomId', () => {
      const result = createDeckUploadUrlSchema.safeParse({
        roomId: '123e4567-e89b-12d3-a456-426614174000',
      })
      expect(result.success).toBe(true)
    })

    it('rejects non-UUID roomId', () => {
      const result = createDeckUploadUrlSchema.safeParse({
        roomId: 'not-a-uuid',
      })
      expect(result.success).toBe(false)
    })

    it('rejects missing roomId', () => {
      const result = createDeckUploadUrlSchema.safeParse({})
      expect(result.success).toBe(false)
    })
  })

  describe('constants', () => {
    it('MAX_DECK_BYTES is 250 MB', () => {
      expect(MAX_DECK_BYTES).toBe(250 * 1024 * 1024)
    })

    it('MAX_DECK_PAGES is 200', () => {
      expect(MAX_DECK_PAGES).toBe(200)
    })

    it('STALE_ROOM_THRESHOLD_MS is 12 hours', () => {
      expect(STALE_ROOM_THRESHOLD_MS).toBe(12 * 60 * 60 * 1000)
    })

    it('SLIDE_ADVANCE_THROTTLE_MS is 300ms', () => {
      expect(SLIDE_ADVANCE_THROTTLE_MS).toBe(300)
    })
  })
})
