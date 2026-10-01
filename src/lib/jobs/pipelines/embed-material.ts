// embed_material — background pipeline that RECONCILES one module material's
// vectors with its current state (design: docs/designs/
// module-embedding-pinecone-system-design.md).
//
// Convergent by design: create, re-upload, AND delete all enqueue this same
// job. The run looks at the material's current state and makes Pinecone +
// material_vector_chunks match it — item missing or no longer a PDF ⇒ vectors
// removed; pages unchanged since last run (content_hash) ⇒ skipped without an
// embedding call. That also makes retries cheap: a re-claimed job resumes at
// the first un-indexed page.
//
// Tenant scope (institution_id / section_id) comes from the JOB ROW — written
// by the enqueueing server action from a verified section — never from params.

import 'server-only'

import { createHash } from 'crypto'
import path from 'path'
import { z } from 'zod'

import { logger } from '@/lib/logger'
import { recordAiUsage } from '@/lib/ai/usage'
import { renderPdfPages } from '@/lib/document-parser/page-renderer'
import { isRenderableSource, loadRenderablePdf } from '@/lib/document-parser/asset-crop'
import { stripNul } from '@/lib/extraction/sanitize'
import { isSafeStoragePath } from '@/lib/supabase/storage'
import {
  CHUNKER_VERSION,
  CONTENT_CLASS_COURSE_MATERIAL,
  EMBEDDING_DIM,
  EMBEDDING_IMAGE_TOKENS,
  EMBEDDING_MODEL,
  METADATA_SCHEMA_VERSION,
} from '@/lib/pinecone/config'
import {
  deleteMaterialVectors,
  upsertMaterialPageVectors,
  type MaterialPageVector,
  type TenantScope,
} from '@/lib/pinecone/data'
import { embedMaterialPage, embedMaterialText } from '@/lib/pinecone/embed'
import { buildPageVectorId } from '@/lib/pinecone/ids'
import { storeTopicPageAnchors } from '@/lib/pinecone/topic-pages'
import { isSpreadsheetSource, summarizeSheet, type SheetTable } from '@/lib/pinecone/sheet-summary'
import type { BackgroundPipeline, PipelineContext, PipelineResult } from '../types'

export const EMBED_MATERIAL_JOB_TYPE = 'embed_material'

// Lenient uuid shape — zod's strict .uuid() rejects hand-crafted ids that
// exist in prod (see metadata.ts); Postgres itself is the referential check.
const paramsSchema = z.object({
  moduleItemId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
})

/** Render + embed in small batches to bound memory on large PDFs. */
const PAGE_BATCH = 5
/** Hard cap — bounds a pathological upload; pages beyond it are not embedded. */
const MAX_PAGES = 300

const PDF_WORKER_SRC = path.join(
  process.cwd(),
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
)

/**
 * Light per-page text extraction. extractPdf() in document-parser does much
 * more (image extraction to Storage, table detection) with side effects we
 * don't want here — the embedding input only needs the page's text.
 */
async function extractPageTexts(buffer: Buffer): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise
  try {
    const texts: string[] = []
    const pageCount = Math.min(doc.numPages, MAX_PAGES)
    for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
      const page = await doc.getPage(pageNo)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str === 'string') text += item.str
        if (item.hasEOL) text += '\n'
        else if (item.str && !item.str.endsWith(' ')) text += ' '
      }
      /* stripNul, not cosmetics: a PDF's text layer can carry U+0000, Postgres
         rejects it in text and jsonb, and the failure lands on the batch UPSERT
         — so ONE bad page took down the whole material's indexing with
         "unsupported Unicode escape sequence" and the job retried into a hard
         fail. The extraction worker has always sanitized on the same grounds. */
      texts.push(stripNul(text.replace(/[ \t]+/g, ' ').trim()))
      page.cleanup()
    }
    return texts
  } finally {
    await doc.destroy()
  }
}

/**
 * A spreadsheet has no page image, but `pageContentHash` and the vector shape
 * are shared with the PDF path. Hashing a zero-length buffer keeps one code
 * path for both and still changes the hash whenever the sampled text does.
 */
const EMPTY_PAGE_IMAGE = Buffer.alloc(0)

/**
 * One text block per worksheet, from the extraction the parser already stored.
 *
 * Returns [] when a workbook has not been extracted yet — the job reports zero
 * pages rather than inventing content. The extraction worker re-enqueues this
 * job when it finishes, so the sheets get indexed on that pass.
 */
function sheetSummaries(content: Record<string, unknown> | null): string[] {
  const extraction = (content?.extraction ?? {}) as { tables?: unknown }
  const tables = Array.isArray(extraction.tables) ? (extraction.tables as SheetTable[]) : []
  return tables
    .filter((t) => typeof t?.html === 'string')
    .map((t) => summarizeSheet(t))
    .filter((text) => text.length > 0)
}

/**
 * The page text a completed extraction already stored, for materials with no
 * renderable source of their own (plain text, converted legacy Office).
 */
function extractionPageTexts(content: Record<string, unknown> | null): string[] {
  const extraction = (content?.extraction ?? {}) as { status?: unknown; pages?: unknown }
  if (extraction.status !== 'completed' || !Array.isArray(extraction.pages)) return []
  return (extraction.pages as Array<{ text?: unknown }>)
    .map((p) => (typeof p?.text === 'string' ? p.text.trim() : ''))
    .filter((t) => t.length > 0)
}

/** First non-empty line of the page, truncated — the "page heading" breadcrumb tail. */
function pageHeading(pageText: string): string {
  const line = pageText.split('\n').find((l) => l.trim().length > 0)
  return (line ?? '').trim().slice(0, 80)
}

function pageContentHash(input: { breadcrumb: string; pageText: string; imagePng: Buffer }): string {
  return createHash('sha256')
    .update(`${EMBEDDING_MODEL}|${CHUNKER_VERSION}|${input.breadcrumb}|${input.pageText}|`)
    .update(input.imagePng)
    .digest('hex')
}

async function removeAllVectors(
  ctx: PipelineContext,
  scope: TenantScope,
  moduleItemId: string,
  reason: string,
): Promise<PipelineResult> {
  const deleted = await deleteMaterialVectors(scope, moduleItemId)
  // Chunk rows normally cascade with the module_items row; this covers the
  // "still exists but no longer a PDF" path.
  await ctx.adminDb.from('material_vector_chunks').delete().eq('module_item_id', moduleItemId)
  return {
    result: { deleted },
    summary: `${reason} — removed ${deleted} vector(s)`,
  }
}

export const embedMaterialPipeline: BackgroundPipeline = {
  type: EMBED_MATERIAL_JOB_TYPE,

  async run(rawParams, ctx): Promise<PipelineResult> {
    const params = paramsSchema.parse(rawParams)
    const { moduleItemId } = params
    const institutionId = ctx.job.institution_id
    const sectionId = ctx.job.section_id
    if (!sectionId) throw new Error('embed_material: job has no section_id')
    const scope: TenantScope = { institutionId, sectionId }

    // ── Current state of the material ───────────────────────────
    const { data: item } = await ctx.adminDb
      .from('module_items')
      .select('id, title, module_id, content, modules!inner(id, title, section_id)')
      .eq('id', moduleItemId)
      .maybeSingle()

    if (!item) return removeAllVectors(ctx, scope, moduleItemId, 'material deleted')

    const mod = Array.isArray(item.modules) ? item.modules[0] : item.modules
    // The job's tenant columns were derived server-side at enqueue time; if the
    // item has since moved (or params were forged), refuse rather than write
    // into the wrong namespace.
    if (!mod || mod.section_id !== sectionId) {
      throw new Error('embed_material: module item does not belong to the job section')
    }

    const content = (item.content ?? {}) as { filePath?: string; fileType?: string }
    /* Renderable, not "is a .pdf". A lecture is as often a PPTX as a PDF, and
       while this pipeline only ever embeds PDF PAGES, the app already knows how
       to make a PDF out of a deck — `loadRenderablePdf` converts once via
       LibreOffice and caches the result beside the original, which is the same
       derived file the material viewer's page renderer serves from. Gating on
       the extension instead left every deck out of the index entirely: no
       reference rail for it, and Athena silently falling back to the
       full-course dump on any section whose lectures are slides. */
    const filePath = typeof content.filePath === 'string' ? content.filePath : ''
    const spreadsheet = !!filePath && isSpreadsheetSource(filePath)
    /* Anything extraction could already read, embedding can index — as TEXT,
       with no page image. That covers plain-text notes and the legacy binary
       Office files the extractor now converts before parsing: those have real
       page text but no renderable source of their own, and before this they
       were dropped here with their vectors removed and the job reporting
       success. The rule is "is there text", not "is there a file type we like". */
    const extractedPages = extractionPageTexts(item.content as Record<string, unknown> | null)
    const textOnly = !spreadsheet && !isRenderableSource(filePath) && extractedPages.length > 0
    if (!filePath || (!isRenderableSource(filePath) && !spreadsheet && !textOnly)) {
      return removeAllVectors(ctx, scope, moduleItemId, 'material has nothing to index')
    }

    /* The path must live under the section we just authorized, and this is not
       belt-and-braces: `content.filePath` is professor-writable (the update
       schema takes any string), and for a deck `loadRenderablePdf` now WRITES —
       it caches the converted PDF beside the original with the admin client. So
       an item pointing at another section's key would both read that tenant's
       bytes into this namespace and drop a derived file into their prefix. The
       extraction page route already guards this exact helper the same way; the
       invariant belongs at every call site that hands it a stored path. */
    if (!isSafeStoragePath(filePath, `${sectionId}/`)) {
      logger.error('embed_material: material file path outside its section — refusing', undefined, {
        source: 'embedMaterialPipeline.run',
        moduleItemId,
        sectionId,
      })
      return removeAllVectors(ctx, scope, moduleItemId, 'material file path is outside its section')
    }

    // ── Load the source (converting a deck if needed) + breadcrumb context ──
    /* A spreadsheet takes no PDF at all: its pages are worksheets, sampled as
       text from the stored extraction rather than rendered. Skipping the load
       here is the point of the whole branch — converting a 50k-row workbook is
       minutes of LibreOffice and hundreds of page images of number grids. */
    const [renderable, { data: section }, { data: existingRows }] = await Promise.all([
      spreadsheet || textOnly
        ? Promise.resolve<Buffer | 'unsupported' | null>(Buffer.alloc(0))
        : loadRenderablePdf(ctx.adminDb, filePath),
      ctx.adminDb
        .from('course_sections')
        .select('course_id, courses(code, title)')
        .eq('id', sectionId)
        .single(),
      ctx.adminDb
        .from('material_vector_chunks')
        .select('page_number, content_hash, status')
        .eq('module_item_id', moduleItemId),
    ])
    /* Both non-buffer outcomes are FAULTS here, and neither may drop vectors.
       The extension was already accepted by isRenderableSource above, so
       loadRenderablePdf's extension-based 'unsupported' is unreachable from
       this caller — the only way to get it is convertOfficeToPdf returning
       null, which it does for a missing soffice binary, a 45s timeout, a
       non-zero exit or no output. Those are transient, and treating them as
       "this material has no pages" would delete an indexed deck's vectors and
       report success, so nothing would ever retry: the same silent drop this
       gate was widened to fix, one layer down. Throwing instead retries, and a
       genuinely unconvertible file ends as a visible failed job with its
       vectors untouched. Same for null (source file missing). */
    if (renderable === 'unsupported') {
      throw new Error(`embed_material: could not render ${filePath} to pages`)
    }
    if (!renderable) {
      throw new Error(`embed_material: storage download failed for ${filePath}`)
    }
    const buffer = renderable

    const course = Array.isArray(section?.courses) ? section?.courses[0] : section?.courses
    const courseLabel = course ? `${course.code} ${course.title}`.trim() : 'Course'
    const crumbBase = [courseLabel, mod.title, item.title].filter(Boolean).join(' › ')

    const previous = new Map(
      (existingRows ?? []).map((r) => [r.page_number as number, r as { content_hash: string; status: string }]),
    )

    /* Page text, from whichever source this material has. A spreadsheet's
       "pages" are its worksheets, and each one contributes its headers plus a
       few example rows — the part that carries meaning — instead of a picture
       of the grid. See sheet-summary.ts for why five rows. */
    const pageTexts = spreadsheet
      ? sheetSummaries(item.content as Record<string, unknown> | null)
      : textOnly
        ? extractedPages
        : await extractPageTexts(buffer)
    const pageCount = pageTexts.length

    // ── Embed page by page (batched), skipping unchanged pages ──
    let embedded = 0
    let skipped = 0
    let failed = 0
    let billedTokens = 0
    let tokensEstimated = false

    for (let start = 1; start <= pageCount; start += PAGE_BATCH) {
      if (ctx.signal.aborted) throw new Error('embed_material: aborted')
      const pageNumbers = Array.from(
        { length: Math.min(PAGE_BATCH, pageCount - start + 1) },
        (_, i) => start + i,
      )
      const batchLabel = `pages ${pageNumbers[0]}–${pageNumbers[pageNumbers.length - 1]}`
      await ctx.reportProgress({ label: batchLabel, status: 'running', startedAt: new Date().toISOString() })

      const rendered = spreadsheet || textOnly
        ? pageNumbers.map((pageNumber) => ({ pageNumber, buffer: EMPTY_PAGE_IMAGE }))
        : await renderPdfPages(buffer, pageNumbers, 2, 'png')
      const vectors: MaterialPageVector[] = []
      const rows: Record<string, unknown>[] = []

      for (const page of rendered) {
        const pageText = pageTexts[page.pageNumber - 1] ?? ''
        const heading = pageHeading(pageText)
        const breadcrumb = `${crumbBase} › p.${page.pageNumber}${heading ? ` — ${heading}` : ''}`
        const contentHash = pageContentHash({ breadcrumb, pageText, imagePng: page.buffer })

        const prev = previous.get(page.pageNumber)
        if (prev && prev.content_hash === contentHash && prev.status === 'indexed') {
          skipped++
          continue
        }

        const baseRow = {
          institution_id: institutionId,
          section_id: sectionId,
          module_id: item.module_id,
          module_item_id: moduleItemId,
          page_number: page.pageNumber,
          breadcrumb,
          content: pageText,
          content_hash: contentHash,
          embedding_model: EMBEDDING_MODEL,
          embedding_dim: EMBEDDING_DIM,
          chunker_version: CHUNKER_VERSION,
          updated_at: new Date().toISOString(),
        }

        try {
          const { values, tokens, estimated } = spreadsheet || textOnly
            ? await embedMaterialText({ breadcrumb, text: pageText })
            : await embedMaterialPage({ breadcrumb, pageText, imagePng: page.buffer })
          billedTokens += tokens
          tokensEstimated ||= estimated
          vectors.push({
            id: buildPageVectorId(moduleItemId, page.pageNumber),
            values,
            metadata: {
              institution_id: institutionId,
              section_id: sectionId,
              module_id: item.module_id,
              module_item_id: moduleItemId,
              page_number: page.pageNumber,
              content_class: CONTENT_CLASS_COURSE_MATERIAL,
              schema_version: METADATA_SCHEMA_VERSION,
              embedding_model: EMBEDDING_MODEL,
              chunker_version: CHUNKER_VERSION,
            },
          })
          rows.push({ ...baseRow, status: 'indexed', error: null })
          embedded++
        } catch (error) {
          failed++
          rows.push({
            ...baseRow,
            status: 'failed',
            error: error instanceof Error ? error.message.slice(0, 500) : 'embedding failed',
          })
          logger.warn('embed_material: page failed', {
            source: 'embedMaterialPipeline.run',
            moduleItemId,
            page: page.pageNumber,
          })
        }
      }

      // Vector store first, then sync state — a crash between the two leaves
      // rows 'pending'/stale-hash, so the retry re-embeds (idempotent ids).
      if (vectors.length > 0) await upsertMaterialPageVectors(scope, vectors)
      if (rows.length > 0) {
        const { error: upsertError } = await ctx.adminDb
          .from('material_vector_chunks')
          .upsert(rows, { onConflict: 'module_item_id,page_number' })
        if (upsertError) throw new Error(`embed_material: chunk upsert failed: ${upsertError.message}`)
      }
      await ctx.reportProgress({ label: batchLabel, status: 'done', startedAt: new Date().toISOString() })
    }

    // ── Stale tail: a shorter re-upload leaves old trailing pages behind ──
    await deleteMaterialVectors(scope, moduleItemId, { beyondPage: pageCount })
    await ctx.adminDb
      .from('material_vector_chunks')
      .delete()
      .eq('module_item_id', moduleItemId)
      .gt('page_number', pageCount)

    // One ledger row per run (not per page), with the run's real billable
    // tokens from usageMetadata. Each page is text + one image; images bill at
    // their own rate, so split the total into shares (image share is Gemini's
    // fixed per-image count; the remainder is text).
    if (embedded > 0) {
      const imageTokens = Math.min(embedded * EMBEDDING_IMAGE_TOKENS, billedTokens)
      await recordAiUsage({
        feature: 'material_embedding',
        model: EMBEDDING_MODEL,
        institutionId,
        sectionId,
        userId: ctx.job.created_by,
        usage: { inputTokens: billedTokens - imageTokens, imageTokens },
        metadata: {
          moduleItemId,
          pagesEmbedded: embedded,
          ...(tokensEstimated ? { estimated_tokens: true } : {}),
        },
      })
    }

    /* Re-anchor the reference rail against the pages that now exist.
     *
     * The extraction job also does this, and it has to: these two jobs are
     * enqueued independently at upload and neither can wait for the other, so
     * each has half of what the rail needs — extraction writes the TOPICS,
     * this job writes the PAGES. Whichever finishes last is the one that can
     * actually compute the map, so both attempt it and the work is idempotent.
     *
     * Doing it only in extraction left two silent failures: a first upload
     * where extraction wins the race gets no anchors and nothing ever
     * recomputes them, and a REPLACED file gets anchors matched against the
     * previous upload's still-live vectors — a rail that points confidently at
     * the wrong pages, which the worker's own comment calls worse than none.
     */
    const anchoredTopics = (item.content as { topics?: unknown } | null)?.topics
    if (Array.isArray(anchoredTopics) && anchoredTopics.length > 0 && pageCount > 0) {
      await storeTopicPageAnchors(ctx.adminDb, {
        institutionId,
        sectionId,
        moduleItemId,
        topics: anchoredTopics.filter((t): t is string => typeof t === 'string'),
        // This job just indexed the pages, so an empty result here is not "not
        // ready yet" — it means topic matching is broken. Say so loudly; a
        // silently dead embedding path is exactly how #435 went unnoticed.
        expectIndexed: true,
      })
    }

    const summary =
      `Embedded ${embedded}/${pageCount} page(s)` +
      (skipped ? `, ${skipped} unchanged` : '') +
      (failed ? `, ${failed} FAILED` : '')
    return { result: { pageCount, embedded, skipped, failed }, summary }
  },
}
