// Shared building blocks for AI quiz-question generation, extracted from the
// `generateQuestionsFromModules` server action so the streaming route handler
// (/api/.../quizzes/generate-stream) can reuse them per batch. This is a plain
// server-side module (NOT 'use server') — it takes non-serializable args (the
// admin Supabase client, Maps) that a server action could never accept.
//
// Three pieces, in the order a caller uses them:
//   1. buildQuizGenerationContext — read the selected sources once → the LLM
//      `content` string, the `sources` map for citation, the `assetRegistry`.
//   2. resolveCitationsForBatch — attribute each question to a source page.
//   3. materializeVisualsForBatch — crop/store any referenced figure/chart.
// (2) and (3) are safe to run per batch as questions stream in.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { logger } from '@/lib/logger'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { signOne } from '@/lib/supabase/signed-urls'
import { getExtractionContextForLLM, downloadFileBuffer, parseDocument, type ExtractionPage, type ExtractionMetadata } from '@/lib/document-parser'
import { loadRenderablePdf, renderPageRegionPng, isRenderableSource } from '@/lib/document-parser/asset-crop'
import { isSafeStoragePath } from '@/lib/supabase/storage'
import { buildUnitsForLLM, type AssetUnit } from '@/lib/extraction/assets'
import type { ExtractionBbox } from '@/lib/validations/document-extraction'
import { resolveQuestionCitation, type QuizSource } from '@/lib/quiz/source-citation'
import { mergeStoredConcepts, storedQuizConceptSchema, type QuizConcept, type StoredQuizConcept } from '@/lib/quiz/concept-plan'
import type { GeneratedQuestion } from '@/lib/ai/llm-client'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { createQuestionServerSchema, isQuestionComplete } from '@/lib/validations/quiz'

export type AssetRegistry = Map<string, { filePath: string; page: number; bbox?: ExtractionBbox }>

const MAX_ASSETS = 40 // bound prompt growth on asset-heavy decks
/** Per-ITEM content budget. Was a cap on the COMBINED selection, which
 *  silently starved multi-file quizzes down to ~one lecture (benchmark
 *  2026-07-18, tmp/quiz-cost-optimization/benchmark/REPORT.md finding 4). */
const CONTENT_MAX_CHARS = 30_000
/** Safety ceiling across the whole selection — bounds a pathological
 *  select-everything request, not a working budget. */
const CONTENT_TOTAL_MAX_CHARS = 400_000
// module_items.content.concepts is worker-written but still external JSON —
// parse, never cast.
const storedConceptListSchema = z.array(storedQuizConceptSchema)

export interface QuizGenerationContext {
  /** Truncated LLM content string (or '' when only custom instructions apply). */
  content: string
  /** Source-file map for citation resolution after generation. */
  sources: QuizSource[]
  /** Referenced-asset id → (file, page, bbox) for visual materialization. */
  assetRegistry: AssetRegistry
  /** Upload-time concepts merged across the selected items (design §11a), or
   *  null when ANY source lacks them (legacy item, pending extraction, ad-hoc
   *  upload) — the generator then runs its own extraction as before. */
  concepts: QuizConcept[] | null
}

/**
 * Read the selected module items + ad-hoc uploaded files and assemble the LLM
 * content. Assumes the caller has already authorized the section AND filtered
 * `additionalFilePaths` to this section's storage prefix (IDOR guard) — this
 * module trusts its inputs. `moduleItemIds` is still re-scoped to the section
 * via the `modules!inner(section_id)` join below.
 */
export async function buildQuizGenerationContext(
  adminDb: SupabaseClient<Database>,
  sectionId: string,
  moduleItemIds: string[],
  safeAdditionalPaths: string[],
): Promise<QuizGenerationContext> {
  const allParts: string[] = []
  const sources: QuizSource[] = []
  const assetRegistry: AssetRegistry = new Map()
  // Stored per-item concepts (design §11a). The merged list is only usable when
  // EVERY contributing source has one — a partial list would silently skew the
  // whole plan toward the covered items.
  const storedConceptLists: { title: string; concepts: StoredQuizConcept[] }[] = []
  let allSourcesHaveConcepts = true

  const registerAssetsFor = (filePath: string | undefined) => {
    if (!filePath || !isRenderableSource(filePath)) return undefined
    return (u: AssetUnit): string | null => {
      if (assetRegistry.size >= MAX_ASSETS) return null
      const id = `a${assetRegistry.size + 1}`
      assetRegistry.set(id, { filePath, page: u.page, bbox: u.bbox })
      return id
    }
  }

  const pageCountOf = (pages: ExtractionPage[], metadata?: ExtractionMetadata): number =>
    metadata?.pageCount ?? pages.reduce((max, p) => Math.max(max, p.pageNumber), 0)

  // Citation attribution scores question-words against page text. A sheet or
  // table-only page has little/no prose, so its questions would always lose to
  // a wordier file. Append each page's unit content (table cells, chart data,
  // figure descriptions) to its matchable text.
  const unitTextByPage = (extraction: {
    tables?: { pageNumber: number; html: string }[]
    charts?: { pageNumber: number; title?: string; data: string }[]
    figures?: { pageNumber: number; description: string }[]
  }): Map<number, string> => {
    const byPage = new Map<number, string>()
    const add = (page: number, text: string) => byPage.set(page, `${byPage.get(page) ?? ''} ${text}`)
    for (const t of extraction.tables ?? []) add(t.pageNumber, t.html.replace(/<[^>]+>/g, ' '))
    for (const c of extraction.charts ?? []) add(c.pageNumber, `${c.title ?? ''} ${c.data}`)
    for (const f of extraction.figures ?? []) add(f.pageNumber, f.description)
    return byPage
  }

  if (moduleItemIds.length > 0) {
    // IDOR guard (CWE-639): restrict to module items in THIS section via the
    // modules!inner(section_id) join — otherwise a caller could pass another
    // section's moduleItemIds and exfiltrate its lecture text via the questions.
    const { data: items, error: fetchError } = await adminDb
      .from('module_items')
      .select('id, title, content, modules!inner(section_id)')
      .in('id', moduleItemIds)
      .eq('modules.section_id', sectionId)

    if (fetchError) throw new Error('Failed to load module content')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const item of (items || []) as any[]) {
      let extraction = item.content?.extraction
      let usedInMemoryFallback = false

      // A just-registered quiz upload may still be in the extraction queue.
      // Don't block generation on it: parse the file in-memory (v1, text-only —
      // no visual assets) so the professor can proceed; the durable v2
      // extraction lands in the background for next time.
      if ((extraction?.status !== 'completed' || !extraction?.pages?.length) && item.content?.filePath) {
        try {
          const buffer = await downloadFileBuffer(item.content.filePath)
          const inMemory = await parseDocument(buffer)
          if (inMemory.status === 'completed' && inMemory.pages?.length) {
            extraction = inMemory
            usedInMemoryFallback = true
          }
        } catch (err) {
          logger.warn('buildQuizGenerationContext: in-memory fallback parse failed', {
            moduleItemId: item.id,
            error: String(err),
          })
        }
      }
      if (extraction?.status !== 'completed' || !extraction?.pages?.length) continue

      const pages: ExtractionPage[] = extraction.pages
      const metadata: ExtractionMetadata = extraction.metadata
      const title: string = item.title || 'Untitled'
      const units = buildUnitsForLLM(extraction, registerAssetsFor(item.content?.filePath))
      const text = getExtractionContextForLLM(title, pages, metadata, units)
      if (text) {
        allParts.push(text)
        // Upload-time concepts for this item (design §11a) — markers rebuilt
        // from stored page numbers against the CURRENT title downstream. An
        // in-memory fallback means the durable extraction (and its concepts)
        // isn't current, so it can't contribute.
        const stored = storedConceptListSchema.safeParse(item.content?.concepts)
        if (!usedInMemoryFallback && stored.success && stored.data.length > 0) {
          storedConceptLists.push({ title, concepts: stored.data })
        } else {
          allSourcesHaveConcepts = false
        }
        const unitText = unitTextByPage(extraction)
        sources.push({
          title,
          pageCount: pageCountOf(pages, metadata),
          ref: { kind: 'module_item', moduleItemId: item.id },
          renderable: isRenderableSource(item.content?.filePath ?? ''),
          pages: pages.map((p) => ({
            page: p.pageNumber,
            text: `${p.text} ${unitText.get(p.pageNumber) ?? ''}`,
          })),
        })
      }
    }
  }

  // Additional files uploaded specifically for this quiz (PDF/PPT). Extracted
  // in-memory — no module_item is created. Each failure is skipped, not fatal.
  for (const path of safeAdditionalPaths) {
    try {
      const buffer = await downloadFileBuffer(path)
      const extraction = await parseDocument(buffer)
      if (extraction.status === 'completed' && extraction.pages?.length) {
        // The file's basename is the citation title shown to the model + on the
        // chip. No asset units here: the v1 in-memory parse extracts pages only.
        const title = path.split('/').pop() || 'Uploaded file'
        const text = getExtractionContextForLLM(title, extraction.pages, extraction.metadata)
        if (text) {
          allParts.push(text)
          sources.push({
            title,
            pageCount: pageCountOf(extraction.pages, extraction.metadata),
            ref: { kind: 'upload', filePath: path },
            renderable: isRenderableSource(path),
            pages: extraction.pages.map((p) => ({ page: p.pageNumber, text: p.text })),
          })
        }
      }
    } catch (err) {
      logger.warn('buildQuizGenerationContext: additional file extraction failed', { error: String(err) })
    }
  }

  let content = ''
  if (allParts.length > 0) {
    // Cap per item, not per selection — every selected file contributes.
    const capped = allParts.map((p) =>
      p.length > CONTENT_MAX_CHARS ? p.slice(0, CONTENT_MAX_CHARS) + '\n\n[Content truncated due to length]' : p,
    )
    const combined = capped.join('\n\n')
    content = combined.length > CONTENT_TOTAL_MAX_CHARS
      ? combined.slice(0, CONTENT_TOTAL_MAX_CHARS) + '\n\n[Content truncated due to length]'
      : combined
  }

  // Ad-hoc uploads never have stored concepts; any gap disables the merged
  // list so the generator's runtime extraction covers everything instead.
  const concepts = allSourcesHaveConcepts && safeAdditionalPaths.length === 0 && storedConceptLists.length > 0
    ? mergeStoredConcepts(storedConceptLists)
    : null

  return { content, sources, assetRegistry, concepts }
}

/**
 * Attribute each question to its source page: prefer the model's verifiable
 * `[Title, page N]` hint, else a deterministic content match against the source
 * pages. Mutates each question (`sourceCitation` set, raw model fields dropped).
 * Returns how many were cited. Safe to call per streamed batch.
 */
export function resolveCitationsForBatch(questions: GeneratedQuestion[], sources: QuizSource[]): number {
  let citedCount = 0
  for (const q of questions) {
    // AI-extended questions carry their own {kind:'ai_extended'} tag set at
    // generation (they have no source page to cite) — never overwrite it with a
    // resolved/null source citation.
    if (q.sourceCitation?.kind === 'ai_extended') {
      citedCount++
      delete q.sourceTitle
      delete q.sourcePage
      continue
    }
    const matchParts: string[] = [q.questionText, q.explanation ?? '', ...(q.tags ?? [])]
    if (q.content.questionType === 'multiple_choice') matchParts.push(...q.content.choices.map((c) => c.text))
    else if (q.content.questionType === 'short_answer') matchParts.push(...q.content.acceptedAnswers)
    else if (q.content.questionType === 'fill_in_blank') matchParts.push(...q.content.blanks.flatMap((b) => b.acceptedAnswers))
    q.sourceCitation = resolveQuestionCitation(q.sourceTitle, q.sourcePage, matchParts.join(' '), sources)
    if (q.sourceCitation) citedCount++
    delete q.sourceTitle
    delete q.sourcePage
  }
  return citedCount
}

/** Recover a model-mangled asset id: registry ids are `a<n>`, but the model
 *  sometimes drops the prefix ("31" for "a31" — benchmark 2026-07-18,
 *  fixed-s100 Q53). Returns the registered form, or the id unchanged. */
export function normalizeAssetId(id: string, assetRegistry: AssetRegistry): string {
  if (assetRegistry.has(id)) return id
  if (/^\d+$/.test(id) && assetRegistry.has(`a${id}`)) return `a${id}`
  return id
}

/**
 * Rewrite "the table shown"-style phrasing in a question that ends up WITHOUT
 * a visual (hallucinated/unrenderable asset id, crop failure, or the model
 * ignored the no-asset rule): the student sees no table, so a question
 * promising one reads as broken. The referenced description IS in the
 * extracted source text (that's what the model read), so "described in the
 * material" stays truthful. Exported for unit tests.
 */
export function scrubPhantomVisualRefs(text: string): string {
  const NOUN = '(?:table|chart|figure|diagram|graph|image|visual|visualization|illustration)'
  return text
    // "shown in the (provided) figure" / "depicted in the accompanying chart"
    .replace(
      new RegExp(`\\b(?:shown|displayed|depicted|illustrated)\\s+in\\s+the\\s+(?:provided\\s+|accompanying\\s+)?${NOUN}s?\\b`, 'gi'),
      'described in the material',
    )
    // "the table shown" / "the visualizations shown" / "the chart below".
    // "provided" only when it ends the phrase — "the chart provided by the
    // vendor" is ordinary prose, not a promise of a rendered visual.
    .replace(
      new RegExp(`\\b(${NOUN}s?)\\s+(?:shown|displayed|depicted|below|above|provided(?!\\s+(?:by|in|at|for|to|with|from)\\b))\\b`, 'gi'),
      '$1 described in the material',
    )
}

/**
 * Materialize visuals: for each question grounded in a REGISTERED asset (a
 * hallucinated id simply isn't in the registry → text-only question), render
 * the source page region, store the crop, and attach it via imagePath/imageUrl.
 * Mutates each question (`sourceAssetId` dropped; phantom "shown" phrasing
 * scrubbed from questions that end up text-only). Returns how many got a
 * visual. Failures degrade to text-only. Safe to call per streamed batch.
 */
export async function materializeVisualsForBatch(
  adminDb: SupabaseClient<Database>,
  sectionId: string,
  questions: GeneratedQuestion[],
  assetRegistry: AssetRegistry,
): Promise<number> {
  let visualCount = 0
  for (const q of questions) {
    if (q.sourceAssetId) q.sourceAssetId = normalizeAssetId(q.sourceAssetId, assetRegistry)
  }
  const referencedAssetIds = [...new Set(
    questions
      .map((q) => q.sourceAssetId)
      .filter((id): id is string => !!id && assetRegistry.has(id)),
  )]
  const cropByAsset = new Map<string, { path: string; url: string }>()
  const pdfByFile = new Map<string, Buffer | 'unsupported' | null>()
  for (const id of referencedAssetIds) {
    const asset = assetRegistry.get(id)!
    try {
      let pdf = pdfByFile.get(asset.filePath)
      if (pdf === undefined) {
        /* The path must belong to the section this generation run is for.
           `content.filePath` is professor-writable and loadRenderablePdf both
           reads the file and writes a cached derived PDF beside it with the
           admin client, so an item naming another tenant's key would pull their
           document into this course's quiz and leave a file in their prefix.
           (`safeAdditionalPaths` is already guarded; this branch was not.) */
        if (!isSafeStoragePath(asset.filePath, `${sectionId}/`)) {
          logger.warn('materializeVisualsForBatch: asset path outside section — skipped', {
            source: 'quiz.aiGeneration',
            sectionId,
          })
          pdfByFile.set(asset.filePath, 'unsupported')
          continue
        }
        pdf = await loadRenderablePdf(adminDb, asset.filePath)
        pdfByFile.set(asset.filePath, pdf)
      }
      if (!pdf || pdf === 'unsupported') continue
      const png = await renderPageRegionPng(pdf, asset.page, asset.bbox)
      if (!png) continue
      const cropPath = `${sectionId}/quiz-ai-images/${crypto.randomUUID()}.png`
      const { error: upErr } = await adminDb.storage
        .from(COURSE_MATERIALS_BUCKET)
        .upload(cropPath, png, { contentType: 'image/png' })
      if (upErr) {
        logger.warn('materializeVisualsForBatch: asset crop upload failed', { cropPath, error: upErr.message })
        continue
      }
      const url = await signOne(COURSE_MATERIALS_BUCKET, cropPath)
      if (url) cropByAsset.set(id, { path: cropPath, url })
    } catch (err) {
      logger.warn('materializeVisualsForBatch: asset crop failed', { assetId: id, error: String(err) })
    }
  }
  for (const q of questions) {
    const crop = q.sourceAssetId ? cropByAsset.get(q.sourceAssetId) : undefined
    if (crop) {
      q.imagePath = crop.path
      q.imageUrl = crop.url
      visualCount++
    } else if (!q.imagePath) {
      // Text-only question — it must not promise a visual it doesn't have.
      q.questionText = scrubPhantomVisualRefs(q.questionText)
      if (q.explanation) q.explanation = scrubPhantomVisualRefs(q.explanation)
    }
    delete q.sourceAssetId
  }
  return visualCount
}

// ── Server-side batch persistence (docs/designs/quizzes/quiz-generation-v2.md) ──
//
// The generation route saves every batch to the draft quiz THE MOMENT it is
// generated, so the browser is a live viewer of the run, not its owner: a
// reload, navigation, or crash mid-generation loses nothing — the run
// finishes server-side and every question lands on the quiz.

/** One quiz_questions row from a validated question. Kept in lockstep with the
 *  row mapping in bulkCreateQuestions (actions.ts) — the studio's draft-save
 *  path and this route-side path must persist identical shapes. */
function questionRow(sectionId: string, id: string, q: GeneratedQuestion) {
  return {
    id,
    section_id: sectionId,
    question_text: q.questionText,
    question_type: q.content.questionType,
    content: q.content,
    difficulty: q.difficulty,
    blooms_level: q.bloomsLevel,
    tags: q.tags,
    points: q.points,
    explanation: q.explanation,
    is_bonus: q.isBonus,
    is_extra_credit: q.isExtraCredit,
    image_url: q.imageUrl,
    image_path: q.imagePath,
    code_snippet: q.codeSnippet,
    elo_rating: q.eloRating ?? 1200,
    expected_time_seconds: q.expectedTimeSeconds ?? null,
    irt_a: q.irtA ?? null,
    irt_b: q.irtB ?? null,
    irt_c: q.irtC ?? null,
    rubric: q.rubric ?? null,
    source_citation: q.sourceCitation ?? null,
    is_complete: isQuestionComplete(q.questionText, q.content, q.rubric),
  }
}

/** Next free assignment position on a quiz (0 when it has none). */
export async function nextAssignmentPosition(
  adminDb: SupabaseClient<Database>,
  quizId: string,
): Promise<number> {
  const { data } = await adminDb
    .from('quiz_question_assignments')
    .select('position')
    .eq('quiz_id', quizId)
    .order('position', { ascending: false })
    .limit(1)
  return data?.[0] ? (data[0].position as number) + 1 : 0
}

/**
 * Persist one generated batch: insert the questions into the section bank and
 * assign them to the quiz at the next positions. Returns the db id per input
 * question (null where a question failed strict validation — it still streams
 * to the studio, whose draft autosave persists it leniently), plus the next
 * free position. Caller has already verified section access AND that `quizId`
 * belongs to the section. Failures return all-null ids — the stream continues
 * and the studio's autosave remains the safety net for connected clients.
 */
export async function persistGeneratedBatch(
  adminDb: SupabaseClient<Database>,
  sectionId: string,
  quizId: string,
  questions: GeneratedQuestion[],
  startPosition: number,
): Promise<{ ids: (string | null)[]; nextPosition: number }> {
  const ids: (string | null)[] = questions.map(() => null)
  try {
    // Strict validation — AI output is complete by construction (parseRawQuestion
    // drops ungradeable items), so failures here are rare edge cases.
    const rows: ReturnType<typeof questionRow>[] = []
    const rowIndex: number[] = []
    questions.forEach((q, i) => {
      const parsed = createQuestionServerSchema.safeParse(q)
      if (parsed.success) {
        const id = randomUUID()
        rows.push(questionRow(sectionId, id, q))
        rowIndex.push(i)
      } else {
        // A dropped question silently shrinks the quiz vs the streamed count —
        // name the exact field so the parseRawQuestion/schema gap is fixable.
        const issue = parsed.error.issues[0]
        logger.warn('persistGeneratedBatch: generated question failed strict validation — not persisted', {
          sectionId,
          quizId,
          questionType: q.content?.questionType ?? 'unknown',
          field: issue?.path.join('.') ?? '',
          issue: issue?.message ?? '',
        })
      }
    })
    if (rows.length === 0) return { ids, nextPosition: startPosition }

    const { error: insertErr } = await adminDb.from('quiz_questions').insert(rows)
    if (insertErr) {
      logger.error('persistGeneratedBatch: question insert failed', insertErr, { sectionId, quizId })
      return { ids, nextPosition: startPosition }
    }
    const { error: assignErr } = await adminDb.from('quiz_question_assignments').insert(
      rows.map((r, i) => ({ quiz_id: quizId, question_id: r.id, position: startPosition + i })),
    )
    if (assignErr) {
      logger.error('persistGeneratedBatch: assignment insert failed', assignErr, { sectionId, quizId })
      // Best-effort cleanup: without assignments the bank rows would be
      // invisible orphans that still surface in "Pick from question bank" —
      // remove them and report the batch unpersisted so the connected
      // studio's autosave takes over.
      await adminDb.from('quiz_questions').delete().in('id', rows.map((r) => r.id)).eq('section_id', sectionId)
      return { ids, nextPosition: startPosition }
    }
    rows.forEach((r, i) => {
      ids[rowIndex[i]] = r.id
    })
    return { ids, nextPosition: startPosition + rows.length }
  } catch (err) {
    logger.error('persistGeneratedBatch: exception', err, { sectionId, quizId })
    return { ids, nextPosition: startPosition }
  }
}
