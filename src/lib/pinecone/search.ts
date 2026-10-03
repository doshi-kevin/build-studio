// Retrieval primitive over embedded module materials — the read path future
// consumers (RAG chatbot, cross-material search, topic mastery) build on.
//
// This is a PRIMITIVE, not an endpoint: the caller MUST have authenticated the
// user and verified section access (ownership or enrollment) BEFORE calling.
// Tenant ids here come from that verified context, never from client input.

import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { isUnlockPending, openModuleFilter } from '@/lib/modules/unlock'
import { recordAiUsage } from '@/lib/ai/usage'
import { rerankPassages } from '@/lib/ai/vertex-rerank'
import { queryMaterialPageVectors, queryCourseContentVectors, type CourseContentMatch } from './data'
import { embedQuery } from './embed'
import { CONTENT_CLASS_LECTURE_TRANSCRIPT, EMBEDDING_MODEL, STUDENT_QA_PROFILE, isRerankEnabled } from './config'
import { applyRerank, rerankDocumentFor } from './rerank'
import type { MaterialPageResult } from './search-types'
import type { TranscriptSlideMetadata } from './metadata'
import {
  matchConceptPages,
  applyConceptBoost,
  pageKey,
  type ConceptPageRef,
} from './concept-boost'
import { resolveLocator, type LocatorItem } from './locator'

/**
 * Load the section's boost inputs in one query: (a) stored concepts flattened
 * into (name → page) refs, and (b) the embeddable materials' titles for the
 * explicit-locator resolver. Selects only the `concepts` sub-object (not the
 * huge extraction blob) from published, open modules / visible items, so hidden
 * or not-yet-opened material can never be pinned. `items` is restricted to materials that HAVE
 * stored concepts — the embeddable set — so external readings/links can't
 * create phantom locator matches. Returns empty on shape mismatch (boost no-ops).
 */
async function loadSectionBoostData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  sectionId: string,
): Promise<{ conceptRefs: ConceptPageRef[]; items: LocatorItem[] }> {
  const { data, error } = await admin
    .from('module_items')
    .select('id, title, concepts:content->concepts, modules!inner(section_id, is_published)')
    .eq('modules.section_id', sectionId)
    .eq('modules.is_published', true)
    .or(openModuleFilter(), { referencedTable: 'modules' })
    .eq('is_visible', true)

  // A dropped error here silently disables the concept/locator boost — log it so
  // a DB failure is visible rather than reading as "this course has no concepts".
  if (error) {
    logger.error('searchMaterialPages: boost-data read failed', error, {
      source: 'pinecone.search.loadSectionBoostData',
      sectionId,
    })
  }

  const conceptRefs: ConceptPageRef[] = []
  const items: LocatorItem[] = []
  for (const item of (data ?? []) as Array<{ id: string; title: string | null; concepts: unknown }>) {
    if (!Array.isArray(item.concepts) || item.concepts.length === 0) continue
    items.push({ moduleItemId: item.id, title: item.title ?? '' })
    for (const c of item.concepts as Array<{ name?: unknown; pages?: unknown }>) {
      if (typeof c?.name !== 'string' || !Array.isArray(c.pages)) continue
      for (const p of c.pages) {
        if (Number.isInteger(p) && (p as number) >= 1) {
          conceptRefs.push({ name: c.name, moduleItemId: item.id, page: p as number })
        }
      }
    }
  }
  return { conceptRefs, items }
}

export type { MaterialPageResult } from './search-types'

/** Tighter than the 15s data-plane default: the reranker sits on the hot path
 *  in front of a student waiting on an answer, and its declared fallback (dense
 *  order) is good enough that waiting longer is worse than taking it. */
const RERANK_TIMEOUT_MS = 4_000

/**
 * Circuit breaker for the reranker (vector-db rule 11).
 *
 * The per-request try/catch already fails open, but "fails open on every
 * message" is its own outage: a missing IAM grant or a dead vendor would have
 * every student question pay a round trip — up to the timeout above — to arrive
 * exactly where it started. Since reranking is ON by default, that scenario is
 * a deployment mistake away, so after a few consecutive failures we stop asking
 * for a while and serve the dense order directly.
 *
 * Process-local and deliberately crude: each Cloud Run instance learns for
 * itself, and a shared store would be more coordination than a degraded-quality
 * fallback is worth. One probe per cooldown re-opens it automatically.
 */
const RERANK_BREAKER = { consecutiveFailures: 0, openUntil: 0 }
const RERANK_BREAKER_TRIP_AT = 3
const RERANK_BREAKER_COOLDOWN_MS = 60_000

/**
 * Hydrate transcript-slide matches from Postgres (`lc_transcriptions` is the
 * source of truth; Pinecone holds no text) and enforce visibility LIVE — the
 * vector layer can't track a toggle, so the gate is here, mirroring the page
 * lane's is_published/is_visible check: the room must be ended and the
 * professor must have left "Catch me up" on (G14). The section is re-pinned
 * from the row, not trusted from metadata.
 */
async function hydrateTranscriptMatches(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  sectionId: string,
  matches: Array<{ metadata: TranscriptSlideMetadata; score: number }>,
): Promise<MaterialPageResult[]> {
  if (matches.length === 0) return []
  const deckIds = [...new Set(matches.map((m) => m.metadata.deck_id))]
  const pages = [...new Set(matches.map((m) => m.metadata.page_number))]

  const { data: rows, error } = await admin
    .from('lc_transcriptions')
    .select(
      'deck_id, page_number, text, lc_rooms!inner(name, status, lecture_summary_enabled, section_id), lc_decks!inner(title, module_item_id)',
    )
    .in('deck_id', deckIds)
    .in('page_number', pages)

  if (error) {
    logger.error('searchMaterialPages: transcript hydration read failed', error, {
      source: 'pinecone.search.hydrateTranscriptMatches',
      sectionId,
    })
    return []
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const single = (v: any) => (Array.isArray(v) ? v[0] : v)
  const byKey = new Map<string, { text: string; room: { name: string | null }; deck: { title: string | null; module_item_id: string | null } }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of (rows ?? []) as any[]) {
    const room = single(r.lc_rooms)
    const deck = single(r.lc_decks)
    if (!room || room.section_id !== sectionId) continue
    if (room.status !== 'ended') continue
    // Null predates the toggle and means ON — same default as everywhere else.
    if (room.lecture_summary_enabled === false) continue
    byKey.set(`${r.deck_id}#${r.page_number}`, { text: r.text ?? '', room, deck })
  }

  const results: MaterialPageResult[] = []
  for (const m of matches) {
    const row = byKey.get(`${m.metadata.deck_id}#${m.metadata.page_number}`)
    if (!row || !row.text.trim()) continue // deleted / gated / drifted — drop
    const roomName = row.room.name?.trim() || 'Live class'
    const title = row.deck.title?.trim() || roomName
    const slide = m.metadata.page_number + 1
    results.push({
      moduleItemId: row.deck.module_item_id ?? '',
      moduleId: '',
      pageNumber: slide,
      score: m.score,
      title,
      breadcrumb: `${roomName} › ${title} › slide ${slide} (spoken)`,
      text: row.text,
      spoken: true,
    })
  }
  return results
}

export async function searchMaterialPages(input: {
  institutionId: string
  sectionId: string
  query: string
  topK?: number
  /** Restrict to one material (e.g. "search within this lecture"). */
  moduleItemId?: string
  /** Concept→page boost (default on): pin pages of a named course concept above
   *  near-duplicates. Pass false to get the raw dense ranking (A/B, eval). */
  conceptBoost?: boolean
  /** Pool lecture-transcript slides (N1) into the same ranked list. Default
   *  off so existing callers (and the eval baseline) are unchanged; the
   *  student-qa route opts in. */
  includeTranscripts?: boolean
  /** Run the hosted cross-encoder over the pooled candidates and return its
   *  top-N instead of the dense order. Default off so existing callers are
   *  unchanged; the student-qa route opts in. */
  rerank?: boolean
  /** Override the profile's rerank top-N. Calibration only (the eval sweeps it);
   *  production takes the profile value. */
  rerankTopN?: number
  /** Actor for the audit trail — pass it when there is one. */
  userId?: string
}): Promise<MaterialPageResult[]> {
  const { institutionId, sectionId } = input
  const query = input.query.trim()
  if (!query) return []

  const admin = createAdminClient()
  const embedded = await embedQuery(query)
  // Every paid call lands in the cost ledger, including the one embedding this
  // query — metered here rather than inside embedQuery so the caller's section
  // and actor travel with it.
  void recordAiUsage({
    feature: 'material_search',
    model: EMBEDDING_MODEL,
    institutionId,
    sectionId,
    userId: input.userId ?? null,
    usage: { inputTokens: embedded.tokens },
    ...(embedded.estimated ? { metadata: { estimated_tokens: true } } : {}),
  })
  // Vector search + the section's concept index in parallel. The concept boost
  // is section-wide, so it's skipped when the caller scopes to one material.
  // With transcripts on, one query spans both content classes and the pool is
  // split below — spoken slides and material pages compete on score.
  const wantTranscripts = input.includeTranscripts === true && !input.moduleItemId
  const [rawMatches, boostData] = await Promise.all([
    wantTranscripts
      ? queryCourseContentVectors({ institutionId, sectionId }, embedded.values, { topK: input.topK ?? 8 })
      : (queryMaterialPageVectors({ institutionId, sectionId }, embedded.values, {
          topK: input.topK ?? 8,
          moduleItemId: input.moduleItemId,
        }) as Promise<CourseContentMatch[]>),
    input.moduleItemId || input.conceptBoost === false
      ? Promise.resolve({ conceptRefs: [] as ConceptPageRef[], items: [] as LocatorItem[] })
      : loadSectionBoostData(admin, sectionId),
  ])
  const matches: Array<{ id: string; score: number; metadata: { module_item_id: string; module_id: string; page_number: number } }> = []
  const transcriptMatches: Array<{ metadata: TranscriptSlideMetadata; score: number }> = []
  for (const m of rawMatches) {
    if (m.metadata.content_class === CONTENT_CLASS_LECTURE_TRANSCRIPT) {
      transcriptMatches.push({ metadata: m.metadata, score: m.score })
    } else {
      matches.push({ id: m.id, score: m.score, metadata: m.metadata })
    }
  }

  // Pin pages the query points at, two ways: (1) it names a stored concept, and
  // (2) it gives an explicit locator ("lecture 6 slide 27"). Both are hydrated
  // and gated identically to vector matches below — pinning only reorders.
  const pinned = matchConceptPages(query, boostData.conceptRefs)
  const located = resolveLocator(query, boostData.items)
  if (located) pinned.add(pageKey(located.moduleItemId, located.page))
  if (matches.length === 0 && pinned.size === 0 && transcriptMatches.length === 0) return []

  // The spoken lane hydrates from its own source of truth, in parallel with
  // the page hydration below.
  const spokenPromise = hydrateTranscriptMatches(admin, sectionId, transcriptMatches)

  // Hydrate matched AND pinned pages together (one query). The .in() sets are
  // per-column, so re-match exact (item, page) pairs afterwards. We also pull
  // live is_visible / is_published so unpublished or hidden material is dropped
  // at hydration (Pinecone carries no publish flag) — the visibility gate below.
  const wantItems = new Set<string>()
  const wantPages = new Set<number>()
  for (const m of matches) {
    wantItems.add(m.metadata.module_item_id)
    wantPages.add(m.metadata.page_number)
  }
  for (const key of pinned) {
    const [it, p] = key.split('#')
    wantItems.add(it)
    wantPages.add(Number(p))
  }

  // A transcripts-only hit has no page keys to hydrate — skip the query rather
  // than sending an empty .in() filter.
  const { data: rows, error: rowsError } =
    wantItems.size === 0
      ? { data: [], error: null }
      : await admin
          .from('material_vector_chunks')
          .select(
            'module_item_id, module_id, page_number, breadcrumb, content, module_items(title, is_visible, modules(is_published, unlock_date))',
          )
          .eq('institution_id', institutionId)
          .eq('section_id', sectionId)
          .in('module_item_id', [...wantItems])
          .in('page_number', [...wantPages])

  // If hydration itself fails, the matches can't be turned into results and the
  // caller reads an empty return as "no relevant material" — an honest-refusal
  // that's actually a DB outage. We can't recover the text, but log it loudly so
  // the false refusal is diagnosable instead of silent.
  if (rowsError) {
    logger.error('searchMaterialPages: page hydration read failed', rowsError, {
      source: 'pinecone.search',
      sectionId,
      wantItems: wantItems.size,
      wantPages: wantPages.size,
    })
  }

  const byKey = new Map((rows ?? []).map((r) => [`${r.module_item_id}#${r.page_number}`, r]))

  // Visibility enforced at hydration against LIVE Postgres state (Pinecone holds
  // no publish flag): drop pages from unpublished modules, modules whose open date
  // hasn't arrived, or hidden items, so retrieval never surfaces material the
  // professor withheld or scheduled (design doc G9 / §4; unlock.ts). The module is
  // read through the item, never the chunk's own module_id: that column is copied at
  // embed time, so an item moved into a scheduled or unpublished week would otherwise
  // be judged by the week it left. Applied identically to vector matches and pinned concept pages, so the
  // boost can only reorder pages that already clear this gate — never widen it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visible = (row: any): boolean => {
    const item = Array.isArray(row.module_items) ? row.module_items[0] : row.module_items
    const mod = Array.isArray(item?.modules) ? item.modules[0] : item?.modules
    const m = mod as { is_published?: boolean; unlock_date?: string | null } | null
    return !!(item as { is_visible?: boolean } | null)?.is_visible && !!m?.is_published && !isUnlockPending(m?.unlock_date)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toResult = (row: any, moduleItemId: string, moduleId: string, pageNumber: number, score: number): MaterialPageResult => {
    const item = Array.isArray(row.module_items) ? row.module_items[0] : row.module_items
    return {
      moduleItemId,
      moduleId,
      pageNumber,
      score,
      title: (item as { title?: string } | null)?.title ?? '',
      breadcrumb: row.breadcrumb ?? '',
      text: row.content ?? '',
    }
  }

  const results: MaterialPageResult[] = []
  const seen = new Set<string>()
  for (const m of matches) {
    const key = pageKey(m.metadata.module_item_id, m.metadata.page_number)
    const row = byKey.get(key)
    if (!row || !visible(row)) continue // drift / not student-visible
    results.push(toResult(row, m.metadata.module_item_id, m.metadata.module_id, m.metadata.page_number, m.score))
    seen.add(key)
  }
  // Named-concept pages the vector search didn't surface: add them as direct
  // lookups (base score 0; applyConceptBoost lifts them), under the same gate.
  for (const key of pinned) {
    if (seen.has(key)) continue
    const row = byKey.get(key)
    if (!row || !visible(row)) continue
    const [it, p] = key.split('#')
    results.push(toResult(row, it, row.module_id, Number(p), 0))
    seen.add(key)
  }

  // Spoken slides join the pool on score — an explicit merge sort, because
  // applyConceptBoost only re-sorts when it has pins, and each lane arrives
  // internally ordered but not interleaved. The boost pass then only lifts
  // pinned (material) keys; transcript rows simply ride the sort.
  const spoken = await spokenPromise
  const pooled = [...results, ...spoken].sort((a, b) => b.score - a.score)
  const boosted = applyConceptBoost(pooled, pinned)

  // Cross-encoder pass over the pooled candidates. It runs AFTER the boost and
  // the visibility gate on purpose: pinning decides what gets a hearing, the
  // reranker decides the order, and neither can widen what hydration already
  // allowed — a page the student may not see was dropped long before here.
  const final = input.rerank && isRerankEnabled()
    ? await rerankPooled(query, boosted, {
        institutionId,
        sectionId,
        userId: input.userId,
        topN: input.rerankTopN ?? STUDENT_QA_PROFILE.rerankTopN,
      })
    : boosted

  if (input.userId) {
    logEvent({
      userId: input.userId,
      eventType: 'material_vectors.searched',
      eventCategory: 'system',
      metadata: {
        sectionId,
        topK: input.topK ?? 8,
        results: final.length,
        pinned: pinned.size,
        spoken: spoken.length,
        reranked: final.some((r) => r.reranked),
      },
      sectionId,
    })
  }
  return final
}

/**
 * Rerank the pooled candidates, or fail open to the dense order.
 *
 * Fail-open is deliberate and matches `reserveAthenaSlot`: a reranker outage
 * must degrade retrieval quality, never turn a student's question into an
 * error. But a silent degrade is how a dead dependency survives for months, so
 * the fallback logs at `warn` with the reason — and results keep their dense
 * scores and no `reranked` stamp, so the DENSE floor applies downstream rather
 * than a cross-encoder threshold being read against a cosine.
 */
export async function rerankPooled(
  query: string,
  pooled: MaterialPageResult[],
  scope: { institutionId: string; sectionId: string; userId?: string; topN: number },
): Promise<MaterialPageResult[]> {
  if (pooled.length === 0) return pooled
  // One candidate can't be reordered, and the request would still be billed.
  if (pooled.length === 1) return pooled

  if (Date.now() < RERANK_BREAKER.openUntil) return denseFallback(pooled)

  try {
    const ranked = await rerankPassages(
      STUDENT_QA_PROFILE.rerankModel,
      query,
      pooled.map(rerankDocumentFor),
      Math.min(scope.topN, pooled.length),
      RERANK_TIMEOUT_MS,
    )
    // Billed per request, not per token, so the ledger row carries the call
    // count rather than a token count (design §10 — this is ~20% of a message).
    void recordAiUsage({
      feature: 'material_search',
      model: STUDENT_QA_PROFILE.rerankModel,
      institutionId: scope.institutionId,
      sectionId: scope.sectionId,
      userId: scope.userId ?? null,
      usage: { requests: 1 },
      metadata: { candidates: pooled.length },
    })
    // An empty verdict is a failure wearing a success's clothes — falling
    // through would hand the caller "no relevant pages" for a good question.
    RERANK_BREAKER.consecutiveFailures = 0
    if (ranked.length === 0) {
      logger.warn('searchMaterialPages: reranker returned nothing — using dense order', {
        source: 'pinecone.search.rerankPooled',
        sectionId: scope.sectionId,
        candidates: pooled.length,
      })
      return denseFallback(pooled)
    }
    return applyRerank(pooled, ranked)
  } catch (error) {
    RERANK_BREAKER.consecutiveFailures += 1
    const tripped = RERANK_BREAKER.consecutiveFailures >= RERANK_BREAKER_TRIP_AT
    if (tripped) RERANK_BREAKER.openUntil = Date.now() + RERANK_BREAKER_COOLDOWN_MS
    // `error` level once the breaker trips: a single failure is weather, but a
    // sustained one means every student is silently getting the weaker ranking
    // and nobody would otherwise notice. (Separate calls, not a bound alias —
    // logger.error takes the error as its SECOND argument, so aliasing the two
    // would file the context object as the error and drop the context.)
    const context = {
      source: 'pinecone.search.rerankPooled',
      sectionId: scope.sectionId,
      candidates: pooled.length,
      consecutiveFailures: RERANK_BREAKER.consecutiveFailures,
      breakerOpenForMs: tripped ? RERANK_BREAKER_COOLDOWN_MS : 0,
    }
    if (tripped) {
      logger.error('searchMaterialPages: rerank failing repeatedly — breaker open, serving dense order', error, context)
    } else {
      logger.warn('searchMaterialPages: rerank failed — falling back to dense order', {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return denseFallback(pooled)
  }
}

/**
 * The declared degraded fallback: the dense order, cut to the width the dense
 * profile would have asked for.
 *
 * Returning the full pool would be the failure the profile's own comment warns
 * about — 40 pages reach the prompt instead of 8, 5× the context tokens. And
 * the documented outage mode (an org without the rerank entitlement) is 100% of
 * requests, not a rare blip, so the fallback IS the steady state until the plan
 * lands. Every page here already cleared the tenant + visibility gate; this is
 * a cost and precision bound, not an access one.
 */
function denseFallback(pooled: MaterialPageResult[]): MaterialPageResult[] {
  return pooled.slice(0, STUDENT_QA_PROFILE.denseTopK)
}
