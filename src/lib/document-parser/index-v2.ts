// v2 dispatcher — routes an uploaded lecture buffer to the right
// deterministic extractor based on fileType. Kept separate from the
// legacy `./index.ts` (which the chat/RAG pipeline still consumes)
// so we can roll the new pipeline in behind a feature flag without
// breaking existing callers. Once PR 5 lands and the flag flips on
// by default, `index.ts` becomes a thin re-export of this file.

import { extractPdf, type ExtractPdfOptions, type ExtractPdfResult } from './pdf'
import { extractPptx, type ExtractPptxOptions, type ExtractPptxResult } from './pptx'
import { extractDocx, type ExtractDocxOptions, type ExtractDocxResult } from './docx'
import { extractXlsx, type ExtractXlsxOptions, type ExtractXlsxResult } from './xlsx'
import { extractImage, type ExtractImageOptions, type ExtractImageResult } from './image'
import { convertOfficeToPdf } from './office-to-pdf'
import { extractPlainText } from './plain-text'
import { logger } from '@/lib/logger'
import type { ExtractionResultData } from '@/lib/validations/document-extraction'

export type ExtractionV2Result = ExtractionResultData

export interface ExtractDocumentOptions {
  sectionId: string
  moduleItemId: string
  /** The declared file type from module_items.content.fileType */
  fileType: string
  /** Same opts as the underlying extractors accept (adminClient override etc.) */
  overrides?: Partial<
    ExtractPdfOptions & ExtractPptxOptions & ExtractDocxOptions & ExtractXlsxOptions & ExtractImageOptions
  >
}

/**
 * Deterministic document extraction v2. Dispatches by fileType:
 *   - 'pdf' → extractPdf (pdfjs-dist + sharp)
 *   - 'ppt' → extractPptx (fflate unzip + OMML walker)
 *
 * The 'formulas' field will be populated for PPTX uploads that carry
 * OMML markup. PDFs return without a formulas array — PR 4's vision
 * path fills that in on a separate pass.
 */
/** Every OOXML file is a zip archive, and every zip starts with "PK\x03\x04". */
function isZipContainer(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b
}

/** A typed failure row, so a caller never receives undefined. */
function failed(error: string): ExtractionV2Result {
  return {
    status: 'failed',
    extractedAt: new Date().toISOString(),
    error,
    metadata: { pageCount: 0, wordCount: 0 },
  } as ExtractionV2Result
}

export async function extractDocument(
  buffer: Buffer,
  opts: ExtractDocumentOptions,
): Promise<ExtractionV2Result> {
  const base = {
    sectionId: opts.sectionId,
    moduleItemId: opts.moduleItemId,
    ...opts.overrides,
  }

  if (opts.fileType === 'pdf') {
    return await extractPdf(buffer, base as ExtractPdfOptions)
  }
  if (opts.fileType === 'ppt' || opts.fileType === 'pptx') {
    return await extractPptx(buffer, base as ExtractPptxOptions)
  }
  /* Legacy binary Office files reach here with the SAME fileType as their
     modern counterparts ('doc' and 'docx' both infer to 'docx'), and the
     extractors below are OOXML readers — they unzip. A .doc is not a zip, so it
     failed with "invalid zip data" and the material ended up with no text, no
     topics and no vectors at all. Sniff the container instead of trusting the
     declared type: every OOXML file is a zip and starts with "PK". */
  if (!isZipContainer(buffer) && (opts.fileType === 'doc' || opts.fileType === 'docx' ||
      opts.fileType === 'xls' || opts.fileType === 'xlsx')) {
    const legacyExt = opts.fileType.startsWith('x') ? 'xls' : 'doc'
    const pdf = await convertOfficeToPdf(buffer, legacyExt)
    if (!pdf) {
      logger.warn('extractDocument: legacy Office conversion failed', {
        source: 'documentParser.extractDocument',
        fileType: opts.fileType,
      })
      return failed(`Could not read this ${legacyExt.toUpperCase()} file`)
    }
    return await extractPdf(pdf, base as ExtractPdfOptions)
  }
  if (opts.fileType === 'doc' || opts.fileType === 'docx') {
    /* Reaching here means the file IS a zip, so it is a real .docx.
     *
     * It used to go straight to the pure-JS reader below, which has no
     * pagination and reports pageCount 1 — so every concept it extracts cites
     * page 1. That was self-consistent while nothing else could paginate a Word
     * file. It stopped being self-consistent when `OFFICE_EXTS` in asset-crop
     * gained 'docx': the material viewer and the vector index now convert the
     * SAME file and get REAL page numbers. One document, two different answers
     * to "what page is this concept on", and the reference rail shows both.
     *
     * Convert first so the two paths agree, and so a Word lecture's figures,
     * tables and formulas survive as page images the way a deck's do.
     *
     * Falls back to the pure-JS reader when the converter is unavailable rather
     * than failing the extraction: page-1 anchors are worse than real ones, but
     * far better than a material with no text, no topics and no vectors. That
     * is why this does not mirror the legacy .doc branch above, which has no
     * reader to fall back to and so must fail. */
    const converted = await convertOfficeToPdf(buffer, 'docx')
    if (converted) return await extractPdf(converted, base as ExtractPdfOptions)
    logger.warn('extractDocument: docx conversion unavailable, falling back to the text reader', {
      source: 'documentParser.extractDocument',
      moduleItemId: opts.moduleItemId,
    })
    return await extractDocx(buffer, base as ExtractDocxOptions)
  }
  if (opts.fileType === 'xls' || opts.fileType === 'xlsx') {
    return await extractXlsx(buffer, base as ExtractXlsxOptions)
  }
  /* Plain text has no structure to parse and never had an extractor, so a .txt
     upload produced nothing downstream — no topics, no rail, no retrieval. It
     is the easiest format in the list to read; there was no reason for it to be
     the least supported. */
  if (opts.fileType === 'notes' || opts.fileType === 'text') {
    return extractPlainText(buffer)
  }
  if (opts.fileType === 'image') {
    return await extractImage(buffer, base as ExtractImageOptions)
  }

  // Unsupported types never hit the queue (upload path filters them),
  // but return a typed failure row for completeness so any future
  // caller that mistakenly invokes us doesn't end up with undefined.
  return {
    status: 'failed',
    extractedAt: new Date().toISOString(),
    error: `Unsupported fileType: ${opts.fileType}`,
    metadata: { pageCount: 0, wordCount: 0 },
    pages: [],
    textStatus: 'failed',
    imagesStatus: 'failed',
  }
}

export type { ExtractPdfResult, ExtractPptxResult, ExtractDocxResult, ExtractXlsxResult, ExtractImageResult }
