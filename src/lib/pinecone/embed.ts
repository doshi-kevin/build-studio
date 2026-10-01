// gemini-embedding-2 helper — the ONE place document pages and search queries
// get embedded, so both sides are guaranteed the same model + dimension
// (mixed-model vectors corrupt retrieval silently).
//
// Goes straight to the GenAI REST API: the AI SDK's embed() path is text-only,
// and our document input is multimodal — interleaved [breadcrumb text + page
// image] producing ONE aggregated vector that carries tables/figures/formulas,
// not just prose (design doc §4). Limits: ≤6 images/request (we send 1),
// 8,192 tokens across all modalities.

import 'server-only'

import { logger } from '@/lib/logger'
import { EMBEDDING_DIM, EMBEDDING_MODEL } from './config'

const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`
const BATCH_EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`
const MAX_ATTEMPTS = 3
const TIMEOUT_MS = 30_000
/** Keep the text part comfortably inside the shared 8,192-token budget. */
export const MAX_TEXT_CHARS = 8_000

/** Max requests per batchEmbedContents call (API limit). */
const BATCH_SIZE = 100
/** Bounded concurrency for the fallback per-request path. */
const BATCH_FALLBACK_CONCURRENCY = 8

type Part = { text: string } | { inline_data: { mime_type: string; data: string } }

export interface EmbedResult {
  values: number[]
  /** Billable prompt tokens (all modalities), from the API's usageMetadata. */
  tokens: number
  /** True when usageMetadata was absent and tokens fell back to chars/4. */
  estimated: boolean
}

async function embedParts(parts: Part[], label: string): Promise<EmbedResult> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set')

  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(EMBED_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ content: { parts } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        const retriable = res.status === 429 || res.status >= 500
        const body = await res.text()
        lastError = new Error(`embedContent ${label}: ${res.status} ${body.slice(0, 300)}`)
        if (!retriable || attempt === MAX_ATTEMPTS) throw lastError
      } else {
        const json = (await res.json()) as {
          embedding?: { values?: number[] }
          embeddings?: Array<{ values?: number[] }>
          usageMetadata?: { promptTokenCount?: number; totalTokenCount?: number }
        }
        const values = json.embedding?.values ?? json.embeddings?.[0]?.values
        if (!values || values.length !== EMBEDDING_DIM) {
          throw new Error(
            `embedContent ${label}: expected ${EMBEDDING_DIM}-dim vector, got ${values?.length ?? 'none'}`,
          )
        }
        // Billable tokens for the cost ledger. The API reports them in
        // usageMetadata; fall back to the standard ~4 chars/token estimate on
        // the text parts only if it's ever missing (flagged, never silent).
        const reported = json.usageMetadata?.promptTokenCount ?? json.usageMetadata?.totalTokenCount
        const textChars = parts.reduce((sum, p) => ('text' in p ? sum + p.text.length : sum), 0)
        return {
          values,
          tokens: reported ?? Math.ceil(textChars / 4),
          estimated: reported === undefined,
        }
      }
    } catch (error) {
      lastError = error
      if (attempt === MAX_ATTEMPTS) break
    }
    // Exponential backoff with jitter: ~1s, ~2s.
    const delay = 1000 * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  logger.error('embedParts: all attempts failed', lastError, { source: 'pinecone.embed', label })
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Embed one PDF page for indexing: breadcrumb text + the rendered page image
 * as ONE multimodal input → one aggregated vector.
 */
export async function embedMaterialPage(input: {
  breadcrumb: string
  pageText: string
  imagePng: Buffer
}): Promise<EmbedResult> {
  const text = `${input.breadcrumb}\n${input.pageText}`.slice(0, MAX_TEXT_CHARS)
  return embedParts(
    [
      { text },
      { inline_data: { mime_type: 'image/png', data: input.imagePng.toString('base64') } },
    ],
    'material-page',
  )
}

/**
 * Embed a material chunk that has no page image — a spreadsheet sheet, whose
 * meaning is in its headers and a few example rows, not in a picture of a grid.
 *
 * Same space and same model as `embedMaterialPage`; it simply omits the image
 * part, which is what makes it cheap enough to be worth doing at all.
 */
export async function embedMaterialText(input: {
  breadcrumb: string
  text: string
}): Promise<EmbedResult> {
  return embedParts(
    [{ text: `${input.breadcrumb}\n${input.text}`.slice(0, MAX_TEXT_CHARS) }],
    'material-text',
  )
}

/**
 * Embed a search query into the same space. gemini-embedding-2 takes task
 * instructions in the prompt itself (there is no taskType param) — this is
 * Google's documented retrieval-query format.
 */
export async function embedQuery(query: string): Promise<EmbedResult> {
  return embedParts(
    [{ text: `task: search result | query: ${query.slice(0, MAX_TEXT_CHARS)}` }],
    'query',
  )
}


/**
 * Embed a professor's reference answer snippet for indexing (document-side embedding,
 * no query prefix). Used when upserting rubric reference vectors.
 */
export async function embedReferenceSnippet(text: string): Promise<number[]> {
  return (await embedParts([{ text: text.slice(0, MAX_TEXT_CHARS) }], 'rubric-reference')).values
}

export interface BatchEmbedResult {
  /** One vector per input text, in input order. */
  vectors: number[][]
  /** Billable prompt tokens across the batch (see EmbedResult.tokens). */
  tokens: number
  /** True when any chunk's tokens fell back to the chars/4 estimate. */
  estimated: boolean
}

/**
 * Embed many texts with gemini-embedding-2 at 3072-dim, preserving input order.
 *
 * Uses the `:batchEmbedContents` REST endpoint in groups of ≤100.
 * Falls back to bounded-concurrency per-request if the batch endpoint returns a
 * non-retriable error. Returns empty vectors when texts is empty.
 *
 * Document-side embedding (no query prefix) — call only for passage indexing, not
 * for search queries. All vectors are 3072-dim gemini-embedding-2. Callers own
 * cost attribution: record `tokens` via recordAiUsage (batchEmbedContents reports
 * no usageMetadata, so tokens are the chars/4 estimate, flagged `estimated`).
 */
export async function embedTextsBatch(texts: string[]): Promise<BatchEmbedResult> {
  if (texts.length === 0) return { vectors: [], tokens: 0, estimated: false }

  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set')

  const vectors: number[][] = new Array(texts.length)
  let tokens = 0
  let estimated = false

  // Process in chunks of BATCH_SIZE.
  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    const slice = texts.slice(offset, offset + BATCH_SIZE)
    let lastError: unknown

    let success = false
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(BATCH_EMBED_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            requests: slice.map((t) => ({
              model: `models/${EMBEDDING_MODEL}`,
              content: { parts: [{ text: t.slice(0, MAX_TEXT_CHARS) }] },
            })),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })

        if (!res.ok) {
          const retriable = res.status === 429 || res.status >= 500
          const body = await res.text()
          lastError = new Error(`batchEmbedContents: ${res.status} ${body.slice(0, 300)}`)
          if (!retriable || attempt === MAX_ATTEMPTS) {
            // Non-retriable or exhausted — fall back to per-request.
            break
          }
        } else {
          const json = (await res.json()) as { embeddings?: Array<{ values?: number[] }> }
          const embeddings = json.embeddings
          if (!embeddings || embeddings.length !== slice.length) {
            throw new Error(
              `batchEmbedContents: expected ${slice.length} embeddings, got ${embeddings?.length ?? 0}`,
            )
          }
          for (let i = 0; i < slice.length; i++) {
            const values = embeddings[i]?.values
            if (!values || values.length !== EMBEDDING_DIM) {
              throw new Error(
                `batchEmbedContents: vector ${offset + i} has dim ${values?.length ?? 0}, expected ${EMBEDDING_DIM}`,
              )
            }
            vectors[offset + i] = values
          }
          // The batch response carries no usageMetadata — estimate for the ledger.
          tokens += slice.reduce((sum, t) => sum + Math.ceil(Math.min(t.length, MAX_TEXT_CHARS) / 4), 0)
          estimated = true
          success = true
          break
        }
      } catch (error) {
        lastError = error
        if (attempt === MAX_ATTEMPTS) break
      }
      const delay = 1000 * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    if (!success) {
      // Fallback: embed texts one by one with bounded concurrency.
      logger.warn('embedTextsBatch: batch endpoint failed, falling back to sequential', {
        source: 'pinecone.embed',
        offset,
        batchSize: slice.length,
        err: String(lastError),
      })
      const fallback = await boundedConcurrentEmbed(slice)
      for (let i = 0; i < fallback.length; i++) {
        vectors[offset + i] = fallback[i].values
        tokens += fallback[i].tokens
        estimated = estimated || fallback[i].estimated
      }
    }
  }

  return { vectors, tokens, estimated }
}

/** Embed texts one by one with BATCH_FALLBACK_CONCURRENCY concurrency. */
async function boundedConcurrentEmbed(texts: string[]): Promise<EmbedResult[]> {
  const results: EmbedResult[] = new Array(texts.length)
  let cursor = 0

  async function worker() {
    while (cursor < texts.length) {
      const idx = cursor++
      results[idx] = await embedParts([{ text: texts[idx].slice(0, MAX_TEXT_CHARS) }], `passage-${idx}`)
    }
  }

  const workers = Array.from({ length: Math.min(BATCH_FALLBACK_CONCURRENCY, texts.length) }, worker)
  await Promise.all(workers)
  return results
}
