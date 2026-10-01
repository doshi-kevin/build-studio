/**
 * Ingest a student submission: download and parse all supported file types,
 * returning combined text + any parsed notebooks for segmentation.
 *
 * v1 supported formats: .ipynb, .txt, .pdf
 * Skipped: images, zip, doc/docx, and anything > 25 MB.
 */
import 'server-only'

import { logger } from '@/lib/logger'
import { parseNotebook, type ParsedNotebook } from '@/lib/assignments/notebook'
import { parseDocument, getTextForLLM } from '@/lib/document-parser/index'
import { ASSIGNMENT_SUBMISSIONS_BUCKET } from '@/lib/supabase/storage'
import type { createAdminClient } from '@/lib/supabase/admin'
import type { SubmissionFile } from '@/lib/validations/assignment'

type AdminClient = ReturnType<typeof createAdminClient>

const MAX_FILE_BYTES = 25 * 1024 * 1024 // 25 MB

/** Max chars to include per notebook cell output (capped to avoid bloating whole-text). */
const MAX_CELL_OUTPUT_CHARS = 2000

/** Per-submission processing bounds — cap the total work one submission can force downstream
 *  (embedding, LLM tokens). Notebook cells are already capped at parse time (NOTEBOOK_LIMITS.maxCells),
 *  so these bound the remaining unbounded surfaces: PDF pages and total accumulated text. Once the
 *  text budget is reached, further files are skipped. */
const MAX_PDF_PAGES = 100
const MAX_TOTAL_TEXT_CHARS = 400_000

/** Extensions handled in v1 (lower-case, no dot). */
const SUPPORTED_EXTENSIONS = new Set(['ipynb', 'txt', 'pdf'])

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

async function downloadFile(adminDb: AdminClient, path: string): Promise<Buffer | null> {
  const { data, error } = await adminDb.storage.from(ASSIGNMENT_SUBMISSIONS_BUCKET).download(path)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}

/**
 * Flatten a parsed Jupyter notebook into a plain text string for whole-text
 * mode and keyword checks. Each cell contributes its source plus capped outputs.
 * Exported so signals.ts and grader.ts share one rendering path.
 */
export function flattenNotebookText(nb: ParsedNotebook): string {
  const parts: string[] = []
  for (const cell of nb.cells) {
    const cellParts: string[] = [cell.source]
    for (const out of cell.outputs) {
      if (out.type === 'text') {
        cellParts.push(out.content.slice(0, MAX_CELL_OUTPUT_CHARS))
      } else if (out.type === 'error') {
        cellParts.push(`${out.errorType}: ${out.errorValue}`.slice(0, MAX_CELL_OUTPUT_CHARS))
      }
      // type === 'image' → skip
    }
    const joined = cellParts.filter(Boolean).join('\n').trim()
    if (joined) parts.push(joined)
  }
  return parts.join('\n\n')
}

export async function ingestSubmission(
  adminDb: AdminClient,
  submission: {
    id: string
    text_content: string | null
    files: SubmissionFile[]
  },
): Promise<{ text: string | null; notebooks: ParsedNotebook[] }> {
  const textParts: string[] = []
  const notebooks: ParsedNotebook[] = []

  // Running total of accumulated text — once it reaches MAX_TOTAL_TEXT_CHARS, further text is
  // dropped so one submission with many large files can't force unbounded embedding / LLM work.
  let totalTextChars = 0
  /** Append text within the per-submission budget; returns false once the budget is exhausted. */
  function pushText(s: string): boolean {
    if (totalTextChars >= MAX_TOTAL_TEXT_CHARS) return false
    const remaining = MAX_TOTAL_TEXT_CHARS - totalTextChars
    const clipped = s.length > remaining ? s.slice(0, remaining) : s
    textParts.push(clipped)
    totalTextChars += clipped.length
    return true
  }

  // 1. Inline text content from the submission row.
  if (submission.text_content?.trim()) {
    pushText(submission.text_content.trim())
  }

  // 2. Process attached files.
  for (const file of submission.files) {
    if (totalTextChars >= MAX_TOTAL_TEXT_CHARS) break // text budget exhausted — stop reading files
    const ext = extOf(file.name)
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue // skip images, zip, doc, etc.
    if (file.size > MAX_FILE_BYTES) {
      logger.warn('ingestSubmission: file exceeds 25 MB, skipping', {
        source: 'ingest.ingestSubmission',
        submissionId: submission.id,
        fileName: file.name,
        size: file.size,
      })
      continue
    }

    const buffer = await downloadFile(adminDb, file.path)
    if (!buffer) {
      logger.warn('ingestSubmission: could not download file', {
        source: 'ingest.ingestSubmission',
        submissionId: submission.id,
        path: file.path,
      })
      continue
    }

    if (ext === 'ipynb') {
      const nb = parseNotebook(buffer.toString('utf-8'))
      if (!nb) {
        logger.warn('ingestSubmission: malformed .ipynb, skipping', {
          source: 'ingest.ingestSubmission',
          submissionId: submission.id,
          fileName: file.name,
        })
        continue
      }
      // Notebooks stay structured only. chunkSubmission passes them through
      // chunkNotebook; flattening into `text` too would chunk the same content
      // twice and embed it as duplicate passages.
      notebooks.push(nb)
    } else if (ext === 'txt') {
      const content = buffer.toString('utf-8').trim()
      if (content) pushText(content)
    } else if (ext === 'pdf') {
      try {
        const result = await parseDocument(buffer)
        if (result.status === 'completed' && result.pages.length > 0) {
          // Cap pages so a huge PDF can't force unbounded downstream work.
          const pages = result.pages.slice(0, MAX_PDF_PAGES)
          const pdfText = getTextForLLM(pages, result.metadata)
          if (pdfText.trim()) pushText(pdfText.trim())
        }
      } catch (err) {
        logger.warn('ingestSubmission: PDF parse failed, skipping', {
          source: 'ingest.ingestSubmission',
          submissionId: submission.id,
          fileName: file.name,
          err: String(err),
        })
      }
    }
  }

  const combinedText = textParts.length > 0 ? textParts.join('\n\n') : null
  return { text: combinedText, notebooks }
}
