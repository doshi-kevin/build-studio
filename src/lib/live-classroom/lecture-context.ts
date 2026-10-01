// Assembles the "lecture so far" AI context — per-slide deck text +
// per-slide spoken transcription, truncated to fit the model budget.
// Shared by live quiz generation (professor) and the "Catch me up"
// lecture summary (student).

import { LIVE_QUIZ_MAX_CONTEXT_CHARS } from '@/lib/ai/config'
import type { ExtractionPageData } from '@/lib/validations/document-extraction'

export interface LectureContext {
  slideContent: string
  transcriptionContent: string
  slidesCovered: number
}

export function buildLectureContext(
  deckExtraction: { pages?: ExtractionPageData[] } | null,
  txRows: Array<{ page_number: number; text: string }>,
): LectureContext {
  const pages = deckExtraction?.pages ?? []
  const slidesCovered = txRows.length

  // For each covered page, include slide text + transcription
  let slideContent = ''
  let transcriptionContent = ''

  for (const tx of txRows) {
    const page = pages.find((p) => p.pageNumber === tx.page_number + 1) // pages are 1-indexed
    if (page) {
      slideContent += `\n\n--- Slide ${tx.page_number + 1} ---\n${page.text}`
    }
    transcriptionContent += `\n\n--- Slide ${tx.page_number + 1} (spoken) ---\n${tx.text}`
  }

  // Truncate to stay within limits
  const halfLimit = Math.floor(LIVE_QUIZ_MAX_CONTEXT_CHARS / 2)
  if (slideContent.length > halfLimit) {
    slideContent = slideContent.slice(0, halfLimit) + '\n[...truncated]'
  }
  if (transcriptionContent.length > halfLimit) {
    transcriptionContent = transcriptionContent.slice(0, halfLimit) + '\n[...truncated]'
  }

  return { slideContent, transcriptionContent, slidesCovered }
}
