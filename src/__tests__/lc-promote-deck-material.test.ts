// Unit tests for promoteUploadedDeckToModuleMaterial — the helper that turns an
// UPLOADED live-classroom deck (not one picked from a module) into a student-
// visible "Classroom Uploads" module material and pins the session under it.
//
// The helper takes `adminDb` by injection, so we hand it a table-keyed fake
// (per-table FIFO result queues + a call recorder) and single-function spies for
// writePlacementEdge / enqueueExtractionJob. Each test asserts an observable
// effect (a spy called / not called, a recorded insert/update) — the behavioural
// guards, not the implementation.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/extraction/enqueue', () => ({ enqueueExtractionJob: vi.fn(async () => ({})) }))
vi.mock('@/lib/roadmap/placement', () => ({ writePlacementEdge: vi.fn(async () => true) }))

import { promoteUploadedDeckToModuleMaterial } from '@/lib/live-classroom/promote-deck-material'
import { enqueueExtractionJob } from '@/lib/extraction/enqueue'
import { writePlacementEdge } from '@/lib/roadmap/placement'
import { logEvent } from '@/lib/supabase/event-logger'

/* eslint-disable @typescript-eslint/no-explicit-any */

type Result = { data: unknown; error: unknown }
interface RecordedCall {
  table: string
  op: 'insert' | 'update'
  payload: unknown
}

/** A fake admin client: `from(table)` yields a chain whose terminal (await /
 *  .single / .maybeSingle) shifts the next result off `queues[table]`. */
function makeAdminDb(queues: Record<string, Result[]>) {
  const recorder: RecordedCall[] = []
  /** Every `.eq(col, val)` predicate, tagged with the table it narrowed. */
  const filters: { table: string; col: string; val: unknown }[] = []
  const download = vi.fn(async () => ({
    data: { type: 'application/pdf', arrayBuffer: async () => new ArrayBuffer(8) },
    error: null,
  }))
  /* typed signature so assertions can index upload.mock.calls[0][0] (a bare
     zero-arg impl would infer an empty args tuple and fail typecheck) */
  const upload = vi.fn<(path: string, ...rest: unknown[]) => Promise<{ error: null }>>(async () => ({ error: null }))

  const makeChain = (table: string) => {
    const chain: Record<string, any> = {}
    for (const m of ['select', 'neq', 'in', 'is', 'order', 'limit', 'delete']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.eq = vi.fn((col: string, val: unknown) => {
      filters.push({ table, col, val })
      return chain
    })
    chain.insert = vi.fn((payload: unknown) => {
      recorder.push({ table, op: 'insert', payload })
      return chain
    })
    chain.update = vi.fn((payload: unknown) => {
      recorder.push({ table, op: 'update', payload })
      return chain
    })
    const take = (): Result => queues[table]?.shift() ?? { data: null, error: null }
    chain.single = vi.fn(async () => take())
    chain.maybeSingle = vi.fn(async () => take())
    // Thenable so `await db.from(t).select()...limit(1)` and `update().eq()` resolve.
    chain.then = (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(take()).then(resolve, reject)
    return chain
  }

  const db: any = {
    from: vi.fn((table: string) => makeChain(table)),
    storage: { from: vi.fn(() => ({ download, upload })) },
  }
  return { db, recorder, filters, download, upload }
}

const room = { id: 'room-1', section_id: 'sec-1' }

/** Queues for the happy path: deck load + deck update, module existing-check +
 *  insert, module_item insert, and an empty roadmap_edges check. */
function happyQueues(overrides: Partial<Record<string, Result[]>> = {}) {
  return {
    lc_decks: [
      { data: { id: 'deck-1', title: 'lecture.pdf', source_file_path: 'room-1/deck-1/source.pdf', module_item_id: null }, error: null },
      { data: null, error: null }, // update().eq()
    ],
    modules: [
      { data: [], error: null }, // existing-check → none
      { data: { id: 'mod-1' }, error: null }, // insert → new module
    ],
    module_items: [{ data: { id: 'item-1' }, error: null }],
    roadmap_edges: [{ data: [], error: null }], // no existing placement
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('promoteUploadedDeckToModuleMaterial', () => {
  it('promotes a fresh uploaded PDF: creates a HIDDEN item, links the deck, enqueues extraction, places the session', async () => {
    const { db, recorder, download, upload } = makeAdminDb(happyQueues())
    await promoteUploadedDeckToModuleMaterial({ adminDb: db, room, userId: 'prof-1', deckId: 'deck-1' } as any)

    // copied into course-materials at a section/deck-scoped path
    expect(download).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][0]).toBe('sec-1/live-classroom-uploads/deck-1.pdf')

    /* A lecture module item pointing at that path, HIDDEN from students.
       Uploading a deck to project in class is not a decision to publish
       coursework, and the upload control never asked — so the file is registered
       and extracted, but sharing is a separate explicit step (shareRoomUploads,
       offered when the class ends). */
    const itemInsert = recorder.find((c) => c.table === 'module_items' && c.op === 'insert')
    expect(itemInsert).toBeTruthy()
    const content = (itemInsert!.payload as any).content
    expect((itemInsert!.payload as any).is_visible).toBe(false)
    expect(content.filePath).toBe('sec-1/live-classroom-uploads/deck-1.pdf')
    expect(content.fileType).toBe('pdf')

    // deck linked to the new item
    const deckUpdate = recorder.find((c) => c.table === 'lc_decks' && c.op === 'update')
    expect((deckUpdate!.payload as any).module_item_id).toBe('item-1')

    // extraction enqueued + session placed under the new module
    expect(enqueueExtractionJob).toHaveBeenCalledWith({ moduleItemId: 'item-1', sectionId: 'sec-1' })
    expect(writePlacementEdge).toHaveBeenCalledWith(db, 'sec-1', 'live_session', 'room-1', 'mod-1')
  })

  /* The container is found-or-created by `modules.system_kind`, never by its
     TITLE. Keying on the title meant a professor who happened to name a module
     "Classroom Uploads" adopted the system container: live-classroom decks started
     landing in their week, and the roadmap swept that week's material off the
     canvas into the off-map bench. A bucket's identity must not be a string a user
     can type. */
  it('finds-or-creates the container by system_kind, not by its title', async () => {
    const { db, recorder, filters } = makeAdminDb(happyQueues())
    await promoteUploadedDeckToModuleMaterial({ adminDb: db, room, userId: 'prof-1', deckId: 'deck-1' } as any)

    const modulesFilters = filters.filter((f) => f.table === 'modules')
    expect(modulesFilters).toEqual(expect.arrayContaining([
      { table: 'modules', col: 'system_kind', val: 'classroom_uploads' },
      { table: 'modules', col: 'section_id', val: 'sec-1' },
    ]))
    expect(modulesFilters.map((f) => f.col)).not.toContain('title')

    // …and the row it creates carries the marker, or the next call re-creates it.
    const modInsert = recorder.find((c) => c.table === 'modules' && c.op === 'insert')
    expect((modInsert!.payload as any).system_kind).toBe('classroom_uploads')
  })

  /* Audited on BOTH paths. The event was guarded on `userId`, and the headless
     scheduled-render path passes null — so the write that creates a course
     material landed with no audit trail at all, on exactly the path no human
     watched. A null actor keeps the row rather than dropping it. */
  it('audits the promotion even on the actorless scheduled-render path', async () => {
    const { db } = makeAdminDb(happyQueues())
    await promoteUploadedDeckToModuleMaterial({ adminDb: db, room, userId: null, deckId: 'deck-1' } as any)

    expect(logEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logEvent).mock.calls[0][0]).toMatchObject({
      userId: null,
      eventType: 'lc_room.deck_promoted_to_material',
      sectionId: 'sec-1',
      // Names who did it and what state the material landed in, since the row
      // itself can no longer be assumed student-visible.
      metadata: expect.objectContaining({
        roomId: 'room-1',
        deckId: 'deck-1',
        visibleToStudents: false,
        actor: 'system:scheduled-render',
      }),
    })
  })

  it('attributes a professor-triggered promotion to that professor', async () => {
    const { db } = makeAdminDb(happyQueues())
    await promoteUploadedDeckToModuleMaterial({ adminDb: db, room, userId: 'prof-1', deckId: 'deck-1' } as any)
    expect(vi.mocked(logEvent).mock.calls[0][0]).toMatchObject({
      userId: 'prof-1',
      metadata: expect.objectContaining({ actor: 'professor' }),
    })
  })

  it('does NOT clobber an existing real-module placement (still creates the material)', async () => {
    const { db, recorder } = makeAdminDb(
      happyQueues({ roadmap_edges: [{ data: [{ id: 'edge-1' }], error: null }] }),
    )
    await promoteUploadedDeckToModuleMaterial({ adminDb: db, room, userId: 'prof-1', deckId: 'deck-1' } as any)

    // material + extraction still happen…
    expect(recorder.find((c) => c.table === 'module_items' && c.op === 'insert')).toBeTruthy()
    expect(enqueueExtractionJob).toHaveBeenCalledTimes(1)
    // …but the session is NOT re-placed (a real module pick already owns it)
    expect(writePlacementEdge).not.toHaveBeenCalled()
  })

  it('skips a deck already linked to a module item (idempotent re-render)', async () => {
    const { db, download } = makeAdminDb({
      lc_decks: [{ data: { id: 'deck-1', title: 'x.pdf', source_file_path: 'room-1/deck-1/source.pdf', module_item_id: 'existing-item' }, error: null }],
    })
    await promoteUploadedDeckToModuleMaterial({ adminDb: db, room, userId: 'prof-1', deckId: 'deck-1' } as any)

    expect(download).not.toHaveBeenCalled()
    expect(enqueueExtractionJob).not.toHaveBeenCalled()
    expect(writePlacementEdge).not.toHaveBeenCalled()
  })

  it('skips a deck with no source file', async () => {
    const { db, download } = makeAdminDb({
      lc_decks: [{ data: { id: 'deck-1', title: 'x.pdf', source_file_path: null, module_item_id: null }, error: null }],
    })
    await promoteUploadedDeckToModuleMaterial({ adminDb: db, room, userId: 'prof-1', deckId: 'deck-1' } as any)
    expect(download).not.toHaveBeenCalled()
    expect(writePlacementEdge).not.toHaveBeenCalled()
  })

  it('rejects a non-canonical / disallowed source extension before any copy', async () => {
    const { db, download } = makeAdminDb({
      lc_decks: [{ data: { id: 'deck-1', title: 'x.docx', source_file_path: 'room-1/deck-1/source.docx', module_item_id: null }, error: null }],
    })
    await promoteUploadedDeckToModuleMaterial({ adminDb: db, room, userId: 'prof-1', deckId: 'deck-1' } as any)
    expect(download).not.toHaveBeenCalled()
  })

  it('types the material from the source file, not from what the deck is called', async () => {
    /* A professor naming a deck "notes.txt" does not make their PDF a text
       file. This used to infer the type from the TITLE, which both refused to
       promote a perfectly good PDF and — once .txt gained a real extractor —
       would have run the plain-text reader over PDF bytes. */
    const { db, download } = makeAdminDb({
      lc_decks: [{ data: { id: 'deck-1', title: 'notes.txt', source_file_path: 'room-1/deck-1/source.pdf', module_item_id: null }, error: null }],
    })
    await promoteUploadedDeckToModuleMaterial({ adminDb: db, room, userId: 'prof-1', deckId: 'deck-1' } as any)
    expect(download).toHaveBeenCalled()
  })
})
