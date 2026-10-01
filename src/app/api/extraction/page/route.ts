// Renders one page of a source document to PNG, for citation previews (AI tutor
// answers + AI-generated quiz questions). Two modes:
//   ?item=<moduleItemId>  — a module file. Auth: enrolled student of the item's
//                           section OR its professor/TA/grader.
//   ?path=<storagePath>   — an ad-hoc quiz upload under {sectionId}/quiz-ai-uploads/.
//                           Auth: section staff/professor ONLY (professor-only aid).
// Item mode also accepts ?asset=<kind>:<page>:<idx> instead of ?page= — the
// AI tutor's inline visuals: the asset is resolved against the item's STORED
// extraction (model output is never trusted) and the page is cropped to the
// unit's bbox. Unknown asset → 404, the client hides the image.
// PDFs render directly. PPTX/PPT are converted to PDF once in the ISOLATED
// Gotenberg service (never in this container — issue #182) and the derived PDF is
// cached in storage next to the original, so only the first peek of a deck pays
// the conversion cost. With the converter unconfigured, conversion returns null
// and the peek degrades instead of rendering.
// Assume an attacker calls this unauthenticated with arbitrary ids/paths
// (BOLA/IDOR): we resolve the section from the id/path and authorize against it
// before touching Storage or converting.

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadRenderablePdf, renderPageRegionPng } from '@/lib/document-parser/asset-crop'
import { renderPdfPages } from '@/lib/document-parser/page-renderer'
import { findAssetUnit, ASSET_KINDS, type AssetKind } from '@/lib/extraction/assets'
import { resolvePreviewSource } from '@/lib/extraction/preview-access'
import { logger } from '@/lib/logger'

// A cold conversion of a large deck can take several seconds; this must stay
// ABOVE OFFICE_CONVERT_TIMEOUT_MS (45s), which is set from this number — the
// converter has to lose the race, or we return a raw 504 with nothing cached.
export const maxDuration = 60

const MAX_PAGE = 2000 // bound the page param

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

/** Parse the `asset` param (`<kind>:<page>:<idx>`); null if malformed. */
function parseAssetParam(raw: string): { kind: AssetKind; page: number; idx: number } | null {
  const m = /^(table|chart|figure):(\d{1,4}):(\d{1,3})$/.exec(raw)
  if (!m || !ASSET_KINDS.includes(m[1] as AssetKind)) return null
  return { kind: m[1] as AssetKind, page: Number(m[2]), idx: Number(m[3]) }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const itemId = url.searchParams.get('item')
    const filePathParam = url.searchParams.get('path')
    const assetParam = url.searchParams.get('asset')
    const asset = assetParam ? parseAssetParam(assetParam) : null
    if (assetParam && (!asset || !itemId)) {
      return new Response('Bad request', { status: 400 })
    }
    const page = asset ? asset.page : Number(url.searchParams.get('page'))
    if ((!itemId && !filePathParam) || !Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
      return new Response('Bad request', { status: 400 })
    }

    // Authenticate
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return new Response('Unauthorized', { status: 401 })

    const adminDb = createAdminClient() as AdminDb

    // Resolve (sectionId, filePath) + authorize, per mode. Shared with
    // /api/extraction/pdf — one decision, so the two routes can't drift.
    const source = await resolvePreviewSource(adminDb, user.id, { itemId, filePath: filePathParam })
    if (!source.ok) return new Response(source.message, { status: source.status })
    const { filePath, itemExtraction } = source

    // Asset mode: the unit must exist in the item's stored extraction — a
    // hallucinated/forged ref resolves to nothing and 404s here.
    let cropBbox: { x: number; y: number; width: number; height: number } | undefined
    if (asset) {
      const unit = itemExtraction ? findAssetUnit(itemExtraction, asset.kind, asset.page, asset.idx) : null
      if (!unit) return new Response('Not found', { status: 404 })
      cropBbox = unit.bbox
    }

    // Resolve to a PDF (converting + caching office files), then render the page.
    const pdf = await loadRenderablePdf(adminDb, filePath)
    if (pdf === null) return new Response('Not found', { status: 404 })
    if (pdf === 'unsupported') {
      return new Response('Page preview is only available for PDF and Office documents', { status: 415 })
    }

    let png: Buffer | null
    if (asset) {
      png = await renderPageRegionPng(pdf, page, cropBbox)
    } else {
      const [rendered] = await renderPdfPages(pdf, [page], 2, 'png')
      png = rendered?.buffer ?? null
    }
    if (!png) return new Response('Page out of range', { status: 404 })

    return new Response(new Uint8Array(png), {
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Content-Type': 'image/png',
        // private: it's authorized course content, cache only in the user's browser
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch (err) {
    logger.error('GET /api/extraction/page: render failed', err)
    return new Response('Internal server error', { status: 500 })
  }
}
