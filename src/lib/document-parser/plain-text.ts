// Plain-text extraction — the smallest extractor, and the one that was missing.
//
// `.txt` is an accepted lecture upload but routed to fileType 'notes', which no
// extractor handled, so the file was stored and then ignored completely: no
// text, no topics, no reference rail, and nothing in the retrieval index. A
// professor's notes file simply did not exist to the rest of the app.
//
// There are no pages in a text file, so we make them: the rest of the pipeline
// (citations, the rail, page-scoped retrieval) is built around a page number,
// and "page 3 of the notes" is a more useful citation than none. The split is
// on blank lines so a page break lands between paragraphs rather than
// mid-sentence.

import { stripNul } from '@/lib/extraction/sanitize'
import type { ExtractionResultData } from '@/lib/validations/document-extraction'

/**
 * Characters per synthesized page. Chosen to sit well under the embedder's
 * ~8,000-char input window so a page is never silently truncated on its way
 * into a vector, while staying big enough that a short notes file is one page.
 */
const CHARS_PER_PAGE = 4_000

/** Hard cap, mirroring the embedding pipeline's own 300-page bound. */
const MAX_PAGES = 300

/** First non-empty line of a page, used as its heading for the breadcrumb. */
function headingOf(text: string): string[] {
  const line = text.split('\n').find((l) => l.trim().length > 0)
  return line ? [line.trim().slice(0, 120)] : []
}

/**
 * Split on blank lines, then greedily pack paragraphs into pages. A paragraph
 * longer than a whole page is hard-split rather than dropped.
 */
function paginate(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const pages: string[] = []
  let current = ''

  for (const para of paragraphs) {
    if (para.length > CHARS_PER_PAGE) {
      if (current) { pages.push(current); current = '' }
      for (let i = 0; i < para.length; i += CHARS_PER_PAGE) {
        pages.push(para.slice(i, i + CHARS_PER_PAGE))
      }
      continue
    }
    if (current && current.length + para.length + 2 > CHARS_PER_PAGE) {
      pages.push(current)
      current = para
    } else {
      current = current ? `${current}\n\n${para}` : para
    }
  }
  if (current) pages.push(current)
  return pages.slice(0, MAX_PAGES)
}

/**
 * Bytes decoded, as opposed to bytes stored.
 *
 * An output cap is not an input cap. Capping pages bounds what we keep, but
 * every step before the cap — decode, newline rewrite, NUL strip, the split
 * into paragraphs and the arrays `paginate` builds from them — runs over the
 * WHOLE upload first. A 50 MB text file of short paragraphs is millions of
 * strings, each with its own object overhead, allocated before the slice that
 * would have saved us. The extraction worker shares its instance with request
 * serving, so that is an OOM taking other people's requests down with it, and
 * the job retries, so it would do it again.
 *
 * Two bytes per character over the page budget leaves generous headroom for
 * multi-byte text while keeping every intermediate bounded by MAX_PAGES.
 */
const MAX_DECODED_BYTES = MAX_PAGES * CHARS_PER_PAGE * 2

/** Read a plain-text upload into the standard extraction shape. */
export function extractPlainText(buffer: Buffer): ExtractionResultData {
  // Truncate BEFORE decoding, not after paginating.
  const bounded = buffer.length > MAX_DECODED_BYTES ? buffer.subarray(0, MAX_DECODED_BYTES) : buffer
  // stripNul for the same reason the PDF path does it: Postgres rejects U+0000
  // in text and jsonb, and this goes straight into a JSONB column.
  const text = stripNul(bounded.toString('utf8').replace(/\r\n/g, '\n')).trim()
  const pageTexts = paginate(text)

  if (pageTexts.length === 0) {
    return {
      status: 'completed',
      extractedAt: new Date().toISOString(),
      error: null,
      metadata: { pageCount: 0, wordCount: 0 },
      pages: [],
      textStatus: 'completed',
    } as ExtractionResultData
  }

  return {
    status: 'completed',
    extractedAt: new Date().toISOString(),
    error: null,
    metadata: {
      pageCount: pageTexts.length,
      // Counted over the pages we KEPT, not the whole file — a second full-text
      // pass would reintroduce exactly the cost the byte cap above removes.
      wordCount: pageTexts.reduce((n, p) => n + p.split(/\s+/).filter(Boolean).length, 0),
    },
    pages: pageTexts.map((pageText, i) => ({
      pageNumber: i + 1,
      text: pageText,
      headings: headingOf(pageText),
    })),
    textStatus: 'completed',
  } as ExtractionResultData
}
