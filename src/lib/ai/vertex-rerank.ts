// Hosted cross-encoder rerank via Google's Vertex AI Ranking API.
//
// Why here and not in `src/lib/pinecone/`: reranking is not a vector-store
// operation. The index still comes from Pinecone; the second-pass ranking is a
// separate Google service, and putting its call inside the Pinecone wrapper
// would make "all Pinecone access goes through this module" mean two different
// things. The pure ranking logic (`pinecone/rerank.ts`) is provider-agnostic
// and unchanged by which vendor scores the pages.
//
// Chosen over Pinecone's hosted reranker on three counts, in order: our
// Pinecone plan entitles the org to 0 rerank requests/month, this is half the
// price ($1 vs $2 per 1,000 queries, where one query covers up to 100
// documents and our pool is 40), and it authenticates with the same Google
// credentials the app already deploys under.

import 'server-only'

import { GoogleAuth } from 'google-auth-library'

const RANKING_ENDPOINT = (project: string) =>
  `https://discoveryengine.googleapis.com/v1/projects/${project}/locations/global/rankingConfigs/default_ranking_config:rank`

/** Application Default Credentials: the Cloud Run service account in prod, the
 *  developer's `gcloud auth application-default login` locally. No key file
 *  either way — which is the whole reason this path needs no secret. */
let auth: GoogleAuth | null = null
function googleAuth(): GoogleAuth {
  auth ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  return auth
}

/**
 * The project the call is billed and quota'd against.
 *
 * Explicit env first: with user-based ADC the library's own project detection
 * reads whatever `gcloud` was last pointed at, which is a developer's local
 * state, not a deployment decision.
 */
async function rankingProject(): Promise<string> {
  const explicit = process.env.GOOGLE_CLOUD_PROJECT?.trim()
  if (explicit) return explicit
  const detected = await googleAuth().getProjectId()
  if (!detected) throw new Error('vertex-rerank: no GOOGLE_CLOUD_PROJECT and ADC exposes no project id')
  return detected
}

/**
 * Score `documents` against `query` with a hosted cross-encoder and return the
 * best `topN` as positions into the input array, most relevant first.
 *
 * Returns positions rather than documents so no page text makes a round trip it
 * doesn't need to — the caller already holds the pages.
 *
 * Throws on any failure (timeout, 4xx, malformed response). The caller owns the
 * circuit-breaker and the declared fallback; this function's job is to be
 * unambiguous about whether it worked.
 */
export async function rerankPassages(
  model: string,
  query: string,
  documents: string[],
  topN: number,
  timeoutMs: number,
): Promise<Array<{ index: number; score: number }>> {
  const project = await rankingProject()
  const token = await googleAuth().getAccessToken()
  if (!token) throw new Error('vertex-rerank: ADC returned no access token')

  const res = await fetch(RANKING_ENDPOINT(project), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      // Required for user-based ADC — without it the API bills nothing and 403s.
      'x-goog-user-project': project,
    },
    body: JSON.stringify({
      model,
      topN,
      query,
      // The id is the input position, so the response maps straight back with
      // no matching on text.
      records: documents.map((content, i) => ({ id: String(i), content })),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`vertex-rerank: ${res.status} ${body.slice(0, 300)}`)
  }

  const json = (await res.json()) as { records?: Array<{ id?: string; score?: number }> }
  return (json.records ?? [])
    .map((r) => ({ index: Number(r.id), score: typeof r.score === 'number' ? r.score : 0 }))
    // A non-numeric or out-of-range id is a contract break, not a page — drop it
    // rather than let it index into the caller's array.
    .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < documents.length)
}
