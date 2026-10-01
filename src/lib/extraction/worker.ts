// Pure worker pipeline. Imported by the /api/extraction-worker/kick
// route handler; contains zero HTTP concerns so it's easy to test
// and cheap to reuse from a future admin "re-run this item" button.
//
// Flow per invocation:
//   1. claim_next_extraction_job RPC (atomic, FOR UPDATE SKIP LOCKED)
//   2. dispatch by kind:
//        - 'extract' / 'backfill-extraction'  → runExtractJob
//        - 'cleanup-storage'                   → runCleanupJob
//   3. update status back to the DB: 'completed' / 'failed' / 'partial'
//   4. also mirror granular per-subsystem status into
//      module_items.content.extraction.{textStatus, imagesStatus, formulasStatus}
//      so the UI can show three badges live.
//
// Returns { claimed: false } when the queue is empty so the caller
// can exit the drain loop. Never throws — all errors are captured
// on the job row so the next drain doesn't poison-pill.

import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { createAdminClient } from '@/lib/supabase/admin'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { logger } from '@/lib/logger'
import {
  extractDocument,
  type ExtractionV2Result,
} from '@/lib/document-parser/index-v2'
import {
  shouldCallVision,
  isLikelyScannedPdf,
  runVisionFormulaExtraction,
  runVisionOnImage,
} from '@/lib/document-parser/vision'
import { getTextForLLM, getExtractionContextForLLM } from '@/lib/document-parser'
import { buildUnitsForLLM } from '@/lib/extraction/assets'
import { extractTopicsFromContent, extractQuizConcepts, CONCEPT_MIN_CONCEPTS } from '@/lib/ai/llm-client'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import { z } from 'zod'
import { pagesFromMarkers, storedQuizConceptSchema, type StoredQuizConcept } from '@/lib/quiz/concept-plan'
import { seedMaterialSkills, isNonConcept } from '@/lib/skills/reconcile'
import { storeTopicPageAnchors } from '@/lib/pinecone/topic-pages'
import { recomputeSectionMastery } from '@/lib/skills/recompute'
import { enqueueMasteryRecompute } from '@/lib/extraction/enqueue'
import { enqueueJob } from '@/lib/jobs/enqueue'
import { EMBED_MATERIAL_JOB_TYPE } from '@/lib/jobs/pipelines/embed-material'
import { stripNul } from '@/lib/extraction/sanitize'

// ── Types ──────────────────────────────────────────────────────

export interface ExtractionJobRow {
  id: string
  kind: 'extract' | 'cleanup-storage' | 'backfill-extraction' | 'backfill-concepts' | 'recompute-mastery'
  module_item_id: string | null
  status: string
  attempts: number
  max_attempts: number
  payload: Record<string, unknown>
  error: string | null
  claimed_by: string | null
  claim_expires_at: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  heartbeat_at: string | null
}

export interface RunWorkerResult {
  /** Whether we claimed a job at all. When false the queue is drained. */
  claimed: boolean
  jobId?: string
  kind?: ExtractionJobRow['kind']
  finalStatus?: 'completed' | 'failed' | 'partial'
  error?: string
}

export interface WorkerOptions {
  workerId?: string
  adminClient?: SupabaseClient
  claimTtlSeconds?: number
}

// ── Helpers ────────────────────────────────────────────────────

function getAdmin(opts?: WorkerOptions): SupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (opts?.adminClient ?? (createAdminClient() as any)) as SupabaseClient
}

/**
 * A worker may only defer to a *newer* job. `existingJobId` is whatever jobId is
 * recorded on the row right now; a different id belonging to an OLDER or dead job
 * (e.g. one that crashed before finishing) must NOT block us — otherwise a single
 * crash poisons the row permanently and no future job can ever write. We defer
 * only when the recorded job was created strictly after the current one (the real
 * supersede race: a newer re-upload landed while we ran). Returns true = skip.
 */
async function isSupersededByNewer(
  admin: SupabaseClient,
  existingJobId: string | undefined,
  current: { id: string; created_at: string },
): Promise<boolean> {
  if (!existingJobId || existingJobId === current.id) return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('extraction_jobs')
    .select('created_at')
    .eq('id', existingJobId)
    .single()
  const recordedCreatedAt = (data as { created_at?: string } | null)?.created_at
  // Unknown recorded job (deleted / legacy row with no jobId) → safe to write.
  if (!recordedCreatedAt) return false
  return new Date(recordedCreatedAt).getTime() > new Date(current.created_at).getTime()
}

/**
 * Claim the next job atomically via the SQL function. Returns null
 * when the queue is empty (or only contains poison-pilled jobs).
 */
async function claimNext(
  admin: SupabaseClient,
  workerId: string,
  claimTtlSeconds: number,
): Promise<ExtractionJobRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any).rpc('claim_next_extraction_job', {
    p_worker_id: workerId,
    p_claim_ttl_seconds: claimTtlSeconds,
  })
  if (error) {
    logger.error('worker.claimNext: RPC failed', error)
    return null
  }
  // plpgsql composite return: when the function's UPDATE matches no
  // row the `claimed` local stays as an empty composite — supabase-js
  // serialises that as an object with every field NULL rather than
  // returning NULL outright. Treat a null `id` as "queue was empty"
  // so the drain loop can exit. Otherwise: infinite loop of
  // "claimed { id:null }" → runExtractJob → fails on missing id →
  // loop again until maxDuration.
  if (!data) return null
  const row = (Array.isArray(data) ? data[0] : data) as ExtractionJobRow | null
  if (!row || !row.id) return null
  return row
}

async function writeJobCompletion(
  admin: SupabaseClient,
  jobId: string,
  status: 'completed' | 'failed' | 'partial',
  error: string | null,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('extraction_jobs')
    .update({
      status,
      completed_at: new Date().toISOString(),
      error,
    })
    .eq('id', jobId)
}

async function fetchModuleItem(admin: SupabaseClient, moduleItemId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('module_items')
    .select('id, title, item_type, content, module_id')
    .eq('id', moduleItemId)
    .single()
  if (error || !data) return null
  return data as {
    id: string
    title: string | null
    item_type: string
    content: Record<string, unknown>
    module_id: string
  }
}

async function resolveSectionContext(
  admin: SupabaseClient,
  moduleId: string,
): Promise<{ sectionId: string; institutionId: string } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('modules')
    .select('section_id, course_sections!inner(institution_id)')
    .eq('id', moduleId)
    .single()
  if (error || !data) return null
  const sectionRel = Array.isArray(data.course_sections) ? data.course_sections[0] : data.course_sections
  const institutionId: string | undefined = sectionRel?.institution_id
  if (!data.section_id || !institutionId) return null
  return { sectionId: data.section_id as string, institutionId }
}

async function downloadFileBuffer(
  admin: SupabaseClient,
  filePath: string,
): Promise<Buffer | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any).storage
    .from(COURSE_MATERIALS_BUCKET)
    .download(filePath)
  if (error || !data) {
    logger.error('worker.downloadFileBuffer: download failed', error, { filePath })
    return null
  }
  const ab = await (data as Blob).arrayBuffer()
  return Buffer.from(ab)
}

async function mergeContentExtraction(
  admin: SupabaseClient,
  moduleItemId: string,
  extraction: ExtractionV2Result,
  job: Pick<ExtractionJobRow, 'id' | 'created_at'>,
): Promise<{ ok: boolean; error?: string }> {
  // Re-fetch first so we don't stomp other fields that might have been
  // edited between the start of this job and now (file replaced, title
  // changed, etc.).
  const item = await fetchModuleItem(admin, moduleItemId)
  if (!item) return { ok: false, error: 'module item vanished before content write' }

  // GUARD AGAINST SUPERSEDE RACE: defer only to a genuinely NEWER job. A stale
  // jobId from an older/dead job (crashed before finishing) must not block us —
  // otherwise the row is poisoned forever and no future job can ever write.
  const existing = (item.content ?? {}) as { extraction?: { jobId?: string } }
  if (await isSupersededByNewer(admin, existing.extraction?.jobId, job)) {
    logger.info('mergeContentExtraction: skipping write — a newer job owns the row', {
      moduleItemId,
      currentJobId: job.id,
      existingJobId: existing.extraction?.jobId,
    })
    return { ok: true } // deliberately not our row — not a failure
  }

  // Strip NULs: extracted PDF text can contain U+0000, which Postgres rejects in
  // jsonb — an unsanitised write throws and (unchecked) freezes the item forever.
  const newContent = stripNul({ ...(item.content ?? {}), extraction })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from('module_items')
    .update({
      content: newContent,
      updated_at: new Date().toISOString(),
    })
    .eq('id', moduleItemId)
  if (error) {
    logger.error('mergeContentExtraction: content write failed', error, { moduleItemId, jobId: job.id })
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

/**
 * Incrementally update just the status fields so UI badges can
 * advance while the job runs. Merges into existing extraction blob
 * if one exists, or writes a fresh stub otherwise.
 *
 * jobId guard: if the row already has a different jobId recorded,
 * this is a superseded/zombie worker and we don't touch the row.
 */
async function writeProgressStatus(
  admin: SupabaseClient,
  moduleItemId: string,
  job: Pick<ExtractionJobRow, 'id' | 'created_at'>,
  patch: {
    textStatus?: string
    imagesStatus?: string
    formulasStatus?: string
  },
) {
  const item = await fetchModuleItem(admin, moduleItemId)
  if (!item) return
  const content = (item.content ?? {}) as Record<string, unknown>
  const prev = (content.extraction as Record<string, unknown> | undefined) ?? {
    status: 'processing',
    extractedAt: new Date().toISOString(),
    error: null,
    metadata: { pageCount: 0, wordCount: 0 },
    pages: [],
  }

  // Same recency guard as the final merge: a stale jobId from a dead older job
  // must not stop us claiming the row (else re-extraction is impossible).
  const existingJobId = (prev as { jobId?: string }).jobId
  if (await isSupersededByNewer(admin, existingJobId, job)) return

  const nextExtraction = { ...prev, ...patch, jobId: job.id }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('module_items')
    .update({
      content: stripNul({ ...content, extraction: nextExtraction }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', moduleItemId)
}

// ── Concept pass (shared by extract + backfill-concepts) ───────

/**
 * One concept pass over an extraction result: build the same "[Title, page N]"
 * marked content quiz generation reads at run time, extract + junk-filter the
 * concepts, and shape them for storage (page numbers, not title-bound markers).
 * Returns null when the pass fails or finds too little (< CONCEPT_MIN_CONCEPTS)
 * to be worth storing. Shared by the upload-time extract job and the
 * 'backfill-concepts' job so the two can never drift apart.
 */
async function extractStorableConcepts(
  title: string,
  extraction: ExtractionV2Result,
  sectionId: string,
): Promise<{ concepts: StoredQuizConcept[]; topics: string[]; summary: string | null } | null> {
  // Same formatter as buildQuizGenerationContext, so the markers the model
  // cites match the blocks quiz generation splits at run time. No asset
  // tagger — [ASSET] ids are a per-run concern. 100k cap: full-document
  // coverage beats the old 8k-char topic view.
  const conceptContent = getExtractionContextForLLM(
    title,
    extraction.pages,
    extraction.metadata,
    buildUnitsForLLM(extraction),
  ).slice(0, 100_000)
  const rich = await extractQuizConcepts(conceptContent, { sectionId })
  // Deterministic backstop to the extraction prompt: drop course-admin /
  // structure names ("Course Logistics", "References", …) AND junk (quiz/slide
  // titles, test scaffolding) the model may still emit, so stored concepts and
  // content.topics (the material-viewer panel + roadmap chips) only ever hold
  // assessable concepts. Single source of truth with the skill pool.
  const clean = (rich?.concepts ?? []).filter((c) => !isNonConcept(c.name))
  if (!rich || clean.length < CONCEPT_MIN_CONCEPTS) return null
  return {
    concepts: clean.map((c) => ({
      name: c.name,
      importance: c.importance,
      pages: pagesFromMarkers(c.markers),
      summary: c.summary,
    })),
    // Top-7 by importance — preserves the old roadmap-chip density.
    topics: clean.slice(0, 7).map((c) => c.name),
    summary: rich.summary,
  }
}

// ── Job handlers ───────────────────────────────────────────────

async function runExtractJob(
  admin: SupabaseClient,
  job: ExtractionJobRow,
): Promise<{ finalStatus: 'completed' | 'failed' | 'partial'; error: string | null }> {

  if (!job.module_item_id) {
    return { finalStatus: 'failed', error: 'extract job has no module_item_id' }
  }
  const item = await fetchModuleItem(admin, job.module_item_id)
  if (!item) return { finalStatus: 'failed', error: 'module item not found' }

  const content = item.content as {
    fileType?: string
    filePath?: string
    fileSize?: string | number
  }
  const fileType = content.fileType ?? ''
  const filePath = content.filePath ?? ''
  if (!filePath) return { finalStatus: 'failed', error: 'no filePath in content' }
  if (!['pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'image', 'text'].includes(fileType)) {
    return { finalStatus: 'failed', error: `unsupported fileType: ${fileType}` }
  }

  const sectionCtx = await resolveSectionContext(admin, item.module_id)
  if (!sectionCtx) {
    return { finalStatus: 'failed', error: 'could not resolve section/institution from module_id' }
  }
  const { sectionId, institutionId } = sectionCtx

  // Institution/platform AI kill switch — vision extraction, topic tagging and
  // embeddings are all AI. Skip terminally with an explicit reason; re-running
  // the job after re-enable works normally.
  const aiVerdict = await checkAiFeature(admin, institutionId, 'content-ai')
  if (!aiVerdict.allowed) {
    return { finalStatus: 'failed', error: 'Skipped: AI features are disabled for this institution.' }
  }

  // Mark the subsystems as processing so the UI can show a spinner
  // before we even finish the download.
  await writeProgressStatus(admin, job.module_item_id, job, {
    textStatus: 'processing',
    imagesStatus: 'processing',
    formulasStatus: fileType === 'pdf' ? 'pending' : 'processing',
  })

  const buffer = await downloadFileBuffer(admin, filePath)
  if (!buffer) return { finalStatus: 'failed', error: `storage download failed for ${filePath}` }

  const result = await extractDocument(buffer, {
    sectionId,
    moduleItemId: job.module_item_id,
    fileType,
    overrides: { adminClient: admin },
  })

  result.jobId = job.id

  // ── Vision pass (PDF only) ──────────────────────────────────
  // PPTX formulas come from OMML and are already in result.formulas.
  // For PDFs we need to decide per-page whether the text shows math
  // signals, then render and run vision on the flagged pages. If the
  // PDF is a scanned document (almost no text) we route every page.
  //
  // Cost guards: env-configured hard caps prevent a runaway job from
  // blowing through the Gemini budget.
  if (fileType === 'pdf') {
    const maxPages = Number(process.env.EXTRACTION_VISION_MAX_PAGES_PER_DOC ?? '200')
    const maxMb = Number(process.env.EXTRACTION_VISION_MAX_MB_PER_DOC ?? '50')
    const mb = buffer.length / (1024 * 1024)

    // Pages where Tier-0 flagged a borderless/merged/low-confidence table for the
    // VLM. Transient — consume it here and clear it so it never persists.
    const flaggedTablePages = result.tableVisionPages ?? []
    result.tableVisionPages = undefined

    if (result.metadata.pageCount > maxPages || mb > maxMb) {
      logger.warn('worker: vision skipped — exceeds cost cap', {
        jobId: job.id,
        moduleItemId: job.module_item_id,
        pageCount: result.metadata.pageCount,
        mb: +mb.toFixed(1),
        maxPages,
        maxMb,
      })
      result.formulasStatus = 'skipped'
    } else {
      const scanned = isLikelyScannedPdf({
        pageCount: result.metadata.pageCount,
        wordCount: result.metadata.wordCount,
      })

      const pagesForVision: number[] = []
      for (const p of result.pages) {
        if (scanned) {
          pagesForVision.push(p.pageNumber)
          continue
        }
        const decision = shouldCallVision({
          pageNumber: p.pageNumber,
          text: p.text,
        })
        if (decision.callVision) pagesForVision.push(p.pageNumber)
      }
      // Also send pages with a borderless/merged table — the VLM returns its HTML
      // on the same call (the schema is widened to include tables). No extra calls
      // for pages already flagged for math.
      for (const pn of flaggedTablePages) {
        if (!pagesForVision.includes(pn)) pagesForVision.push(pn)
      }

      if (pagesForVision.length === 0) {
        result.formulasStatus = 'skipped'
      } else {
        // Surface "processing formulas" to the UI before we start,
        // since the vision pass is what drags the total time up.
        await writeProgressStatus(admin, job.module_item_id, job, {
          formulasStatus: 'processing',
        })

        try {
          const vision = await runVisionFormulaExtraction({
            pdfBuffer: buffer,
            pageNumbers: pagesForVision,
            visionOptions: { attribution: { sectionId } },
          })
          const existing = result.formulas ?? []
          const combined = [...existing, ...vision.formulas]
          result.formulas = combined.length > 0 ? combined : undefined
          result.metadata.formulaCount = combined.length

          // Figure descriptions ride the same vision call (Phase 2) — no extra API cost.
          const combinedFigures = [...(result.figures ?? []), ...vision.figures]
          result.figures = combinedFigures.length > 0 ? combinedFigures : undefined

          // VLM table HTML for the flagged (borderless/merged) pages (Phase 3b),
          // alongside the deterministic geometric tables Tier-0 already produced.
          const combinedTables = [...(result.tables ?? []), ...vision.tables]
          result.tables = combinedTables.length > 0 ? combinedTables : undefined
          if (vision.tables.length > 0) result.tablesStatus = 'completed'

          if (vision.perPageErrors.length > 0 && vision.formulas.length === 0) {
            // Every vision call failed — mark subsystem failed without
            // flipping the whole job; text+images still succeeded.
            result.formulasStatus = 'failed'
            if (result.status === 'completed') result.status = 'partial'
          } else {
            result.formulasStatus = 'completed'
          }

          if (vision.perPageErrors.length > 0) {
            logger.warn('worker: some vision calls failed', {
              jobId: job.id,
              moduleItemId: job.module_item_id,
              failed: vision.perPageErrors.length,
              succeeded: vision.callsMade - vision.perPageErrors.length,
            })
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error('worker: vision orchestrator crashed', err, {
            jobId: job.id,
            moduleItemId: job.module_item_id,
          })
          result.formulasStatus = 'failed'
          if (result.status === 'completed') {
            result.status = 'partial'
            result.error = message
          }
        }
      }
    }
  }

  // ── Vision pass (standalone image, Phase 5c) ────────────────
  // An image has no Tier-0 floor — the whole thing goes to the VLM as one
  // page-1 call. Same MB cost guard as the PDF path. Everything it reads is
  // tagged 'vision'; on failure we keep status partial, never lose the row.
  if (fileType === 'image') {
    const maxMb = Number(process.env.EXTRACTION_VISION_MAX_MB_PER_DOC ?? '50')
    const mb = buffer.length / (1024 * 1024)
    if (mb > maxMb) {
      logger.warn('worker: image vision skipped — exceeds cost cap', {
        jobId: job.id,
        moduleItemId: job.module_item_id,
        mb: +mb.toFixed(1),
        maxMb,
      })
      result.formulasStatus = 'skipped'
      result.tablesStatus = 'skipped'
    } else {
      await writeProgressStatus(admin, job.module_item_id, job, {
        formulasStatus: 'processing',
      })
      try {
        const vision = await runVisionOnImage({
          imageBuffer: buffer,
          visionOptions: { attribution: { sectionId } },
        })
        result.formulas = vision.formulas.length > 0 ? vision.formulas : undefined
        result.figures = vision.figures.length > 0 ? vision.figures : undefined
        result.tables = vision.tables.length > 0 ? vision.tables : undefined
        result.metadata.formulaCount = vision.formulas.length
        result.formulasStatus = 'completed'
        result.tablesStatus = 'completed'
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error('worker: image vision crashed', err, {
          jobId: job.id,
          moduleItemId: job.module_item_id,
        })
        result.formulasStatus = 'failed'
        result.tablesStatus = 'failed'
        if (result.status === 'completed') {
          result.status = 'partial'
          result.error = message
        }
      }
    }
  }

  const merged = await mergeContentExtraction(admin, job.module_item_id, result, job)
  if (!merged.ok) {
    // The result never persisted (e.g. a rejected jsonb write). Fail loudly so
    // the job is retriable and the UI doesn't sit on a phantom 'processing'.
    return { finalStatus: 'failed', error: merged.error ?? 'content write failed' }
  }

  /* Re-index this material now that its text exists.
   *
   * The embedding job is enqueued alongside extraction at upload, so it
   * normally runs FIRST — and for anything without a renderable source of its
   * own (plain text, converted legacy Office, a spreadsheet) it then finds no
   * extraction to read, removes the material's vectors and reports success.
   * Nothing re-ran it, so those materials stayed unindexed until the professor
   * happened to edit the item. Extraction finishing is the event that makes
   * them indexable, so extraction is what has to say so.
   *
   * Idempotent and cheap for the common case: `enqueueJob` collapses onto any
   * pending job for the same subject, and a re-run of an already-indexed PDF
   * skips every page on its content hash. */
  try {
    await enqueueJob({
      type: EMBED_MATERIAL_JOB_TYPE,
      params: { moduleItemId: job.module_item_id },
      institutionId,
      sectionId,
      subjectKey: job.module_item_id,
    })
  } catch (err) {
    logger.warn('worker.runExtractJob: embed re-enqueue failed (non-fatal)', {
      jobId: job.id,
      moduleItemId: job.module_item_id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // ── Topic + concept extraction (best-effort, non-blocking) ─────
  // ONE rich call (design §11a): the same "[Title, page N]"-marked content the
  // quiz pipeline reads at run time goes through extractQuizConcepts once at
  // upload. The ranked concepts are STORED (content.concepts, page numbers —
  // title-independent, items get renamed) so quiz runs skip their own
  // whole-document extraction call; content.topics stays the flat derived view
  // (roadmap chips + skills pool — consumers unchanged) and the doc summary
  // rides the same call. A failed/thin concept pass falls back to the old
  // topic-only call; either way a failure here never fails the job (text +
  // images + formulas already landed via mergeContent above).
  let topicCount = 0
  if ((result.status === 'completed' || result.status === 'partial') && result.pages.length > 0) {
    try {
      const pass = await extractStorableConcepts(item.title || 'Untitled', result, sectionId)

      let cleanTopics: string[]
      let summary: string | null
      let storedConcepts: StoredQuizConcept[] | null = null
      if (pass) {
        storedConcepts = pass.concepts
        cleanTopics = pass.topics
        summary = pass.summary
      } else {
        // Concept pass failed or found too little to store — the old topic-only
        // call still gives the roadmap its chips; quiz runs extract concepts at
        // run time as before.
        const llmText = getTextForLLM(result.pages, result.metadata)
        const extracted = await extractTopicsFromContent(llmText.slice(0, 100_000), { sectionId })
        cleanTopics = (extracted?.topics ?? []).filter((t) => !isNonConcept(t))
        summary = extracted?.summary ?? null
      }

      if (cleanTopics.length > 0) {
        topicCount = cleanTopics.length
        // Re-fetch to avoid stomping concurrent edits to other content fields.
        const fresh = await fetchModuleItem(admin, job.module_item_id)
        if (fresh) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const freshContent = { ...((fresh.content || {}) as Record<string, any>) }
          /* Recomputed below against the freshly-written topics, so the stale
             map must not survive a run that fails to produce a new one — a rail
             pointing at the previous upload's pages is worse than no rail. */
          delete freshContent.topicPages
          // A fallback run must not leave STALE concepts from an earlier
          // extraction next to fresh topics (e.g. the file was replaced) —
          // quiz runs would plan against the wrong document.
          if (!storedConcepts) delete freshContent.concepts
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (admin as any)
            .from('module_items')
            .update({
              content: stripNul({
                ...freshContent,
                topics: cleanTopics,
                ...(summary ? { summary } : {}),
                ...(storedConcepts ? { concepts: storedConcepts } : {}),
              }),
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.module_item_id)
        }
        /* Topic→page anchors for the material-viewer reference rail, matched
           against the pages this material already has in the vector index
           (roadmap-rail-v1). Written onto the item so the roadmap reads them
           for free; see topic-pages.ts for why this is computed here rather
           than per render. Best-effort — no anchors means the rail falls back
           to exact-substring matching, which is what it did before any of this
           existed. */
        await storeTopicPageAnchors(admin, {
          institutionId,
          sectionId,
          moduleItemId: job.module_item_id,
          topics: cleanTopics,
        })
        // Auto-populate the section's Topic Mastery pool from these extracted
        // topics (de-duped; excluded topics are never re-added). Best-effort.
        await seedMaterialSkills(admin, job.module_item_id, cleanTopics)
        // Seeded concepts start suppressed (suggested); a section recompute runs
        // reconcile, which promotes the corroborated ones to tracked.
        await enqueueMasteryRecompute(sectionId)
      } else {
        /* No topics, but the document still CHANGED — so any anchors sitting on
           the row belong to the file this run replaced, and they would stay
           live and look current. Clear them here too: the deletion above only
           runs on the has-topics path, so a re-upload whose topic pass came
           back empty was the one way a stale rail survived. */
        const fresh = await fetchModuleItem(admin, job.module_item_id)
        if (fresh && (fresh.content as Record<string, unknown>)?.topicPages) {
          const cleared = { ...(fresh.content as Record<string, unknown>) }
          delete cleared.topicPages
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (admin as any)
            .from('module_items')
            .update({ content: cleared, updated_at: new Date().toISOString() })
            .eq('id', job.module_item_id)
        }
        logger.warn('worker.runExtractJob: no topics extracted', {
          jobId: job.id,
          moduleItemId: job.module_item_id,
        })
      }
    } catch (topicErr) {
      logger.warn('worker.runExtractJob: topic extraction failed (non-fatal)', {
        jobId: job.id,
        moduleItemId: job.module_item_id,
        error: topicErr instanceof Error ? topicErr.message : String(topicErr),
      })
    }
  }

  // Background workers have no user context, so we deliberately don't
  // hit the events table (which expects a non-null user_id). Observability
  // for the queue itself lives on extraction_jobs — attempts, error,
  // completed_at — and on module_items.content.extraction for subsystem
  // outcomes. The admin viewer (PR 5b) consumes both.
  logger.info('worker.runExtractJob: completed', {
    jobId: job.id,
    moduleItemId: job.module_item_id,
    sectionId,
    status: result.status,
    pageCount: result.metadata.pageCount,
    wordCount: result.metadata.wordCount,
    imageCount: result.images?.length ?? 0,
    formulaCount: result.formulas?.length ?? 0,
    formulasStatus: result.formulasStatus,
    topicCount,
  })

  if (result.status === 'completed') return { finalStatus: 'completed', error: null }
  if (result.status === 'partial') return { finalStatus: 'partial', error: result.error }
  return { finalStatus: 'failed', error: result.error }
}

// module_items.content.concepts is worker-written but still external JSON —
// parse, never cast (same rule buildQuizGenerationContext applies when reading).
const storedConceptListSchema = z.array(storedQuizConceptSchema)

/**
 * Backfill stored quiz concepts for ONE legacy item (design §11a): the concept
 * pass ONLY, over the item's already-stored extraction — no file download, no
 * re-parse, no vision, so it costs one cheap LLM call instead of re-billing the
 * whole pipeline. Writes content.concepts (+ the doc summary when the item has
 * none). Topics, skill seeding, and embeddings are deliberately untouched:
 * quiz generation needs the concepts, and re-seeding the rest would churn
 * professor-curated state for no benefit.
 */
async function runBackfillConceptsJob(
  admin: SupabaseClient,
  job: ExtractionJobRow,
): Promise<{ finalStatus: 'completed' | 'failed'; error: string | null }> {
  if (!job.module_item_id) {
    return { finalStatus: 'failed', error: 'backfill-concepts job has no module_item_id' }
  }
  const item = await fetchModuleItem(admin, job.module_item_id)
  if (!item) return { finalStatus: 'failed', error: 'module item not found' }

  const content = (item.content ?? {}) as {
    extraction?: ExtractionV2Result & { jobId?: string }
    concepts?: unknown
    summary?: unknown
  }
  const extraction = content.extraction
  if (
    !extraction ||
    (extraction.status !== 'completed' && extraction.status !== 'partial') ||
    !extraction.pages?.length
  ) {
    return { finalStatus: 'failed', error: 'no completed extraction to derive concepts from' }
  }

  // Idempotent: a usable stored list already exists → success no-op, so
  // re-running the enqueue script (or a duplicate job) never re-bills.
  const existing = storedConceptListSchema.safeParse(content.concepts)
  if (existing.success && existing.data.length >= CONCEPT_MIN_CONCEPTS) {
    return { finalStatus: 'completed', error: null }
  }

  const sectionCtx = await resolveSectionContext(admin, item.module_id)
  if (!sectionCtx) {
    return { finalStatus: 'failed', error: 'could not resolve section/institution from module_id' }
  }

  // Institution/platform AI kill switch — concept extraction is an LLM call.
  const aiVerdict = await checkAiFeature(admin, sectionCtx.institutionId, 'quiz-ai')
  if (!aiVerdict.allowed) {
    return { finalStatus: 'failed', error: 'Skipped: AI features are disabled for this institution.' }
  }

  const pass = await extractStorableConcepts(item.title || 'Untitled', extraction, sectionCtx.sectionId)
  if (!pass) {
    return { finalStatus: 'failed', error: 'concept extraction failed or found too few concepts' }
  }

  // Re-fetch before writing so we don't stomp fields edited meanwhile — and
  // guard against a SUPERSEDE race: if a full re-extraction landed while our
  // LLM call ran (professor replaced the file), its extraction.jobId changed
  // and our concepts describe the OLD document. Bail rather than write them.
  const fresh = await fetchModuleItem(admin, job.module_item_id)
  if (!fresh) return { finalStatus: 'failed', error: 'module item disappeared during backfill' }
  const freshContent = { ...((fresh.content ?? {}) as Record<string, unknown>) }
  const freshJobId = (freshContent.extraction as { jobId?: string } | undefined)?.jobId
  if (freshJobId !== extraction.jobId) {
    return { finalStatus: 'failed', error: 'superseded by a newer extraction — not writing stale concepts' }
  }

  await (admin as SupabaseClient)
    .from('module_items')
    .update({
      content: {
        ...freshContent,
        concepts: pass.concepts,
        ...(typeof content.summary === 'string' && content.summary ? {} : pass.summary ? { summary: pass.summary } : {}),
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.module_item_id)

  logger.info('worker.runBackfillConceptsJob: stored concepts', {
    jobId: job.id,
    moduleItemId: job.module_item_id,
    conceptCount: pass.concepts.length,
  })
  return { finalStatus: 'completed', error: null }
}

async function runCleanupJob(
  admin: SupabaseClient,
  job: ExtractionJobRow,
): Promise<{ finalStatus: 'completed' | 'failed'; error: string | null }> {
  // cleanup-storage jobs carry the deleted item's info in payload.
  const payload = job.payload as {
    moduleItemId?: string
    content?: { extraction?: { images?: Array<{ storagePath: string }> } }
  }
  const images = payload?.content?.extraction?.images ?? []
  if (!payload.moduleItemId) {
    return { finalStatus: 'failed', error: 'cleanup job missing payload.moduleItemId' }
  }
  /* No vector purge here any more. The pgvector table this used to clean is
     gone, and its replacement needs no equivalent: `material_vector_chunks`
     cascades with the module_items row, and the Pinecone side is reconciled by
     the embed_material job that the same delete enqueues (an item that no
     longer exists converges to "remove its vectors"). */
  const paths = images.map((i) => i.storagePath).filter(Boolean)
  if (paths.length === 0) {
    // Nothing to clean — trigger fired on a lecture that never had
    // extracted images in the first place.
    return { finalStatus: 'completed', error: null }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any).storage
    .from(COURSE_MATERIALS_BUCKET)
    .remove(paths)
  if (error) {
    logger.warn('worker.runCleanupJob: storage.remove failed', {
      moduleItemId: payload.moduleItemId,
      count: paths.length,
      error: error.message,
    })
    return { finalStatus: 'failed', error: error.message }
  }
  return { finalStatus: 'completed', error: null }
}

/** Recompute one section's Topic Mastery (event-triggered by graded activity /
 *  topic config changes; also drained by the 5-min sweep + nightly coverage). */
async function runRecomputeJob(
  admin: SupabaseClient,
  job: ExtractionJobRow,
): Promise<{ finalStatus: 'completed' | 'failed'; error: string | null }> {
  const sectionId = (job.payload as { sectionId?: string })?.sectionId
  if (!sectionId) {
    return { finalStatus: 'failed', error: 'recompute job missing payload.sectionId' }
  }
  await recomputeSectionMastery(admin, sectionId)
  return { finalStatus: 'completed', error: null }
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Claim and run a single job. The HTTP route wraps this in a drain
 * loop while time remains; tests call it once and inspect the result.
 */
export async function runOneJob(opts: WorkerOptions = {}): Promise<RunWorkerResult> {
  const admin = getAdmin(opts)
  const workerId = opts.workerId ?? randomUUID()
  const ttl = opts.claimTtlSeconds ?? 900

  const job = await claimNext(admin, workerId, ttl)
  if (!job) {
    return { claimed: false }
  }

  try {
    let outcome: { finalStatus: 'completed' | 'failed' | 'partial'; error: string | null }

    if (job.kind === 'cleanup-storage') {
      outcome = await runCleanupJob(admin, job)
    } else if (job.kind === 'recompute-mastery') {
      outcome = await runRecomputeJob(admin, job)
    } else if (job.kind === 'backfill-concepts') {
      outcome = await runBackfillConceptsJob(admin, job)
    } else {
      // 'extract' and 'backfill-extraction' share the same runner —
      // the only difference is who enqueued them (professor vs admin).
      outcome = await runExtractJob(admin, job)
    }


    await writeJobCompletion(admin, job.id, outcome.finalStatus, outcome.error)

    return {
      claimed: true,
      jobId: job.id,
      kind: job.kind,
      finalStatus: outcome.finalStatus,
      error: outcome.error ?? undefined,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown worker error'
    logger.error('worker.runOneJob: unexpected error', err, { jobId: job.id, kind: job.kind })
    await writeJobCompletion(admin, job.id, 'failed', message)
    return { claimed: true, jobId: job.id, kind: job.kind, finalStatus: 'failed', error: message }
  }
}

/**
 * Drain the queue until empty or until `deadline` is reached (unix ms).
 * Useful for the /kick route: we keep draining as long as we have time
 * rather than returning after the first job. Caller provides a deadline
 * that leaves a cushion before the route's maxDuration cutoff.
 */
export async function runUntilDrained(
  deadline: number,
  opts: WorkerOptions = {},
): Promise<{ jobsRun: number; lastResult: RunWorkerResult | null }> {
  let jobsRun = 0
  let lastResult: RunWorkerResult | null = null
  while (Date.now() < deadline) {
    const result = await runOneJob(opts)
    if (!result.claimed) return { jobsRun, lastResult }
    jobsRun += 1
    lastResult = result
  }
  return { jobsRun, lastResult }
}
