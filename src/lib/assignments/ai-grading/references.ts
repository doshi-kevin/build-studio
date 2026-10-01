import 'server-only'

import { logger } from '@/lib/logger'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import { embedReferenceSnippet } from '@/lib/pinecone/embed'
import {
  upsertRubricReferenceVectors,
  deleteRubricReferenceVectors,
  type TenantScope,
} from '@/lib/pinecone/data'
import { buildRubricReferenceVectorId } from '@/lib/pinecone/ids'
import {
  CONTENT_CLASS_RUBRIC_REFERENCE,
  RUBRIC_CHUNKER_VERSION,
  EMBEDDING_MODEL,
  METADATA_SCHEMA_VERSION,
} from '@/lib/pinecone/config'
import { isRubricQuestionGraded } from '@/lib/validations/assignment'
import type { AssignmentRubric } from '@/lib/validations/assignment'

const MAX_REFS = 100
const EMBED_CONCURRENCY = 4

export async function syncRubricReferenceVectors(input: {
  institutionId: string
  sectionId: string
  assignmentId: string
  rubric: AssignmentRubric
}): Promise<{ status: 'ready' | 'failed' | 'none'; refCount: number }> {
  const { institutionId, sectionId, assignmentId, rubric } = input
  const scope: TenantScope = { institutionId, sectionId }

  // Institution/platform AI kill switch — embedding + Pinecone writes are AI
  // spend. 'failed' (not 'none') so nothing prunes existing vectors and the
  // next rubric save after re-enable rebuilds them.
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const verdict = await checkAiFeature(adminDb, institutionId, 'assignment-ai')
    if (!verdict.allowed) return { status: 'failed', refCount: 0 }
  }

  // Collect all (qIdx, cIdx, referenceAnswer) triples with a non-empty referenceAnswer.
  // Questions with graded===false are skipped — their vectors are pruned by the upsert+prune
  // sequence below, so newly excluded questions auto-disappear from Pinecone.
  const refs: { qIdx: number; cIdx: number; text: string }[] = []
  rubric.questions.forEach((q, qIdx) => {
    if (!isRubricQuestionGraded(q)) return
    q.criteria.forEach((c, cIdx) => {
      if (c.referenceAnswer?.trim()) {
        refs.push({ qIdx, cIdx, text: c.referenceAnswer.trim() })
      }
    })
  })

  if (refs.length === 0) {
    // No references — delete everything for this assignment and signal 'none'.
    try {
      await deleteRubricReferenceVectors(scope, assignmentId)
    } catch (err) {
      logger.warn('syncRubricReferenceVectors: full erasure failed', {
        source: 'references.sync',
        assignmentId,
        err: String(err),
      })
    }
    return { status: 'none', refCount: 0 }
  }

  // Over the cap: embed only the first MAX_REFS, but still run the upsert+prune below so the
  // stale vectors for criteria that were removed / renumbered don't stay live (leaving them
  // would let the grader match against deleted reference answers). Truncate, warn, proceed.
  if (refs.length > MAX_REFS) {
    logger.warn('syncRubricReferenceVectors: too many references, capping and pruning the rest', {
      source: 'references.sync',
      assignmentId,
      count: refs.length,
      cap: MAX_REFS,
    })
    refs.length = MAX_REFS
  }

  try {
    // Embed with bounded concurrency (4 at a time).
    const embedded: { qIdx: number; cIdx: number; values: number[] }[] = []
    for (let i = 0; i < refs.length; i += EMBED_CONCURRENCY) {
      const batch = refs.slice(i, i + EMBED_CONCURRENCY)
      const results = await Promise.all(batch.map((r) => embedReferenceSnippet(r.text)))
      batch.forEach((r, j) => embedded.push({ qIdx: r.qIdx, cIdx: r.cIdx, values: results[j] }))
    }

    // Build vectors with deterministic ids.
    const vectors = embedded.map(({ qIdx, cIdx, values }) => ({
      id: buildRubricReferenceVectorId(assignmentId, qIdx, cIdx),
      values,
      metadata: {
        institution_id: institutionId,
        section_id: sectionId,
        assignment_id: assignmentId,
        question_index: qIdx,
        criterion_index: cIdx,
        content_class: CONTENT_CLASS_RUBRIC_REFERENCE as typeof CONTENT_CLASS_RUBRIC_REFERENCE,
        schema_version: METADATA_SCHEMA_VERSION as typeof METADATA_SCHEMA_VERSION,
        embedding_model: EMBEDDING_MODEL as typeof EMBEDDING_MODEL,
        chunker_version: RUBRIC_CHUNKER_VERSION as typeof RUBRIC_CHUNKER_VERSION,
      },
    }))

    // UPSERT first (overwrites in place with deterministic ids), THEN prune stale.
    await upsertRubricReferenceVectors(scope, vectors)

    const keepIds = new Set(vectors.map((v) => v.id))
    await deleteRubricReferenceVectors(scope, assignmentId, { keepIds })

    return { status: 'ready', refCount: refs.length }
  } catch (err) {
    logger.error('syncRubricReferenceVectors: failed', err, {
      source: 'references.sync',
      assignmentId,
    })
    return { status: 'failed', refCount: 0 }
  }
}
