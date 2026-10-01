/**
 * Local runs must not write into the production vector index.
 *
 * There is ONE Pinecone index and the env var naming it is identical in every environment, so a
 * `npm run dev` on a laptop upserts straight into the production namespace. Not theoretical: 717
 * orphan vectors were purged from production in August and the cause was never closed.
 *
 * WRITES ONLY. A read cannot pollute the index, and blocking reads would break local search for no
 * safety gain.
 *
 * NOTE ON VALIDATION. This is unit-tested but has NOT been exercised against a live index, because
 * the Pinecone API key is being rotated. The end-to-end check is queued: with a working key, confirm
 * that a local ingestion refuses loudly, that setting PINECONE_ALLOW_NONPROD_WRITES=true lets it
 * through, and that production ingestion is unaffected.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { assertVectorWritesAllowed } from '@/lib/pinecone/client'

const originalNodeEnv = process.env.NODE_ENV
const originalOptIn = process.env.PINECONE_ALLOW_NONPROD_WRITES

function setNodeEnv(value: string | undefined) {
  /* NODE_ENV is readonly in the Node TYPES but a plain assignment works at runtime. `defineProperty`
     does not: process.env rejects a descriptor that is not configurable, writable AND enumerable. */
  const env = process.env as Record<string, string | undefined>
  if (value === undefined) delete env.NODE_ENV
  else env.NODE_ENV = value
}

afterEach(() => {
  setNodeEnv(originalNodeEnv)
  if (originalOptIn === undefined) delete process.env.PINECONE_ALLOW_NONPROD_WRITES
  else process.env.PINECONE_ALLOW_NONPROD_WRITES = originalOptIn
})

describe('pinecone write guard', () => {
  it('refuses a write outside production', () => {
    setNodeEnv('development')
    delete process.env.PINECONE_ALLOW_NONPROD_WRITES

    expect(() => assertVectorWritesAllowed('upsertMaterialPageVectors')).toThrow(/refusing upsertMaterialPageVectors/)
  })

  it('names the opt-out in the error, so the message is actionable', () => {
    /* An error that only says "refused" sends the next person reading the client source. */
    setNodeEnv('development')
    delete process.env.PINECONE_ALLOW_NONPROD_WRITES

    expect(() => assertVectorWritesAllowed('x')).toThrow(/PINECONE_ALLOW_NONPROD_WRITES/)
  })

  it('allows a write in production', () => {
    setNodeEnv('production')
    delete process.env.PINECONE_ALLOW_NONPROD_WRITES

    expect(() => assertVectorWritesAllowed('upsertTranscriptVectors')).not.toThrow()
  })

  it('allows a write when explicitly opted in', () => {
    /* Ingestion sometimes genuinely needs testing. The point is that it is a deliberate per-shell
       decision rather than the default. */
    setNodeEnv('development')
    process.env.PINECONE_ALLOW_NONPROD_WRITES = 'true'

    expect(() => assertVectorWritesAllowed('upsertMaterialPageVectors')).not.toThrow()
  })

  it('does not treat any other value as opt-in', () => {
    setNodeEnv('development')
    process.env.PINECONE_ALLOW_NONPROD_WRITES = '1'

    expect(() => assertVectorWritesAllowed('x')).toThrow()
  })
})

describe('every write path is guarded, and no read path is', () => {
  /* Source-level, because the guard is a one-line call that is easy to omit on a NEW
     write function, and omitting it fails silently by deleting from or polluting the
     production index.

     This DERIVES the list of write functions from the source instead of naming them.
     The first version of this test hardcoded five names and passed while a sixth,
     deleteRubricReferenceVectors, was unguarded — an allowlist cannot detect the
     omission it exists to catch. Anything that reaches the index must be listed in
     MUTATIONS below, so a new write function fails this test until it is guarded. */
  const MUTATIONS = ['upsert', 'deleteMany', 'deleteAll', 'deleteOne', 'update']

  function exportedFunctions(src: string) {
    return src
      .split(/^export async function /m)
      .slice(1)
      .map((body) => ({ name: body.slice(0, body.indexOf('(')), body }))
  }

  async function readDataSource() {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    return readFileSync(join(process.cwd(), 'src/lib/pinecone/data.ts'), 'utf8')
  }

  const mutates = (body: string) =>
    MUTATIONS.some((m) => body.includes(`.${m}(`))

  it('guards every function that reaches the index', async () => {
    const fns = exportedFunctions(await readDataSource())

    /* Guards against the file being renamed or the split pattern silently matching
       nothing, which would make every assertion below vacuous. */
    expect(fns.length).toBeGreaterThan(5)

    const writers = fns.filter((f) => mutates(f.body))
    expect(writers.length).toBeGreaterThan(0)

    const unguarded = writers
      .filter((f) => !f.body.includes('assertVectorWritesAllowed('))
      .map((f) => f.name)

    expect(unguarded).toEqual([])
  })

  it('leaves every read path unguarded', async () => {
    const fns = exportedFunctions(await readDataSource())

    /* Reads must keep working locally, so search and retrieval are still testable
       without the opt-in. Asserted per function rather than by grepping for
       "query", which missed fetchRubricReferenceVectors. */
    const guardedReads = fns
      .filter((f) => !mutates(f.body) && f.body.includes('assertVectorWritesAllowed('))
      .map((f) => f.name)

    expect(guardedReads).toEqual([])
  })
})
