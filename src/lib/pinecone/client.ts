// INTERNAL to src/lib/pinecone/ — the only place the raw Pinecone SDK is
// touched. Nothing here is exported from the wrapper's public surface
// (data.ts / search.ts); the raw Index object never leaves this module.

import 'server-only'

import { Pinecone, type Index } from '@pinecone-database/pinecone'
import type { RubricReferenceMetadata } from './metadata'
import { namespaceFor } from './namespace'

/** The index holds two content classes (course_material page vectors and
 *  lecture_transcript slide vectors), so the SDK-level type is the flat-scalar
 *  shape they share — the REAL contracts are the zod whitelists in metadata.ts,
 *  parsed on every upsert and every query result in data.ts. */
type IndexMetadata = Record<string, string | number>

let client: Pinecone | null = null

function getClient(): Pinecone {
  const apiKey = process.env.PINECONE_API_KEY
  if (!apiKey) throw new Error('PINECONE_API_KEY is not set')
  client ??= new Pinecone({ apiKey })
  return client
}

/** Index name comes from env — the env var is the blue/green alias. */
function getMaterialsIndexName(): string {
  const name = process.env.PINECONE_INDEX_MATERIALS
  if (!name) throw new Error('PINECONE_INDEX_MATERIALS is not set')
  return name
}

/**
 * Namespace-bound handle for one tenant's slice of the materials index.
 * The namespace is always derived — callers can never pass one.
 */
export function materialsNamespace(
  institutionId: string,
  sectionId: string,
): Index<IndexMetadata> {
  return getClient()
    .index<IndexMetadata>(getMaterialsIndexName())
    .namespace(namespaceFor(institutionId, sectionId))
}

/**
 * Namespace-bound handle for one tenant's rubric reference slice of the materials index.
 * Reuses the same index as course materials (same model + dimension), scoped by content_class filter.
 */
export function rubricReferencesNamespace(
  institutionId: string,
  sectionId: string,
): Index<RubricReferenceMetadata & Record<string, string | number>> {
  return getClient()
    .index<RubricReferenceMetadata & Record<string, string | number>>(getMaterialsIndexName())
    .namespace(namespaceFor(institutionId, sectionId))
}

/**
 * Refuses vector WRITES from a non-production process.
 *
 * There is ONE Pinecone index and the env var naming it is the same in every environment, so a
 * `npm run dev` on a laptop upserts straight into the production namespace. That is not theoretical:
 * 717 orphan vectors were purged from the production index in August and the cause was never closed.
 *
 * WRITES ONLY, deliberately. A read cannot pollute the index, and blocking reads would break local
 * search and retrieval for no safety gain. The orphan incident was caused by upserts.
 *
 * It THROWS rather than silently skipping. A skipped write would leave local search quietly
 * returning nothing, which looks like a broken feature and sends the next person debugging the wrong
 * thing. An error names the problem and tells you how to proceed.
 *
 * The opt-out exists because ingestion sometimes genuinely needs testing. Making it an explicit,
 * per-shell decision is the whole point: the dangerous thing stops being the default.
 *
 * SCOPE, so nobody mistakes this for more than it is: NODE_ENV separates a BUILT IMAGE from a
 * laptop, not production from staging. The Dockerfile sets NODE_ENV=production in the stage that
 * runs the server, so a staging container passes this check and could write into the same shared
 * index under section ids that exist in no production row. Today staging is given no
 * PINECONE_API_KEY, so it fails earlier for an unrelated reason. Giving staging a key means giving
 * it its own index or an explicit deny; this guard will not cover it.
 */
export function assertVectorWritesAllowed(op: string): void {
  if (process.env.NODE_ENV === 'production') return
  if (process.env.PINECONE_ALLOW_NONPROD_WRITES === 'true') return
  throw new Error(
    `pinecone: refusing ${op} outside production. There is one shared index, so a local run writes ` +
      'into the production namespace. Set PINECONE_ALLOW_NONPROD_WRITES=true for this shell if that ' +
      'is what you intend.',
  )
}

/** The Pinecone TS SDK has no built-in timeout — every data-plane call gets one. */
export async function withTimeout<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`pinecone: ${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
