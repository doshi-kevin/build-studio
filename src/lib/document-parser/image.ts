// Standalone-image extractor (Phase 5c). Unlike every other upload type, a raster
// image has NO native structure layer — there's nothing to parse for free. So
// Tier 0 here is a deliberate no-op stub: one empty page, statuses left 'pending'
// for the vision pass. The worker then runs ONE Gemini call on the image (see
// runVisionOnImage in vision.ts) and stamps the formulas/tables/figures it reads,
// all tagged source 'vision' — this type can never produce a 'native' citation.
//
// We validate the buffer decodes (so a corrupt upload fails fast and cheap rather
// than burning a VLM call) but store no image binary: the original already lives
// in Storage at content.filePath.

import sharp from 'sharp'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { ExtractionResultData } from '@/lib/validations/document-extraction'

export interface ExtractImageOptions {
  sectionId: string
  moduleItemId: string
  // Accepted for dispatcher signature parity; the image path doesn't write Storage.
  adminClient?: SupabaseClient
  storageBucket?: string
}

export type ExtractImageResult = ExtractionResultData

export async function extractImage(buffer: Buffer, opts: ExtractImageOptions): Promise<ExtractImageResult> {
  const startedAt = Date.now()

  // Confirm it's a decodable image before we hand it to the (paid) vision tier.
  try {
    const meta = await sharp(buffer).metadata()
    if (!meta.width || !meta.height) throw new Error('image has no dimensions')
  } catch (err) {
    logger.error('extractImage: not a decodable image', err, { moduleItemId: opts.moduleItemId })
    return {
      status: 'failed',
      extractedAt: new Date(startedAt).toISOString(),
      error: err instanceof Error ? err.message : 'Not a decodable image',
      metadata: { pageCount: 0, wordCount: 0 },
      pages: [],
      textStatus: 'failed',
      imagesStatus: 'failed',
      formulasStatus: 'failed',
      tablesStatus: 'failed',
    }
  }

  // Tier-0 stub: nothing native to extract. The worker's vision pass fills in
  // formulas/tables/figures and flips formulasStatus/tablesStatus to completed.
  return {
    status: 'completed',
    extractedAt: new Date(startedAt).toISOString(),
    error: null,
    metadata: { pageCount: 1, wordCount: 0, formulaCount: 0 },
    pages: [{ pageNumber: 1, text: '', headings: [] }],
    textStatus: 'skipped',
    imagesStatus: 'skipped',
    formulasStatus: 'pending',
    tablesStatus: 'pending',
  }
}
