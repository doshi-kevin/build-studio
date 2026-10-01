// Serves a source document as a PDF, so the material viewer can show an office
// deck in the SAME scrolling iframe it already uses for PDFs — one continuous
// document with the browser's own scroll, zoom, and text search, instead of
// stepping slide-by-slide through server-rendered PNGs.
//
//   ?item=<moduleItemId>  — a module file (enrolled student OR section staff)
//   ?path=<storagePath>   — an ad-hoc quiz upload (section staff only)
//
// A real PDF is streamed back unchanged; PPTX/PPT are converted once in the
// isolated Gotenberg service and the derived PDF is cached in storage beside the
// original (issue #182), so only the first open of a deck pays for conversion.
//
// Authorization is `resolvePreviewSource` — the SAME decision /api/extraction/page
// makes, deliberately shared rather than copied: both routes hand a storage path
// to the RLS-bypassing admin client, and this one returns the WHOLE file rather
// than one page, so a drift between them would be a bigger IDOR, not a smaller one.

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadRenderablePdf } from '@/lib/document-parser/asset-crop'
import { resolvePreviewSource } from '@/lib/extraction/preview-access'
import { isPptxEnabled } from '@/lib/live-classroom/deck-converter'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { logger } from '@/lib/logger'

// Matches /api/extraction/page: must stay ABOVE the converter's own 45s ceiling
// (OFFICE_CONVERT_TIMEOUT_MS) so the converter loses the race, not this handler.
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

/* This is the first route to serve user-uploaded bytes INLINE from the app's own
   origin (real PDFs come from the Supabase signed-URL origin), so say plainly that
   the declared type is the type. Defence in depth: the explicit application/pdf
   already stops a modern browser sniffing its way to HTML. */
const NO_SNIFF = { 'X-Content-Type-Options': 'nosniff' } as const

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const itemId = url.searchParams.get('item')
    const filePathParam = url.searchParams.get('path')
    if (!itemId && !filePathParam) return new Response('Bad request', { status: 400 })

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return new Response('Unauthorized', { status: 401 })

    const adminDb = createAdminClient() as AdminDb
    const source = await resolvePreviewSource(adminDb, user.id, { itemId, filePath: filePathParam })
    if (!source.ok) return new Response(source.message, { status: source.status })

    /* Next implements HEAD as literally `HEAD = GET`, so without this a probe would
       run the storage download AND (on a cold deck) the whole conversion + cache
       upload — and an HTTP cache can never serve a stored HEAD response to a GET,
       so it is pure duplicate work, not a warm-up. The viewer probes with HEAD to
       tell "can't preview" from "here it is", so this must answer without doing
       the work.

       It used to answer on the file extension ALONE, which made the probe dishonest
       in the one case it exists for. With the converter unconfigured, a .pptx still
       matched the regex, HEAD said 204, and then GET returned a 415 whose plain-text
       body rendered as a monospace sentence inside the viewer chrome — precisely the
       failure this probe is here to prevent.

       A real PDF needs no converter, so it is always answerable. An office deck is
       answerable if the converter is configured, or if a previous open already cached
       the derived PDF beside the original (that cache is what GET reads first, and it
       keeps working with the converter switched off). */
    if (req.method === 'HEAD') {
      const isPdf = /\.pdf$/i.test(source.filePath)
      const isOffice = /\.pptx?$/i.test(source.filePath)
      if (!isPdf && !isOffice) return new Response(null, { status: 415, headers: NO_SNIFF })

      let answerable = isPdf || isPptxEnabled()
      if (!answerable) {
        // Converter is off: the only way this deck can still render is a cached
        // derived PDF. List (metadata only) rather than download — this is the
        // degraded path, but the probe must still not move bytes.
        const derivedPath = `${source.filePath}.pdf`
        const slash = derivedPath.lastIndexOf('/')
        const { data: found } = await adminDb.storage
          .from(COURSE_MATERIALS_BUCKET)
          .list(slash < 0 ? '' : derivedPath.slice(0, slash), {
            limit: 1,
            search: derivedPath.slice(slash + 1),
          })
        answerable = Array.isArray(found) && found.length > 0
      }
      return new Response(null, { status: answerable ? 204 : 415, headers: NO_SNIFF })
    }

    const pdf = await loadRenderablePdf(adminDb, source.filePath)
    if (pdf === null) return new Response('Not found', { status: 404 })
    if (pdf === 'unsupported') {
      /* Two different causes land here, and the old single message named the wrong
         one for the commoner of them: it said "only available for PDF and PowerPoint"
         about a PowerPoint whose conversion had just failed. Say which happened.

         The viewer turns either into its own "can't preview" panel, so this text is
         for the logs and for anyone hitting the route directly — never a raw browser
         error page inside the frame. */
      const wrongType = !/\.(pdf|pptx?)$/i.test(source.filePath)
      return new Response(
        wrongType
          ? 'Inline preview is only available for PDF and PowerPoint files'
          : 'This PowerPoint could not be converted for preview. The converter may be unavailable.',
        { status: 415, headers: NO_SNIFF },
      )
    }

    return new Response(new Uint8Array(pdf), {
      headers: {
        ...NO_SNIFF,
        'Content-Type': 'application/pdf',
        // inline: this is a viewer, not a download. The deck's own "Download PPT"
        // action stays the way to get the source file.
        'Content-Disposition': 'inline',
        // private: authorized course content — the user's browser only, never a
        // shared/CDN cache.
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch (err) {
    logger.error('GET /api/extraction/pdf: failed', err)
    return new Response('Internal server error', { status: 500 })
  }
}
