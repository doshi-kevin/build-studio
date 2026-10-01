/**
 * Prompt assembly for the student Athena surface — the lanes that decide what
 * this turn is allowed to answer from.
 *
 * Two lanes run in parallel, both reported into the run channel so the dock's
 * card shows the real work:
 *
 *  - **Materials** — retrieval over the section's Pinecone namespace (decompose
 *    → search → rerank), then the relevance floor. What clears it is the
 *    citable set; what doesn't is not quietly answered anyway.
 *  - **Memory** — what we know about this student: preferences they stated, the
 *    skill groups they are weakest on, what is due, and whether they missed the
 *    last class. Assembled by `lib/memory` (structured, caller-agnostic) and
 *    turned into prompt lines here by `renderAthenaMemory`. It replaced a
 *    weakest-topics lane that ranked LEAF skills off `skill_mastery.state.n`,
 *    which on real data printed one quiz five times under five near-synonymous
 *    names; see docs/designs/athena/memory-prototype-findings.md.
 *
 * The grounding decision is the important part and there are three outcomes,
 * deliberately distinct (§4, G1/G2):
 *
 *  - `retrieval`    — pages cleared the floor; answer from them, cite them.
 *  - `insufficient` — the course HAS material and none of it is relevant, so
 *                     refuse honestly. Never falls back to the full-course dump,
 *                     which is exactly the out-of-corpus hallucination path the
 *                     floor exists to close.
 *  - `full-context` — the section has nothing indexed at all. The legacy dump,
 *                     kept so an un-indexed course doesn't regress mid-rollout.
 *
 * Surface-specific by design: athena-core knows nothing about any of this, and
 * a second surface plugs in its own lanes (§2, "context lanes are pluggable
 * modules").
 */

import 'server-only'
import { logger } from '@/lib/logger'
import {
  getExtractionContextForLLM,
  type ExtractionPage,
  type ExtractionMetadata,
} from '@/lib/document-parser'
import { isRenderableSource } from '@/lib/document-parser/asset-crop'
import { buildUnitsForLLM, formatAssetRef } from '@/lib/extraction/assets'
import { AI_TUTOR_MAX_CONTENT_CHARS } from '@/lib/ai/config'
import { openModuleFilter } from '@/lib/modules/unlock'
import { getUserState } from '@/lib/memory/state'
import { retrieveForQuestion } from '@/lib/pinecone/retrieve'
import { clearsRelevanceFloor } from '@/lib/pinecone/rerank'
import type { AthenaRunChannel } from '@/lib/ai/athena-core/stream'
import { buildAiTutorPrompt } from './prompt'
import { renderAthenaMemory } from './memory-block'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

/** A page the model may cite this turn, with the text a `create` tool attributes against. */
export interface CitablePage {
  material: string
  page: number
  text?: string
  moduleItemId?: string
}

export interface StudentTurnContext {
  /** The assembled system prompt, ready for the model call. */
  systemPrompt: string
  /** Exactly the pages in the model's context (design doc §15.4). */
  citablePages: CitablePage[]
  /** Which branch the prompt took — logged, and useful to assert in tests. */
  grounding: 'retrieval' | 'insufficient' | 'full-context'
}

export interface StudentTurnInput {
  adminDb: AdminDb
  institutionId: string
  sectionId: string
  userId: string
  /** Course/section labels for the prompt head (the stable prefix). */
  header: { courseTitle: string; courseCode: string; sectionCode: string }
  /** The retrieval query — the latest user message. Empty means no search runs. */
  query: string
  hasAttachments: boolean
  /** Copilot mode exposes the artifact/knowledge-map tools, so the prompt teaches them. */
  canLeaveArtifacts: boolean
  run: AthenaRunChannel
}

/**
 * The legacy full-course dump, for a section with nothing indexed yet.
 *
 * Published AND already open. The unlock gate has to be HERE, not only on the
 * pages: this concatenates every item's full extracted text into the model
 * context, so without it an enrolled student can ask "summarise week 12" and
 * read a week the professor hasn't opened. Filtering in the query keeps a locked
 * module out of `moduleIds`, so the items read below can't reach it.
 */
async function buildCourseDump(db: AdminDb, sectionId: string): Promise<string> {
  const { data: modules } = await db
    .from('modules')
    .select('id')
    .eq('section_id', sectionId)
    .eq('is_published', true)
    .or(openModuleFilter())

  if (!modules?.length) return ''

  const moduleIds = modules.map((m: { id: string }) => m.id)

  const { data: items } = await db
    .from('module_items')
    .select('id, title, content')
    .in('module_id', moduleIds)
    .eq('is_visible', true)

  const allParts: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const item of (items || []) as any[]) {
    const extraction = item.content?.extraction
    if (extraction?.status !== 'completed' || !extraction?.pages?.length) continue

    const pages: ExtractionPage[] = extraction.pages
    const metadata: ExtractionMetadata = extraction.metadata
    // Include the structured units (tables/figures/code), not just page text, and
    // tag each page with a [Title, page N] marker the tutor cites. Visual units of
    // renderable files also get an `[ASSET <ref>]` tag the tutor can embed as an
    // inline image (`asset://<ref>`); the ref is re-validated against this stored
    // extraction when the image is fetched.
    const renderable = !!item.content?.filePath && isRenderableSource(item.content.filePath)
    const units = buildUnitsForLLM(extraction, renderable ? (u) => formatAssetRef(item.id, u) : undefined)
    const text = getExtractionContextForLLM(item.title || 'Untitled', pages, metadata, units)
    if (text) allParts.push(text)
  }

  const combined = allParts.join('\n\n')
  return combined.length > AI_TUTOR_MAX_CONTENT_CHARS
    ? combined.slice(0, AI_TUTOR_MAX_CONTENT_CHARS) + '\n\n[Content truncated due to length — some materials omitted]'
    : combined
}

/** Run both lanes and assemble this turn's system prompt. */
export async function buildStudentTurnContext(input: StudentTurnInput): Promise<StudentTurnContext> {
  const { adminDb, sectionId, userId, run } = input

  const [retrieved, memoryBlock] = await Promise.all([
    input.query
      ? run.timed(
          'materials',
          'Course materials',
          () =>
            retrieveForQuestion({
              institutionId: input.institutionId,
              sectionId,
              query: input.query,
              // N1 — the professor's spoken words from ended classes pool into the
              // same ranked list (gated at hydration: ended room + "Catch me up"
              // on, G14).
              includeTranscripts: true,
              // Cross-encoder over the wide pool. Measured on the golden set: it
              // lifts the right page's rank (MRR 0.77 → 0.83) and what reaches the
              // prompt (0.82 → 0.85).
              rerank: true,
              userId,
            }),
          ({ pages, subQueries }) => {
            const kept = pages.filter(clearsRelevanceFloor).length
            // Say when a question was split — "8 of 10 pages matched" reads as one
            // search, and the student asked one question but two ran.
            const how = subQueries.length > 0 ? ` (searched ${subQueries.length} parts)` : ''
            if (pages.length === 0) return 'nothing indexed for this course yet'
            return kept === 0
              ? `${pages.length} pages searched, none close enough${how}`
              : `${kept} of ${pages.length} pages matched${how}`
          },
        )
      : Promise.resolve({ pages: [], subQueries: [] as string[] }),
    run.timed(
      'memory',
      'What I know about you',
      async () =>
        renderAthenaMemory(
          await getUserState(adminDb, { userId, sectionId, institutionId: input.institutionId }),
        ),
      (block) => (block ? 'your preferences and where you stand' : 'nothing known yet'),
    ),
  ])

  // Keep only pages that clear the relevance floor for the path they came
  // through — the cross-encoder threshold when the reranker ran, the dense
  // cosine when it was off or fell back.
  const relevant = retrieved.pages.filter(clearsRelevanceFloor)

  const citablePages: CitablePage[] = relevant.map((r) => ({
    material: r.spoken ? `${r.title} (spoken)` : r.title,
    page: r.pageNumber,
    text: r.text,
    moduleItemId: r.moduleItemId,
  }))

  let content = ''
  let insufficientContext = false
  let grounding: StudentTurnContext['grounding']
  if (relevant.length > 0) {
    // The [Title, page N] markers are what the inline-citation UI and side drawer
    // consume. Spoken excerpts (N1) carry "(spoken)" and cite by slide, so the
    // student always sees which answers came from the professor's mouth.
    content = relevant
      .map((r) =>
        r.spoken
          ? `[${r.title} (spoken), slide ${r.pageNumber}]\n${r.text}`
          : `[${r.title}, page ${r.pageNumber}]\n${r.text}`,
      )
      .join('\n\n')
    grounding = 'retrieval'
  } else if (retrieved.pages.length > 0 || input.hasAttachments) {
    /* An attached file takes this branch even when the section has nothing
       indexed: the student handed Athena the context themselves, so the answer
       comes from the attachment (the prompt's attachment rule) — dumping the
       whole course on top of it would only add tokens and tempt a citation the
       question never asked for. */
    insufficientContext = true
    grounding = 'insufficient'
  } else {
    content = await buildCourseDump(adminDb, sectionId)
    grounding = 'full-context'
  }

  logger.debug('buildStudentTurnContext: context assembled', {
    source: 'studentTutor.buildStudentTurnContext',
    grounding,
    retrievedPages: retrieved.pages.length,
    subQueries: retrieved.subQueries.length,
    relevantPages: relevant.length,
  })

  /* Empty content with nothing indexed is NOT the refusal branch: an unfurnished
     course should TUTOR ITS SUBJECT from general knowledge (pilot round 1), so it
     flows through to buildAiTutorPrompt's no-materials branch, which teaches
     while citing nothing and inventing nothing. The G1/G2 refusal stands where it
     belongs — materials exist and none are RELEVANT. */
  const systemPrompt = buildAiTutorPrompt(
    { ...input.header, content },
    {
      insufficientContext,
      studentState: memoryBlock ?? undefined,
      hasAttachments: input.hasAttachments,
      canLeaveArtifacts: input.canLeaveArtifacts,
    },
  )

  return { systemPrompt, citablePages, grounding }
}
