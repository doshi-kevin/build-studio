// One-time (per environment) creation of the materials vector index.
// Indexes are created ONLY here — never in feature code — because metric,
// dimension, cloud/region and vector type are immutable at creation
// (.claude/rules/vector-db.md). Getting one wrong = full re-embed.
//
// Usage:
//   PINECONE_API_KEY=... PINECONE_INDEX_MATERIALS=prod-materials-ge2-3072-v1 \
//     npx tsx scripts/pinecone-create-materials-index.ts
//
// Add PINECONE_DISABLE_DELETION_PROTECTION=1 only for throwaway dev indexes.

import { Pinecone } from '@pinecone-database/pinecone'

// Immutables — must match src/lib/pinecone/config.ts (EMBEDDING_DIM) and the
// design doc (cosine, serverless gcp/us-central1, next to Cloud Run).
const DIMENSION = 3072
const METRIC = 'cosine' as const
const CLOUD = 'gcp'
const REGION = 'us-central1'

async function main() {
  const apiKey = process.env.PINECONE_API_KEY
  const name = process.env.PINECONE_INDEX_MATERIALS
  if (!apiKey || !name) {
    console.error('Set PINECONE_API_KEY and PINECONE_INDEX_MATERIALS first.')
    process.exit(1)
  }

  const pc = new Pinecone({ apiKey })
  const existing = await pc.listIndexes()
  if (existing.indexes?.some((i) => i.name === name)) {
    console.log(`Index "${name}" already exists — nothing to do.`)
    return
  }

  const deletionProtection =
    process.env.PINECONE_DISABLE_DELETION_PROTECTION === '1' ? 'disabled' : 'enabled'

  await pc.createIndex({
    name,
    dimension: DIMENSION,
    metric: METRIC,
    spec: { serverless: { cloud: CLOUD, region: REGION } },
    deletionProtection,
    waitUntilReady: true,
  })
  console.log(
    `Created serverless index "${name}" (${METRIC}, ${DIMENSION}-dim, ${CLOUD}/${REGION}, deletion_protection=${deletionProtection}).`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
