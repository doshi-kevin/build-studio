// C3d — renderDeckToStorage derives the render source path SERVER-SIDE from the
// deck row and re-validates it against the canonical {roomId}/{deckId}/source.ext
// shape. A stored path that doesn't match (e.g. a tampered/cross-tenant path)
// is rejected before any file is downloaded or rendered — the IDOR guard.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Keep the import light + deterministic: stub the heavy render deps so importing
// the module never loads native canvas / pdfjs.
vi.mock('@/lib/document-parser/page-renderer', () => ({ renderPdfPage: vi.fn() }))
vi.mock('@/lib/document-parser', () => ({ parseDocument: vi.fn() }))
vi.mock('@/lib/live-classroom/deck-converter', () => ({
  ensurePdf: vi.fn(),
  isPptxEnabled: () => true,
  ConvertError: class ConvertError extends Error {},
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))

import { renderDeckToStorage, RenderDeckError } from '@/lib/live-classroom/render-deck'

const ROOM = '33333333-3333-3333-3333-333333333333'
const DECK = '44444444-4444-4444-4444-444444444444'

/** Minimal adminDb stub whose lc_decks lookup returns the given source_file_path. */
function adminDbWithDeckPath(sourceFilePath: string | null) {
  const downloadSpy = vi.fn()
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: DECK, extraction: null, source_file_path: sourceFilePath }, error: null }),
          }),
        }),
      }),
    }),
    storage: { from: () => ({ download: downloadSpy }) },
    rpc: vi.fn(),
  }
  return { db, downloadSpy }
}

describe('renderDeckToStorage source-path derivation (C3d)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a stored path that is not this room/deck canonical source', async () => {
    // A tampered path pointing at another location must not be rendered.
    const { db, downloadSpy } = adminDbWithDeckPath('../another-room/secret/source.pdf')
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderDeckToStorage({ adminDb: db as any, roomId: ROOM, deckId: DECK, activate: false, userId: null, sectionId: 'sec' }),
    ).rejects.toMatchObject({ name: 'RenderDeckError', reason: 'bad_source_path' })
    // Never attempted to download the tampered path.
    expect(downloadSpy).not.toHaveBeenCalled()
  })

  it('rejects when no source path is stored', async () => {
    const { db } = adminDbWithDeckPath(null)
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderDeckToStorage({ adminDb: db as any, roomId: ROOM, deckId: DECK, activate: false, userId: null, sectionId: 'sec' }),
    ).rejects.toBeInstanceOf(RenderDeckError)
  })

  it('accepts the canonical path and proceeds to download it', async () => {
    // A well-formed path passes validation; we stop it at download to keep the
    // test light — proving the derivation accepted exactly the canonical path.
    const canonical = `${ROOM}/${DECK}/source.pdf`
    const { db, downloadSpy } = adminDbWithDeckPath(canonical)
    downloadSpy.mockResolvedValue({ data: null, error: { message: 'stop here' } })
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderDeckToStorage({ adminDb: db as any, roomId: ROOM, deckId: DECK, activate: false, userId: null, sectionId: 'sec' }),
    ).rejects.toMatchObject({ reason: 'source_missing' })
    expect(downloadSpy).toHaveBeenCalledWith(canonical)
  })
})
