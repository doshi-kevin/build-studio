// Tests for the Pinecone wrapper's security-critical invariants: the id
// grammar (idempotency + prefix-delete correctness), namespace derivation
// (the tenant wall), the strict metadata whitelist, and the data-plane
// guards (dimension, tenant stamp on upsert AND query results).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildPageVectorId, materialVectorPrefix } from '@/lib/pinecone/ids'
import { namespaceFor } from '@/lib/pinecone/namespace'
import { materialPageMetadataSchema, type MaterialPageMetadata } from '@/lib/pinecone/metadata'
import { EMBEDDING_DIM } from '@/lib/pinecone/config'

const upsert = vi.fn()
const query = vi.fn()
const listPaginated = vi.fn()
const deleteMany = vi.fn()

vi.mock('@/lib/pinecone/client', () => ({
  materialsNamespace: () => ({ upsert, query, listPaginated, deleteMany }),
  withTimeout: <T,>(p: Promise<T>) => p,
  /* A plain no-op, deliberately not vi.fn(): the `vi.clearAllMocks()` below would
     strip a mock implementation, and on vitest 4 a mock that throws also makes
     caught errors surface as test failures. This file's subject is the tenant and
     metadata validation, so the non-production write gate is simply switched off.
     Its own behaviour is covered in pinecone-nonprod-write-guard.test.ts. */
  assertVectorWritesAllowed: () => {},
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
const recordExternalUsage = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/costs/external-usage', () => ({
  recordExternalUsage: (...a: unknown[]) => recordExternalUsage(...a),
}))

import {
  deleteMaterialVectors,
  deleteTranscriptVectors,
  queryCourseContentVectors,
  queryMaterialPageVectors,
  upsertMaterialPageVectors,
  upsertTranscriptVectors,
} from '@/lib/pinecone/data'
import { buildTranscriptVectorId, transcriptVectorPrefix } from '@/lib/pinecone/ids'
import type { TranscriptSlideMetadata } from '@/lib/pinecone/metadata'

// Valid RFC-4122 v4 uuids — zod's .uuid() checks version/variant bits.
const ITEM_ID = 'a1b2c3d4-1111-4111-8111-000000000001'
const MODULE_ID = 'a1b2c3d4-1111-4111-8111-000000000004'
const FOREIGN_INSTITUTION = 'a1b2c3d4-1111-4111-8111-00000000ffff'
const SCOPE = {
  institutionId: 'a1b2c3d4-1111-4111-8111-000000000002',
  sectionId: 'a1b2c3d4-1111-4111-8111-000000000003',
}

function validMetadata(overrides: Partial<MaterialPageMetadata> = {}): MaterialPageMetadata {
  return {
    institution_id: SCOPE.institutionId,
    section_id: SCOPE.sectionId,
    module_id: MODULE_ID,
    module_item_id: ITEM_ID,
    page_number: 1,
    content_class: 'course_material',
    schema_version: 1,
    embedding_model: 'gemini-embedding-2',
    chunker_version: 'page-v1',
    ...overrides,
  }
}

const ROOM_ID = 'a1b2c3d4-1111-4111-8111-00000000000c'
const DECK_ID = 'a1b2c3d4-1111-4111-8111-00000000000d'
const OTHER_DECK_ID = 'a1b2c3d4-1111-4111-8111-00000000000e'

function validTranscriptMetadata(
  overrides: Partial<TranscriptSlideMetadata> = {},
): TranscriptSlideMetadata {
  return {
    institution_id: SCOPE.institutionId,
    section_id: SCOPE.sectionId,
    room_id: ROOM_ID,
    deck_id: DECK_ID,
    page_number: 0,
    content_class: 'lecture_transcript',
    schema_version: 1,
    embedding_model: 'gemini-embedding-2',
    chunker_version: 'slide-v1',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildPageVectorId', () => {
  it('zero-pads so page 1 is never a prefix of page 10+', () => {
    const p1 = buildPageVectorId(ITEM_ID, 1)
    const p10 = buildPageVectorId(ITEM_ID, 10)
    expect(p1).toBe(`${ITEM_ID}#p0001`)
    expect(p10).toBe(`${ITEM_ID}#p0010`)
    expect(p10.startsWith(p1)).toBe(false)
  })

  it('rejects invalid page numbers and ids containing the separator', () => {
    expect(() => buildPageVectorId(ITEM_ID, 0)).toThrow()
    expect(() => buildPageVectorId(ITEM_ID, 1.5)).toThrow()
    expect(() => buildPageVectorId(ITEM_ID, 10_000)).toThrow()
    expect(() => buildPageVectorId('bad#id', 1)).toThrow()
    expect(() => buildPageVectorId('', 1)).toThrow()
  })

  it('every page id matches the material delete prefix', () => {
    expect(buildPageVectorId(ITEM_ID, 42).startsWith(materialVectorPrefix(ITEM_ID))).toBe(true)
  })
})

describe('namespaceFor', () => {
  it('derives the tenant namespace from uuid components', () => {
    expect(namespaceFor(SCOPE.institutionId, SCOPE.sectionId)).toBe(
      `inst_${SCOPE.institutionId}__sec_${SCOPE.sectionId}`,
    )
    // Hand-crafted (non-RFC-variant) uuids that exist in prod must pass.
    expect(() => namespaceFor('00000000-0000-0000-0000-000000000002', SCOPE.sectionId)).not.toThrow()
  })

  it('rejects non-uuid components (delimiter-injection guard)', () => {
    expect(() => namespaceFor('', SCOPE.sectionId)).toThrow()
    expect(() => namespaceFor(SCOPE.institutionId, '')).toThrow()
    // A crafted component containing the separator must never build a namespace.
    expect(() => namespaceFor('x__sec_y', SCOPE.sectionId)).toThrow()
    expect(() => namespaceFor(SCOPE.institutionId, 'not-a-uuid')).toThrow()
  })
})

describe('materialPageMetadataSchema', () => {
  it('accepts the exact whitelist', () => {
    expect(() => materialPageMetadataSchema.parse(validMetadata())).not.toThrow()
  })

  it('rejects extra keys (closed whitelist — no PII or text can sneak in)', () => {
    expect(() =>
      materialPageMetadataSchema.parse({ ...validMetadata(), student_email: 'x@y.edu' }),
    ).toThrow()
    expect(() =>
      materialPageMetadataSchema.parse({ ...validMetadata(), chunk_text: 'page text' }),
    ).toThrow()
  })

  it('accepts hand-crafted (non-RFC-variant) uuids that exist in prod', () => {
    // Regression: the Scholera Dev institution id has a 0 version nibble,
    // which zod's strict .uuid() rejects.
    expect(() =>
      materialPageMetadataSchema.parse(
        validMetadata({ institution_id: '00000000-0000-0000-0000-000000000002' }),
      ),
    ).not.toThrow()
  })

  it('rejects wrong content class and non-uuid ids', () => {
    expect(() =>
      materialPageMetadataSchema.parse(validMetadata({ content_class: 'student_essay' as never })),
    ).toThrow()
    expect(() =>
      materialPageMetadataSchema.parse(validMetadata({ institution_id: 'not-a-uuid' })),
    ).toThrow()
  })
})

describe('upsertMaterialPageVectors', () => {
  const goodVector = () => ({
    id: buildPageVectorId(ITEM_ID, 1),
    values: new Array(EMBEDDING_DIM).fill(0.1),
    metadata: validMetadata(),
  })

  it('upserts validated records', async () => {
    await upsertMaterialPageVectors(SCOPE, [goodVector()])
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert.mock.calls[0][0].records).toHaveLength(1)
  })

  it('meters estimated write units from binary record size (not JSON size)', async () => {
    await upsertMaterialPageVectors(SCOPE, [goodVector()])
    // One 3072-dim record: (3072·4 + 300)/1024 ≈ 12.3 KB → 13 WU, but the
    // per-request minimum of 5 doesn't bind here.
    expect(recordExternalUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'pinecone',
        feature: 'material_upsert',
        quantity: 13,
        institutionId: SCOPE.institutionId,
        metadata: expect.objectContaining({ estimated: true }),
      }),
    )
  })

  it('throws on wrong dimension before anything is sent', async () => {
    const v = { ...goodVector(), values: [0.1, 0.2] }
    await expect(upsertMaterialPageVectors(SCOPE, [v])).rejects.toThrow(/dim/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('throws when metadata tenant does not match the scope (cross-tenant write)', async () => {
    const v = {
      ...goodVector(),
      metadata: validMetadata({ institution_id: FOREIGN_INSTITUTION }),
    }
    await expect(upsertMaterialPageVectors(SCOPE, [v])).rejects.toThrow(/tenant/)
    expect(upsert).not.toHaveBeenCalled()
  })
})

describe('queryMaterialPageVectors', () => {
  it('throws loudly when a result carries a foreign tenant stamp', async () => {
    query.mockResolvedValue({
      matches: [
        {
          id: buildPageVectorId(ITEM_ID, 1),
          score: 0.9,
          metadata: validMetadata({ institution_id: FOREIGN_INSTITUTION }),
        },
      ],
    })
    await expect(
      queryMaterialPageVectors(SCOPE, new Array(EMBEDDING_DIM).fill(0.1)),
    ).rejects.toThrow(/tenant mismatch/)
  })

  it('returns matches whose stamps check out', async () => {
    query.mockResolvedValue({
      matches: [{ id: buildPageVectorId(ITEM_ID, 2), score: 0.8, metadata: validMetadata({ page_number: 2 }) }],
    })
    const out = await queryMaterialPageVectors(SCOPE, new Array(EMBEDDING_DIM).fill(0.1))
    expect(out).toHaveLength(1)
    expect(out[0].metadata.page_number).toBe(2)
  })

  it('meters the exact read units the query response reports', async () => {
    query.mockResolvedValue({ matches: [], usage: { readUnits: 3 } })
    await queryMaterialPageVectors(SCOPE, new Array(EMBEDDING_DIM).fill(0.1))
    expect(recordExternalUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'pinecone', feature: 'material_query', quantity: 3 }),
    )
  })

  it('records nothing when the response carries no usage (never a $0 noise row)', async () => {
    query.mockResolvedValue({ matches: [] })
    await queryMaterialPageVectors(SCOPE, new Array(EMBEDDING_DIM).fill(0.1))
    expect(recordExternalUsage).not.toHaveBeenCalled()
  })

  it('pins the query to course_material, and composes that with the item narrowing', async () => {
    // The namespace also holds lecture_transcript vectors (N1), and this
    // function's contract — every caller, incl. the roadmap rail — is material
    // pages only. Nothing else pins the class filter, so a refactor that folds
    // it back into the optional `moduleItemId` spread would be silent here and
    // blow up at runtime on the first transcript hit (the strict material
    // schema rejects it and the whole search throws).
    query.mockResolvedValue({ matches: [] })
    await queryMaterialPageVectors(SCOPE, new Array(EMBEDDING_DIM).fill(0.1))
    expect(query.mock.calls[0][0].filter).toEqual({ content_class: { $eq: 'course_material' } })

    await queryMaterialPageVectors(SCOPE, new Array(EMBEDDING_DIM).fill(0.1), {
      moduleItemId: ITEM_ID,
    })
    expect(query.mock.calls[1][0].filter).toEqual({
      content_class: { $eq: 'course_material' },
      module_item_id: { $eq: ITEM_ID },
    })
  })
})

describe('upsertTranscriptVectors', () => {
  const goodVector = () => ({
    id: buildTranscriptVectorId(ROOM_ID, DECK_ID, 0),
    values: new Array(EMBEDDING_DIM).fill(0.1),
    metadata: validTranscriptMetadata(),
  })

  it('upserts validated records under the transcript cost line', async () => {
    await upsertTranscriptVectors(SCOPE, [goodVector()])
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(recordExternalUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'pinecone', feature: 'transcript_upsert' }),
    )
  })

  it('refuses a wrong-dimension, off-whitelist or cross-tenant record before anything is sent', async () => {
    // The guards are hand-copied from the material twin, so they need their own
    // coverage — in particular the SECTION leg, which the material tests never
    // exercise: a transcript from another section of the same institution is
    // exactly the cross-tenant write this check exists to stop.
    await expect(
      upsertTranscriptVectors(SCOPE, [{ ...goodVector(), values: [0.1, 0.2] }]),
    ).rejects.toThrow(/dim/)
    await expect(
      upsertTranscriptVectors(SCOPE, [
        { ...goodVector(), metadata: { ...validTranscriptMetadata(), text: 'spoken words' } as never },
      ]),
    ).rejects.toThrow()
    await expect(
      upsertTranscriptVectors(SCOPE, [
        {
          ...goodVector(),
          metadata: validTranscriptMetadata({ section_id: 'a1b2c3d4-1111-4111-8111-0000000000ff' }),
        },
      ]),
    ).rejects.toThrow(/tenant/)
    expect(upsert).not.toHaveBeenCalled()
  })
})

describe('deleteTranscriptVectors', () => {
  it('narrows to one deck, and that prefix cannot reach a sibling deck', async () => {
    // removeDeck erases ONE deck's lc_transcriptions rows, so the erasure must
    // match that grain — a room-wide prefix here would silently wipe the rest
    // of the class's spoken record along with it.
    listPaginated.mockResolvedValueOnce({ vectors: [{ id: buildTranscriptVectorId(ROOM_ID, DECK_ID, 0) }] })
    const deleted = await deleteTranscriptVectors(SCOPE, ROOM_ID, { deckId: DECK_ID })
    expect(deleted).toBe(1)
    const prefix = listPaginated.mock.calls[0][0].prefix
    expect(prefix).toBe(`${ROOM_ID}#t_${DECK_ID}#s`)
    expect(buildTranscriptVectorId(ROOM_ID, OTHER_DECK_ID, 0).startsWith(prefix)).toBe(false)
  })

  it('sweeps the whole room when no deck is named, following pagination', async () => {
    listPaginated
      .mockResolvedValueOnce({
        vectors: [{ id: buildTranscriptVectorId(ROOM_ID, DECK_ID, 0) }],
        pagination: { next: 'tok' },
      })
      .mockResolvedValueOnce({ vectors: [{ id: buildTranscriptVectorId(ROOM_ID, OTHER_DECK_ID, 3) }] })
    const deleted = await deleteTranscriptVectors(SCOPE, ROOM_ID)
    expect(deleted).toBe(2)
    expect(listPaginated.mock.calls[0][0].prefix).toBe(transcriptVectorPrefix(ROOM_ID))
    expect(deleteMany).toHaveBeenCalledTimes(2)
  })

  it('is a safe no-op when the room never had vectors', async () => {
    listPaginated.mockResolvedValueOnce({ vectors: [] })
    expect(await deleteTranscriptVectors(SCOPE, ROOM_ID, { deckId: DECK_ID })).toBe(0)
    expect(deleteMany).not.toHaveBeenCalled()
  })
})

describe('queryCourseContentVectors', () => {
  it('asks for BOTH allowlisted classes and parses each result under its own schema', async () => {
    query.mockResolvedValue({
      matches: [
        { id: buildTranscriptVectorId(ROOM_ID, DECK_ID, 3), score: 0.9, metadata: validTranscriptMetadata({ page_number: 3 }) },
        { id: buildPageVectorId(ITEM_ID, 2), score: 0.6, metadata: validMetadata({ page_number: 2 }) },
      ],
    })
    const out = await queryCourseContentVectors(SCOPE, new Array(EMBEDDING_DIM).fill(0.1))
    expect(query.mock.calls[0][0].filter).toEqual({
      content_class: { $in: ['course_material', 'lecture_transcript'] },
    })
    // Discriminated union — the caller splits lanes on this field, so a widened
    // parse that let an unknown class through would reach the search layer.
    expect(out.map((m) => m.metadata.content_class)).toEqual(['lecture_transcript', 'course_material'])
  })

  it('throws loudly when a pooled result carries a foreign tenant stamp', async () => {
    query.mockResolvedValue({
      matches: [
        {
          id: buildTranscriptVectorId(ROOM_ID, DECK_ID, 0),
          score: 0.9,
          metadata: validTranscriptMetadata({ institution_id: FOREIGN_INSTITUTION }),
        },
      ],
    })
    await expect(
      queryCourseContentVectors(SCOPE, new Array(EMBEDDING_DIM).fill(0.1)),
    ).rejects.toThrow(/tenant mismatch/)
  })
})

describe('deleteMaterialVectors', () => {
  it('lists by prefix and deletes, following pagination', async () => {
    listPaginated
      .mockResolvedValueOnce({
        vectors: [{ id: `${ITEM_ID}#p0001` }, { id: `${ITEM_ID}#p0002` }],
        pagination: { next: 'tok' },
      })
      .mockResolvedValueOnce({ vectors: [{ id: `${ITEM_ID}#p0003` }] })
    const deleted = await deleteMaterialVectors(SCOPE, ITEM_ID)
    expect(deleted).toBe(3)
    expect(listPaginated).toHaveBeenCalledTimes(2)
    expect(listPaginated.mock.calls[0][0].prefix).toBe(`${ITEM_ID}#p`)
    expect(deleteMany).toHaveBeenCalledTimes(2)
  })

  it('beyondPage deletes only the stale tail of a shorter re-upload', async () => {
    listPaginated.mockResolvedValueOnce({
      vectors: [{ id: `${ITEM_ID}#p0001` }, { id: `${ITEM_ID}#p0002` }, { id: `${ITEM_ID}#p0003` }],
    })
    const deleted = await deleteMaterialVectors(SCOPE, ITEM_ID, { beyondPage: 2 })
    expect(deleted).toBe(1)
    expect(deleteMany).toHaveBeenCalledWith({ ids: [`${ITEM_ID}#p0003`] })
  })

  it('meters deleted-record WUs and list-call RUs', async () => {
    listPaginated.mockResolvedValueOnce({
      vectors: [{ id: `${ITEM_ID}#p0001` }, { id: `${ITEM_ID}#p0002` }],
    })
    await deleteMaterialVectors(SCOPE, ITEM_ID)
    // 2 records × ceil(12.3 KB) = 26 WU; 1 list call = 1 RU.
    expect(recordExternalUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'pinecone', feature: 'material_delete', quantity: 26 }),
    )
    expect(recordExternalUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'pinecone', feature: 'material_list', quantity: 1 }),
    )
  })

  it('skips the delete row when nothing matched (list still metered)', async () => {
    listPaginated.mockResolvedValueOnce({ vectors: [] })
    await deleteMaterialVectors(SCOPE, ITEM_ID)
    const features = recordExternalUsage.mock.calls.map((c) => (c[0] as { feature: string }).feature)
    expect(features).toEqual(['material_list'])
  })
})
