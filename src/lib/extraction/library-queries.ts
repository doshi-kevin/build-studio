// Flatten every lecture's extracted images and formulas for a section
// into two arrays the quiz author UI can browse. Each entry carries
// the originating lecture so the professor sees useful context
// (which lecture, which page) rather than raw opaque assets.
//
// Defensive: `module_items.content.extraction` is jsonb and may be
// null, partially populated (v1 rows without `images[]`), or contain
// malformed entries (Gemini returns the occasional empty-latex
// formula). We Zod-parse each entry and drop anything that doesn't
// round-trip — one bad row should not crash the dialog.
//
// Service role only — the server-action wrapper handles ownership
// verification before calling this.

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  extractedImageSchema,
  extractedFormulaSchema,
  type ExtractedImageData,
  type ExtractedFormulaData,
} from '@/lib/validations/document-extraction'
import { logger } from '@/lib/logger'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { signMany } from '@/lib/supabase/signed-urls'

export interface LibraryImage extends ExtractedImageData {
  lectureId: string
  lectureTitle: string
}

export interface LibraryFormula extends ExtractedFormulaData {
  lectureId: string
  lectureTitle: string
}

export interface SectionLibrary {
  images: LibraryImage[]
  formulas: LibraryFormula[]
  lectures: Array<{ id: string; title: string }>
}

/**
 * Fetch every lecture's extracted media for a section. Flattens across
 * modules → module_items. Silent-drops malformed entries.
 */
export async function getSectionExtractedMedia(
  admin: SupabaseClient,
  sectionId: string,
): Promise<SectionLibrary> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('module_items')
    .select(
      'id, title, item_type, content, modules!inner(id, section_id)',
    )
    .eq('modules.section_id', sectionId)
    .eq('item_type', 'lecture')

  if (error) {
    logger.error('getSectionExtractedMedia: query failed', error, { sectionId })
    return { images: [], formulas: [], lectures: [] }
  }

  const rows = (data ?? []) as Array<{
    id: string
    title: string
    content: Record<string, unknown> | null
  }>

  const images: LibraryImage[] = []
  const formulas: LibraryFormula[] = []
  const lectureIds = new Set<string>()
  const lectureList: Array<{ id: string; title: string }> = []

  for (const row of rows) {
    const extraction = (row.content?.extraction as Record<string, unknown> | undefined) ?? null
    if (!extraction) continue

    const rawImages = extraction.images
    const rawFormulas = extraction.formulas
    const hasAnything =
      (Array.isArray(rawImages) && rawImages.length > 0) ||
      (Array.isArray(rawFormulas) && rawFormulas.length > 0)
    if (!hasAnything) continue

    if (!lectureIds.has(row.id)) {
      lectureIds.add(row.id)
      lectureList.push({ id: row.id, title: row.title || 'Untitled lecture' })
    }

    if (Array.isArray(rawImages)) {
      for (const raw of rawImages) {
        const parsed = extractedImageSchema.safeParse(raw)
        if (!parsed.success) continue
        images.push({
          ...parsed.data,
          lectureId: row.id,
          lectureTitle: row.title || 'Untitled lecture',
        })
      }
    }

    if (Array.isArray(rawFormulas)) {
      for (const raw of rawFormulas) {
        const parsed = extractedFormulaSchema.safeParse(raw)
        if (!parsed.success) continue
        // Skip trivially-noisy formulas — tightens the UI without
        // losing anything meaningful. Bare single digits and
        // single-letter variables are artefacts of Gemini being
        // over-eager; they're visible in page 7 of the test lecture
        // ("8", "3", "\mathbf{x}" each counted as separate formulas).
        const stripped = parsed.data.latex.trim()
        if (stripped.length <= 2) continue
        if (/^\d+(\.\d+)?$/.test(stripped)) continue
        if (/^\\mathbf\{[a-zA-Z]\}$/.test(stripped)) continue

        formulas.push({
          ...parsed.data,
          lectureId: row.id,
          lectureTitle: row.title || 'Untitled lecture',
        })
      }
    }
  }

  // Dedupe formulas across the same lecture (Gemini repeats the same
  // formula on consecutive slides) by `(lectureId, latex)`. First
  // occurrence wins, preserving whichever page we saw it on first.
  const seen = new Set<string>()
  const deduped: LibraryFormula[] = []
  for (const f of formulas) {
    const key = `${f.lectureId}::${f.latex}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(f)
  }

  // Re-sign image URLs at read time. The `storageUrl` we persisted in
  // module_items.content.extraction was a public URL produced by
  // getPublicUrl(), which stopped resolving when course-materials went
  // private (mig 48). The storagePath survives unchanged, so we mint a
  // fresh short-TTL signed URL per render and overwrite storageUrl.
  if (images.length > 0) {
    const paths = images.map((img) => img.storagePath)
    const signed = await signMany(COURSE_MATERIALS_BUCKET, paths)
    for (const img of images) {
      const url = signed.get(img.storagePath)
      if (url) img.storageUrl = url
    }
  }

  return {
    images,
    formulas: deduped,
    lectures: lectureList.sort((a, b) => a.title.localeCompare(b.title)),
  }
}
