// Render-time signing for About-page hero assets: the banner image, and any file
// uploaded for the hero's action button.
//
// Both live in the private `course-materials` bucket. The uploader bakes a
// short-lived signed URL into the saved content, which expires (~1h) — breaking
// the image, or handing the student a dead "View syllabus" button. We re-sign from
// the stored path on every render so neither goes stale. Pass an admin
// (RLS-bypassing) client so students can view assets in sections whose private
// files they can't sign for themselves.
//
// Mirrors the queries.ts convention: takes a SupabaseClient as the first param.

import type { SupabaseClient } from '@supabase/supabase-js'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import type { AboutContentV2 } from '@/lib/validations/course-about'

const BANNER_SIGN_TTL_SECONDS = 60 * 60

/**
 * Return a copy of the About content with every hero block's private-storage
 * asset refreshed to a freshly-signed URL:
 *   - `bannerSrc`, re-signed from `bannerPath`
 *   - `ctaUrl`,    re-signed from `ctaFilePath` (only when the professor UPLOADED
 *                  a file; a pasted external link has no path and is left alone)
 * Blocks with neither are returned untouched. Never throws — a failed sign leaves
 * that block's existing URL in place.
 */
/**
 * Drop the fields that exist only so the PROFESSOR's editor can re-upload or
 * re-sign an asset: the storage object paths and the stored filename. Nothing
 * rendered reads them, but `BlockPreview` is a client component, so whatever is
 * left on a block is serialized into the payload the browser receives. A student
 * has no use for the private-bucket layout of their course, so the student route
 * strips them before handing the blocks over.
 *
 * The signed URLs (`bannerSrc`, `ctaUrl`) stay — those ARE what renders.
 */
export function stripPrivateAssetFields(content: AboutContentV2): AboutContentV2 {
  return {
    ...content,
    blocks: content.blocks.map((block) => {
      if (block.type === 'hero') {
        return { ...block, data: { ...block.data, bannerPath: '', ctaFilePath: '', ctaFileName: '' } }
      }
      if (block.type === 'image') {
        return { ...block, data: { ...block.data, srcPath: '' } }
      }
      return block
    }),
  }
}

export async function resolveAboutAssetUrls(
  supabase: SupabaseClient,
  content: AboutContentV2,
): Promise<AboutContentV2> {
  const needsSigning = content.blocks.some(
    (b) => b.type === 'hero' && (b.data.bannerPath || b.data.ctaFilePath),
  )
  if (!needsSigning) return content

  const sign = async (path: string): Promise<string | null> => {
    const { data } = await supabase.storage
      .from(COURSE_MATERIALS_BUCKET)
      .createSignedUrl(path, BANNER_SIGN_TTL_SECONDS)
    return data?.signedUrl ?? null
  }

  const blocks = await Promise.all(
    content.blocks.map(async (block) => {
      if (block.type !== 'hero') return block
      const { bannerPath, ctaFilePath } = block.data
      if (!bannerPath && !ctaFilePath) return block

      // Signed in parallel: two round-trips in series would show up on every
      // About-page render for both roles.
      const [bannerSrc, ctaUrl] = await Promise.all([
        bannerPath ? sign(bannerPath) : Promise.resolve(null),
        ctaFilePath ? sign(ctaFilePath) : Promise.resolve(null),
      ])

      const data = { ...block.data }
      if (bannerSrc) data.bannerSrc = bannerSrc
      if (ctaUrl) data.ctaUrl = ctaUrl
      return { ...block, data }
    }),
  )

  return { ...content, blocks }
}
