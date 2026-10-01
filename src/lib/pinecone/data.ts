// Public data-plane surface of the Pinecone wrapper. Every function takes the
// tenant ids explicitly (verified upstream by the caller — worker params or an
// authorized action) and derives the namespace internally. See
// .claude/rules/vector-db.md; these are security rules.

import 'server-only'

import { logger } from '@/lib/logger'
import { recordExternalUsage } from '@/lib/costs/external-usage'
import { materialsNamespace, rubricReferencesNamespace, assertVectorWritesAllowed, withTimeout } from './client'
import {
  CONTENT_CLASS_COURSE_MATERIAL,
  CONTENT_CLASS_LECTURE_TRANSCRIPT,
  EMBEDDING_DIM,
} from './config'
import { materialVectorPrefix, rubricReferenceVectorPrefix, transcriptVectorPrefix } from './ids'
import {
  materialPageMetadataSchema,
  rubricReferenceMetadataSchema,
  transcriptSlideMetadataSchema,
  vectorMetadataSchema,
  type MaterialPageMetadata,
  type RubricReferenceMetadata,
  type TranscriptSlideMetadata,
  type VectorMetadata,
} from './metadata'

/** Pinecone serverless caps: ≤1,000 records / 2 MB per upsert; ≤1,000 ids per delete. */
const UPSERT_BATCH_SIZE = 100
const DELETE_BATCH_SIZE = 1000

/**
 * Pinecone bills writes at 1 WU per KB of the record, minimum 5 WU per
 * request, sized on BINARY storage: dimension × 4 bytes (f32) + id + metadata.
 * (Never size from the JSON request body — floats serialize ~4.5× larger.)
 * Upsert/delete responses don't report WUs, so rows land metadata.estimated.
 */
const RECORD_OVERHEAD_BYTES = 300 // id + flat metadata, typical material page
const recordBytes = (dim: number) => dim * 4 + RECORD_OVERHEAD_BYTES
const writeUnitsFor = (records: number, dim: number) =>
  Math.max(5, Math.ceil((records * recordBytes(dim)) / 1024))

export interface MaterialPageVector {
  id: string
  values: number[]
  metadata: MaterialPageMetadata
}

export interface TenantScope {
  institutionId: string
  sectionId: string
}

/**
 * Upsert page vectors for one tenant. Validates every record against the
 * strict metadata whitelist and the pinned dimension before anything is sent.
 */
export async function upsertMaterialPageVectors(
  scope: TenantScope,
  vectors: MaterialPageVector[],
): Promise<void> {
  if (vectors.length === 0) return
  /* After the empty check on purpose: a call that would send nothing stays a no-op
     rather than throwing. See assertVectorWritesAllowed for why writes are gated. */
  assertVectorWritesAllowed('upsertMaterialPageVectors')
  for (const v of vectors) {
    materialPageMetadataSchema.parse(v.metadata)
    if (v.values.length !== EMBEDDING_DIM) {
      throw new Error(`upsertMaterialPageVectors: vector ${v.id} has dim ${v.values.length}, expected ${EMBEDDING_DIM}`)
    }
    if (v.metadata.institution_id !== scope.institutionId || v.metadata.section_id !== scope.sectionId) {
      throw new Error(`upsertMaterialPageVectors: vector ${v.id} metadata tenant does not match scope`)
    }
  }
  const ns = materialsNamespace(scope.institutionId, scope.sectionId)
  let writeUnits = 0
  for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
    const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE)
    await withTimeout(ns.upsert({ records: batch }), `upsert batch ${i / UPSERT_BATCH_SIZE}`)
    writeUnits += writeUnitsFor(batch.length, EMBEDDING_DIM)
  }
  void recordExternalUsage({
    provider: 'pinecone',
    feature: 'material_upsert',
    quantity: writeUnits,
    institutionId: scope.institutionId,
    sectionId: scope.sectionId,
    metadata: { estimated: true, records: vectors.length },
  })
}

/** One (deck, slide)'s spoken text — content class `lecture_transcript` (N1). */
export interface TranscriptSlideVector {
  id: string
  values: number[]
  metadata: TranscriptSlideMetadata
}

/**
 * Upsert transcript-slide vectors for one tenant — the `lecture_transcript`
 * twin of `upsertMaterialPageVectors`, same whitelist/dimension/tenant checks.
 */
export async function upsertTranscriptVectors(
  scope: TenantScope,
  vectors: TranscriptSlideVector[],
): Promise<void> {
  if (vectors.length === 0) return
  /* After the empty check on purpose: a call that would send nothing stays a no-op
     rather than throwing. See assertVectorWritesAllowed for why writes are gated. */
  assertVectorWritesAllowed('upsertTranscriptVectors')
  for (const v of vectors) {
    transcriptSlideMetadataSchema.parse(v.metadata)
    if (v.values.length !== EMBEDDING_DIM) {
      throw new Error(`upsertTranscriptVectors: vector ${v.id} has dim ${v.values.length}, expected ${EMBEDDING_DIM}`)
    }
    if (v.metadata.institution_id !== scope.institutionId || v.metadata.section_id !== scope.sectionId) {
      throw new Error(`upsertTranscriptVectors: vector ${v.id} metadata tenant does not match scope`)
    }
  }
  const ns = materialsNamespace(scope.institutionId, scope.sectionId)
  let writeUnits = 0
  for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
    const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE)
    await withTimeout(ns.upsert({ records: batch }), `transcript upsert batch ${i / UPSERT_BATCH_SIZE}`)
    writeUnits += writeUnitsFor(batch.length, EMBEDDING_DIM)
  }
  void recordExternalUsage({
    provider: 'pinecone',
    feature: 'transcript_upsert',
    quantity: writeUnits,
    institutionId: scope.institutionId,
    sectionId: scope.sectionId,
    metadata: { estimated: true, records: vectors.length },
  })
}

/**
 * Delete a room's transcript vectors by id prefix — the erasure path that ships
 * with the write path (vector-db rule 10). Pass `deckId` to narrow to one deck:
 * removeDeck is the one place lc_transcriptions rows are erased today, and it
 * works deck by deck. Safe to call when none exist.
 */
export async function deleteTranscriptVectors(
  scope: TenantScope,
  roomId: string,
  opts?: { deckId?: string },
): Promise<number> {
  /* See assertVectorWritesAllowed: writes are gated outside production. */
  assertVectorWritesAllowed('deleteTranscriptVectors')
  const ns = materialsNamespace(scope.institutionId, scope.sectionId)
  const prefix = transcriptVectorPrefix(roomId, opts?.deckId)
  let deleted = 0
  let paginationToken: string | undefined
  do {
    const page = await withTimeout(
      ns.listPaginated({ prefix, ...(paginationToken ? { paginationToken } : {}) }),
      'listPaginated',
    )
    const ids = (page.vectors ?? []).map((v) => v.id).filter((id): id is string => Boolean(id))
    for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
      const batch = ids.slice(i, i + DELETE_BATCH_SIZE)
      await withTimeout(ns.deleteMany({ ids: batch }), 'deleteMany')
      deleted += batch.length
    }
    paginationToken = page.pagination?.next
  } while (paginationToken)
  if (deleted > 0) {
    logger.info('pinecone: deleted transcript vectors', {
      source: 'pinecone.deleteTranscriptVectors',
      roomId,
      deleted,
    })
    void recordExternalUsage({
      provider: 'pinecone',
      feature: 'transcript_delete',
      quantity: deleted * Math.ceil(recordBytes(EMBEDDING_DIM) / 1024),
      institutionId: scope.institutionId,
      sectionId: scope.sectionId,
      metadata: { estimated: true, records: deleted, roomId },
    })
  }
  return deleted
}

/**
 * Delete vectors of one material by id prefix (the serverless-native
 * "delete all pages of document X" path). Safe to call when none exist.
 * Pass `beyondPage` to delete only stale trailing pages (a shorter re-upload).
 */
export async function deleteMaterialVectors(
  scope: TenantScope,
  moduleItemId: string,
  opts?: { beyondPage?: number },
): Promise<number> {
  /* See assertVectorWritesAllowed: writes are gated outside production. */
  assertVectorWritesAllowed('deleteMaterialVectors')
  const ns = materialsNamespace(scope.institutionId, scope.sectionId)
  const prefix = materialVectorPrefix(moduleItemId)
  let deleted = 0
  let listCalls = 0
  let paginationToken: string | undefined
  do {
    const page = await withTimeout(
      ns.listPaginated({ prefix, ...(paginationToken ? { paginationToken } : {}) }),
      'listPaginated',
    )
    listCalls++
    let ids = (page.vectors ?? []).map((v) => v.id).filter((id): id is string => Boolean(id))
    if (opts?.beyondPage !== undefined) {
      const cutoff = opts.beyondPage
      // Page number is the digits after '#p' — parse from the id, no fetch needed.
      ids = ids.filter((id) => Number(id.slice(prefix.length)) > cutoff)
    }
    for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
      const batch = ids.slice(i, i + DELETE_BATCH_SIZE)
      await withTimeout(ns.deleteMany({ ids: batch }), 'deleteMany')
      deleted += batch.length
    }
    paginationToken = page.pagination?.next
  } while (paginationToken)
  if (deleted > 0) {
    logger.info('pinecone: deleted material vectors', {
      source: 'pinecone.deleteMaterialVectors',
      moduleItemId,
      deleted,
    })
    // Deletes cost 1 WU per KB of the deleted record; lists cost RUs per call.
    void recordExternalUsage({
      provider: 'pinecone',
      feature: 'material_delete',
      quantity: deleted * Math.ceil(recordBytes(EMBEDDING_DIM) / 1024),
      institutionId: scope.institutionId,
      sectionId: scope.sectionId,
      metadata: { estimated: true, records: deleted, moduleItemId },
    })
  }
  if (listCalls > 0) {
    void recordExternalUsage({
      provider: 'pinecone',
      feature: 'material_list',
      quantity: listCalls,
      institutionId: scope.institutionId,
      sectionId: scope.sectionId,
      metadata: { estimated: true, moduleItemId },
    })
  }
  return deleted
}

export interface MaterialPageMatch {
  id: string
  score: number
  metadata: MaterialPageMetadata
}

/**
 * Similarity query within one tenant's namespace. Asserts the tenant stamp on
 * every match — a mismatch throws (loud error beats silent leak) because it
 * means a scoping bug upstream, never a legitimate result.
 */
export async function queryMaterialPageVectors(
  scope: TenantScope,
  vector: number[],
  opts?: { topK?: number; moduleItemId?: string },
): Promise<MaterialPageMatch[]> {
  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(`queryMaterialPageVectors: query dim ${vector.length}, expected ${EMBEDDING_DIM}`)
  }
  const ns = materialsNamespace(scope.institutionId, scope.sectionId)
  const response = await withTimeout(
    ns.query({
      vector,
      topK: opts?.topK ?? 8,
      includeValues: false,
      includeMetadata: true,
      // Pinned to course_material: the namespace also holds lecture_transcript
      // vectors (N1), and this function's result contract — and every caller,
      // incl. the roadmap rail — is material pages only.
      filter: {
        content_class: { $eq: CONTENT_CLASS_COURSE_MATERIAL },
        ...(opts?.moduleItemId ? { module_item_id: { $eq: opts.moduleItemId } } : {}),
      },
    }),
    'query',
  )
  // Serverless queries report exact read units consumed.
  const readUnits = (response as { usage?: { readUnits?: number } }).usage?.readUnits ?? 0
  if (readUnits > 0) {
    void recordExternalUsage({
      provider: 'pinecone',
      feature: 'material_query',
      quantity: readUnits,
      institutionId: scope.institutionId,
      sectionId: scope.sectionId,
    })
  }
  const matches: MaterialPageMatch[] = []
  for (const m of response.matches ?? []) {
    const metadata = materialPageMetadataSchema.parse(m.metadata)
    if (metadata.institution_id !== scope.institutionId || metadata.section_id !== scope.sectionId) {
      logger.error('pinecone: tenant mismatch in query results — scoping bug', undefined, {
        source: 'pinecone.queryMaterialPageVectors',
        expectedInstitution: scope.institutionId,
      })
      throw new Error('pinecone: tenant mismatch in query results')
    }
    matches.push({ id: m.id, score: m.score ?? 0, metadata })
  }
  return matches
}

export interface CourseContentMatch {
  id: string
  score: number
  metadata: VectorMetadata
}

/**
 * Similarity query across BOTH allowlisted content classes — course-material
 * pages and lecture-transcript slides pooled into one ranked list (the
 * student-qa-v1 shape once N1 landed: "what did he say about X" and "what does
 * the slide say about X" compete on score, not on surface). Same tenant
 * assertion as the material query; results discriminate on `content_class`.
 */
export async function queryCourseContentVectors(
  scope: TenantScope,
  vector: number[],
  opts?: { topK?: number },
): Promise<CourseContentMatch[]> {
  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(`queryCourseContentVectors: query dim ${vector.length}, expected ${EMBEDDING_DIM}`)
  }
  const ns = materialsNamespace(scope.institutionId, scope.sectionId)
  const response = await withTimeout(
    ns.query({
      vector,
      topK: opts?.topK ?? 8,
      includeValues: false,
      includeMetadata: true,
      filter: {
        content_class: { $in: [CONTENT_CLASS_COURSE_MATERIAL, CONTENT_CLASS_LECTURE_TRANSCRIPT] },
      },
    }),
    'query',
  )
  const readUnits = (response as { usage?: { readUnits?: number } }).usage?.readUnits ?? 0
  if (readUnits > 0) {
    void recordExternalUsage({
      provider: 'pinecone',
      feature: 'material_query',
      quantity: readUnits,
      institutionId: scope.institutionId,
      sectionId: scope.sectionId,
    })
  }
  const matches: CourseContentMatch[] = []
  for (const m of response.matches ?? []) {
    const metadata = vectorMetadataSchema.parse(m.metadata)
    if (metadata.institution_id !== scope.institutionId || metadata.section_id !== scope.sectionId) {
      logger.error('pinecone: tenant mismatch in query results — scoping bug', undefined, {
        source: 'pinecone.queryCourseContentVectors',
        expectedInstitution: scope.institutionId,
      })
      throw new Error('pinecone: tenant mismatch in query results')
    }
    matches.push({ id: m.id, score: m.score ?? 0, metadata })
  }
  return matches
}

// ── Rubric reference vectors ────────────────────────────────────────────────

export interface RubricReferenceVector {
  id: string
  values: number[]
  metadata: RubricReferenceMetadata
}

export async function upsertRubricReferenceVectors(
  scope: TenantScope,
  vectors: RubricReferenceVector[],
): Promise<void> {
  if (vectors.length === 0) return
  /* After the empty check on purpose: a call that would send nothing stays a no-op
     rather than throwing. See assertVectorWritesAllowed for why writes are gated. */
  assertVectorWritesAllowed('upsertRubricReferenceVectors')
  for (const v of vectors) {
    rubricReferenceMetadataSchema.parse(v.metadata)
    if (v.values.length !== EMBEDDING_DIM) {
      throw new Error(`upsertRubricReferenceVectors: vector ${v.id} has dim ${v.values.length}, expected ${EMBEDDING_DIM}`)
    }
    if (v.metadata.institution_id !== scope.institutionId || v.metadata.section_id !== scope.sectionId) {
      throw new Error(`upsertRubricReferenceVectors: vector ${v.id} metadata tenant does not match scope`)
    }
  }
  const ns = rubricReferencesNamespace(scope.institutionId, scope.sectionId)
  for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
    const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE)
    await withTimeout(ns.upsert({ records: batch }), `upsert rubric-reference batch ${i / UPSERT_BATCH_SIZE}`)
  }
}

export async function deleteRubricReferenceVectors(
  scope: TenantScope,
  assignmentId: string,
  opts?: { keepIds?: ReadonlySet<string> },
): Promise<number> {
  assertVectorWritesAllowed('deleteRubricReferenceVectors')
  const ns = rubricReferencesNamespace(scope.institutionId, scope.sectionId)
  const prefix = rubricReferenceVectorPrefix(assignmentId)
  let deleted = 0
  let paginationToken: string | undefined
  do {
    const page = await withTimeout(
      ns.listPaginated({ prefix, ...(paginationToken ? { paginationToken } : {}) }),
      'listPaginated rubric-reference',
    )
    let ids = (page.vectors ?? []).map((v) => v.id).filter((id): id is string => Boolean(id))
    if (opts?.keepIds) {
      ids = ids.filter((id) => !opts.keepIds!.has(id))
    }
    for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
      const batch = ids.slice(i, i + DELETE_BATCH_SIZE)
      await withTimeout(ns.deleteMany({ ids: batch }), 'deleteMany rubric-reference')
      deleted += batch.length
    }
    paginationToken = page.pagination?.next
  } while (paginationToken)
  if (deleted > 0) {
    logger.info('pinecone: deleted rubric reference vectors', {
      source: 'pinecone.deleteRubricReferenceVectors',
      assignmentId,
      deleted,
    })
  }
  return deleted
}

/** Reference vector fetched from Pinecone with its embedding values, for in-memory cosine matching. */
export interface RubricReferenceVectorValues {
  questionIndex: number
  criterionIndex: number
  values: number[]
}

/**
 * Fetch all rubric reference vectors for an assignment (with values) from Pinecone.
 * Used by the batch signal assembly path for in-memory cosine matching.
 *
 * Lists all ids by prefix (paginated), fetches values in batches of ≤100, validates
 * tenant stamps, returns one entry per criterion that has an embedding.
 */
export async function fetchRubricReferenceVectors(
  scope: TenantScope,
  assignmentId: string,
): Promise<RubricReferenceVectorValues[]> {
  const ns = rubricReferencesNamespace(scope.institutionId, scope.sectionId)
  const prefix = rubricReferenceVectorPrefix(assignmentId)

  // 1. Collect all vector ids by prefix (paginated).
  const ids: string[] = []
  let paginationToken: string | undefined
  do {
    const page = await withTimeout(
      ns.listPaginated({ prefix, ...(paginationToken ? { paginationToken } : {}) }),
      'listPaginated rubric-reference-fetch',
    )
    for (const v of page.vectors ?? []) {
      if (v.id) ids.push(v.id)
    }
    paginationToken = page.pagination?.next
  } while (paginationToken)

  if (ids.length === 0) return []

  // 2. Fetch values in batches of ≤100.
  const out: RubricReferenceVectorValues[] = []
  for (let i = 0; i < ids.length; i += UPSERT_BATCH_SIZE) {
    const batch = ids.slice(i, i + UPSERT_BATCH_SIZE)
    const fetched = await withTimeout(
      ns.fetch({ ids: batch }),
      'fetch rubric-reference-values',
    )
    const records = fetched.records ?? {}
    for (const record of Object.values(records)) {
      if (!record.values || record.values.length === 0) continue
      const metadata = rubricReferenceMetadataSchema.parse(record.metadata)
      // Assert tenant stamp — a mismatch is a scoping bug, never a legitimate result.
      if (
        metadata.institution_id !== scope.institutionId ||
        metadata.section_id !== scope.sectionId
      ) {
        throw new Error('pinecone: tenant mismatch in fetchRubricReferenceVectors — scoping bug')
      }
      out.push({
        questionIndex: metadata.question_index,
        criterionIndex: metadata.criterion_index,
        values: record.values,
      })
    }
  }

  return out
}

export interface RubricSimilarityMatch {
  criterionIndex: number
  score: number
}

export async function queryRubricSimilarity(
  scope: TenantScope,
  vector: number[],
  opts: { assignmentId: string; questionIndex: number; topK?: number },
): Promise<RubricSimilarityMatch[]> {
  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(`queryRubricSimilarity: query dim ${vector.length}, expected ${EMBEDDING_DIM}`)
  }
  const ns = rubricReferencesNamespace(scope.institutionId, scope.sectionId)
  const response = await withTimeout(
    ns.query({
      vector,
      topK: opts.topK ?? 20,
      includeValues: false,
      includeMetadata: true,
      filter: {
        content_class: { $eq: 'rubric_reference' },
        assignment_id: { $eq: opts.assignmentId },
        question_index: { $eq: opts.questionIndex },
      },
    }),
    'query rubric-similarity',
  )
  const matches: RubricSimilarityMatch[] = []
  for (const m of response.matches ?? []) {
    const metadata = rubricReferenceMetadataSchema.parse(m.metadata)
    if (metadata.institution_id !== scope.institutionId || metadata.section_id !== scope.sectionId) {
      logger.error('pinecone: tenant mismatch in rubric query results', undefined, {
        source: 'pinecone.queryRubricSimilarity',
        expectedInstitution: scope.institutionId,
      })
      throw new Error('pinecone: tenant mismatch in rubric query results')
    }
    matches.push({ criterionIndex: metadata.criterion_index, score: m.score ?? 0 })
  }
  return matches
}
