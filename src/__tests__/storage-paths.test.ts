import { describe, it, expect } from 'vitest'
import { isSafeStoragePath } from '@/lib/supabase/storage'

// isSafeStoragePath guards every spot where a client-supplied storage path is
// authorized by its section prefix and then read/written with the
// RLS-bypassing admin client (peek route, registerQuizUpload, quiz generation
// additional files). A miss here is a cross-tenant read — the checks below are
// the attack shapes, not happy-path restatements.
describe('isSafeStoragePath', () => {
  const prefix = 'section-a/quiz-ai-uploads/'

  it('accepts a normal key under the required prefix', () => {
    expect(isSafeStoragePath('section-a/quiz-ai-uploads/deck_123.pdf', prefix)).toBe(true)
    expect(isSafeStoragePath('section-a/quiz-ai-uploads/nested/deck.pptx', prefix)).toBe(true)
  })

  it('rejects traversal that keeps the authorized prefix (the load-bearing case)', () => {
    // Passes a startsWith-only check while the bytes resolve to section B.
    expect(isSafeStoragePath('section-a/quiz-ai-uploads/../../section-b/secret.pdf', prefix)).toBe(false)
  })

  it('rejects any `..` segment, absolute paths, and backslashes', () => {
    expect(isSafeStoragePath('../section-a/quiz-ai-uploads/x.pdf', prefix)).toBe(false)
    expect(isSafeStoragePath('/section-a/quiz-ai-uploads/x.pdf', prefix)).toBe(false)
    expect(isSafeStoragePath('section-a/quiz-ai-uploads\\..\\x.pdf', prefix)).toBe(false)
  })

  it('rejects keys outside the required prefix', () => {
    expect(isSafeStoragePath('section-b/quiz-ai-uploads/x.pdf', prefix)).toBe(false)
    expect(isSafeStoragePath('section-a/other-folder/x.pdf', prefix)).toBe(false)
    expect(isSafeStoragePath('', prefix)).toBe(false)
  })
})
