/**
 * roadmap-rail-v1 — which pages of a lecture cover each of its topics.
 *
 * This is the material viewer's reference rail (and the roadmap's page anchors):
 * a professor's extracted topic is a CANONICAL name ("Laplace smoothing") that
 * often appears nowhere verbatim in the slide that teaches it ("add-one",
 * "MLE"), so exact-substring anchoring finds a fraction of them. The topic name
 * is embedded as a QUERY against the pages we already indexed, which is the
 * same trick the tutor uses on a student's question.
 *
 * Two deliberate choices, both departures from the pgvector layer this replaces
 * (docs/designs/athena-students.md §5, "Part 1 cutover"):
 *
 * 1. **Computed at index time, not read time.** The old path was one batched
 *    RPC per roadmap load — cheap because Postgres held the vectors. Pinecone
 *    is a network hop per topic, and a modest section has ~74 (item, topic)
 *    pairs; that is 74 round trips on one of the hottest student pages. So the
 *    map is computed once, when a material's topics are written, and stored on
 *    `module_items.content.topicPages`. The roadmap then pays nothing: it
 *    already loads `content`.
 *
 * 2. **The score floor is the profile's, not the pgvector threshold.** The old
 *    0.6 was a raw pgvector cosine on 1536-dim truncated vectors; these are
 *    3072-dim multimodal page embeddings with a different score distribution,
 *    so the number does not carry over and is named here as its own knob.
 *
 * Cost: a handful of query embeddings per material, once — negligible next to
 * the page embeddings the same run already paid for, and it REMOVES a database
 * round trip from every roadmap render.
 */

import 'server-only'
import { logger } from '@/lib/logger'
import { stripNul } from '@/lib/extraction/sanitize'
import { embedQuery } from './embed'
import { queryMaterialPageVectors, type TenantScope } from './data'

// The admin Supabase client is intentionally loosely typed across the codebase.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

/** The named retrieval profile these knobs belong to (vector-db.md rule 12). */
export const ROADMAP_RAIL_PROFILE = 'roadmap-rail-v1'

/**
 * Pages kept per topic, best match first. The rail is a pointer — "it's on
 * p.30" — so past a handful it stops helping and becomes a table of contents.
 */
export const RAIL_TOP_N = 4

/**
 * Keep pages within this much of the topic's BEST score in its own document.
 *
 * The filter is relative because an absolute one provably cannot work here.
 * Measured on the CS584 corpus (tmp/rail-probe): a topic's best page scores
 * ~0.69, while an off-topic control query ("alpha-beta pruning" against the
 * Transformers deck) still scores 0.54 — the scale is compressed and its zero
 * point moves per document. Worse, "optimization" against a 5-page note peaks
 * at 0.574, BELOW that off-topic control. Any absolute floor that excluded the
 * control would delete a real anchor.
 *
 * Relative works because the question this answers is already scoped: the topic
 * was extracted FROM this document, so the only thing to decide is which of its
 * pages carry it. 0.05 keeps the cluster at the top and cuts the long flat
 * tail — positional encoding → p.30, 29, 31 rather than half the deck.
 */
export const RAIL_SCORE_MARGIN = 0.05

/**
 * Absolute floor, deliberately generous. It exists only to catch a garbage
 * topic string (a stray extraction artefact matching nothing), NOT to judge
 * relevance — the margin above does that. Set below the weakest genuine anchor
 * measured (0.574) with room to spare, because a missing rail and a wrong rail
 * cost differently: a missing one sends the student back to scrolling.
 */
export const RAIL_SCORE_FLOOR = 0.45

/** `{ topicName: [pageNumbers, best first] }` — the shape the rail renders. */
export type TopicPages = Record<string, number[]>

/**
 * Pick a topic's rail pages from its ranked matches within one document.
 *
 * Pure and exported for the eval: this is the whole ranking decision, and it
 * should be testable without a network call.
 */
export function selectRailPages(matches: Array<{ page: number; score: number }>): number[] {
  const valid = matches.filter((m) => Number.isInteger(m.page) && m.page >= 1 && m.score >= RAIL_SCORE_FLOOR)
  if (valid.length === 0) return []
  // Matches arrive best-first, but do not depend on it — the cutoff is defined
  // against the best score, so read it rather than assume position 0.
  const best = Math.max(...valid.map((m) => m.score))
  const seen = new Set<number>()
  return valid
    .filter((m) => m.score >= best - RAIL_SCORE_MARGIN)
    .sort((a, b) => b.score - a.score)
    .filter((m) => (seen.has(m.page) ? false : (seen.add(m.page), true)))
    .slice(0, RAIL_TOP_N)
    .map((m) => m.page)
}

/**
 * Match each topic to the pages of ONE material.
 *
 * Scoped to `moduleItemId` on purpose: a topic belongs to the lecture it was
 * extracted from, and the rail answers "where in THIS document", not "where in
 * the course". Without the filter the best match for "Attention" would usually
 * be a different lecture entirely.
 *
 * Best-effort per topic — one embedding failure drops that topic's anchors, not
 * the whole map, and the caller falls back to substring anchoring for the rest.
 */
export async function computeTopicPages(
  scope: TenantScope,
  moduleItemId: string,
  topics: string[],
): Promise<TopicPages> {
  const wanted = [...new Set(topics.map((t) => t.trim()).filter(Boolean))]
  if (wanted.length === 0) return {}

  const out: TopicPages = {}
  // Sequential on purpose: this runs inside a background job that is already
  // paying for page embeddings, and a burst of parallel queries per material
  // buys latency nobody is waiting on at the cost of rate-limit headroom.
  for (const topic of wanted) {
    try {
      const embedded = await embedQuery(topic)
      // Ask for more than we keep: the margin cut needs to see where the
      // scores fall off, and topK IS the candidate pool, not the answer.
      const matches = await queryMaterialPageVectors(scope, embedded.values, {
        topK: RAIL_TOP_N * 3,
        moduleItemId,
      })
      const ranked = selectRailPages(matches.map((m) => ({ page: m.metadata.page_number, score: m.score })))
      if (ranked.length > 0) out[topic] = ranked
    } catch (error) {
      logger.warn('computeTopicPages: topic match failed', {
        source: 'pinecone.topicPages',
        moduleItemId,
        topic,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return out
}

/**
 * Compute a material's topic→page anchors and store them on the item.
 *
 * Re-reads `content` immediately before writing and merges, matching the
 * extraction worker's own discipline: this runs at the end of a long job, and
 * blind-writing the whole object would stomp any field another pass changed
 * meanwhile.
 *
 * Never throws. A rail with no anchors degrades to substring matching; a rail
 * that takes down extraction would cost the professor their upload.
 */
export async function storeTopicPageAnchors(
  db: AdminDb,
  params: {
    institutionId: string
    sectionId: string
    moduleItemId: string
    topics: string[]
    /**
     * True when the caller knows this material's pages are in the index right
     * now (the embedding job itself). Then an empty result is a broken matcher,
     * not a race, and is logged as an error rather than shrugged off — the
     * whole lesson of #435 is that a quietly dead embedding path stays dead.
     */
    expectIndexed?: boolean
  },
): Promise<TopicPages> {
  try {
    const topicPages = await computeTopicPages(
      { institutionId: params.institutionId, sectionId: params.sectionId },
      params.moduleItemId,
      params.topics,
    )
    // Nothing matched — usually a material whose pages are not indexed YET,
    // because extraction and embedding are independent jobs. Leave `content`
    // alone rather than writing an empty object that reads like "we looked and
    // this lecture covers none of its own topics"; the other job re-runs this.
    if (Object.keys(topicPages).length === 0) {
      if (params.expectIndexed) {
        logger.error('storeTopicPageAnchors: no anchors for a freshly indexed material', undefined, {
          source: 'pinecone.topicPages',
          moduleItemId: params.moduleItemId,
          topics: params.topics.length,
        })
      }
      return {}
    }

    const { data: fresh } = await db
      .from('module_items')
      .select('content')
      .eq('id', params.moduleItemId)
      .maybeSingle()
    if (!fresh) return topicPages

    /* stripNul walks VALUES, and here the topic names are KEYS — a NUL in one
       would make Postgres reject the entire jsonb write. Sanitize the keys as
       we build the map, so the rail cannot be the thing that fails the row. */
    const safeAnchors: TopicPages = {}
    for (const [topic, pages] of Object.entries(topicPages)) {
      safeAnchors[stripNul(topic)] = pages
    }

    const { error } = await db
      .from('module_items')
      .update({
        content: stripNul({ ...((fresh.content ?? {}) as Record<string, unknown>), topicPages: safeAnchors }),
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.moduleItemId)

    // Returning the map while the write failed would report a rail that isn't
    // there — the caller has no other way to find out.
    if (error) {
      logger.warn('storeTopicPageAnchors: anchor write failed', {
        source: 'pinecone.topicPages',
        moduleItemId: params.moduleItemId,
        error: error.message,
      })
      return {}
    }

    return safeAnchors
  } catch (error) {
    logger.warn('storeTopicPageAnchors: failed', {
      source: 'pinecone.topicPages',
      moduleItemId: params.moduleItemId,
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }
}
