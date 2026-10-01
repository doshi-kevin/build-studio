/**
 * Studio server actions.
 *
 * `verifyYoutubeVideo` exists because URL SHAPE is not existence. Athena was observed grounding
 * a video's existence in a search result and then inventing its id: search confirmed a real
 * lesson on toptechboy.com, carried no YouTube URL, and the model emitted
 * `watch?v=pD4UqjS3W2A`, which does not exist. Two of the three URLs in that same reply were
 * real — right most of the time is what makes it dangerous, because nobody audits the links.
 *
 * A well-formed fake passes every offline check, so the only way to catch it is to ask YouTube.
 * oEmbed is the cheapest way: it returns 200 + title/author for a playable public video and 404
 * for one that does not exist or is private.
 *
 * Type: Server Action
 */

'use server'

import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { rateLimit } from '@/lib/quiz/rate-limit'
import { youtubeVideoId } from './athena-document-blocks'

/**
 * Three states, deliberately — not a boolean.
 *
 * `unknown` is the important one. If oEmbed is unreachable, rate-limits us, or times out, we do
 * NOT get to tell the professor their video is broken; a false accusation on a link they added
 * themselves is worse than staying quiet, and it would make the whole signal untrustworthy. Only
 * `missing` is a claim, and it is only ever made on an explicit 404.
 */
export type YoutubeCheck =
  | { status: 'ok'; title: string; author: string | null }
  | { status: 'missing' }
  | { status: 'unknown' }

/**
 * Settled results, keyed by video id — CAPPED.
 *
 * An unbounded Map here is a heap-exhaustion DoS, not a nicety: a signed-in user can script
 * millions of validly-shaped random ids, every one of which resolves to `missing` and would be
 * retained forever, taking down the container for every tenant on it. Capped with plain
 * insertion-order eviction (Map preserves it) rather than adding an LRU dependency for 6 lines.
 */
const CACHE_MAX = 2000
const cache = new Map<string, YoutubeCheck>()

function remember(id: string, result: YoutubeCheck) {
  if (cache.size >= CACHE_MAX) {
    // Drop the oldest entry. Approximate LRU is fine — this is a latency optimisation over a
    // public, idempotent lookup, so a wrong eviction costs one extra oEmbed call.
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(id, result)
}

export async function verifyYoutubeVideo(rawId: string): Promise<YoutubeCheck> {
  // Auth first. This is a read-only public-metadata lookup, so there is no tenant data to leak
  // — but an unauthenticated endpoint that fetches on demand is still an abuse surface, and
  // every caller is a signed-in professor in an editor.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'unknown' }

  // SSRF guard: we accept an ID, never a URL, and re-validate it against the same rule the
  // renderer uses before building the request. So a caller cannot steer this fetch at an
  // internal host, a file:// path, or a redirect chain — the only reachable origin is
  // youtube.com, and the only variable is 11 characters of [\w-].
  const id = youtubeVideoId(`https://www.youtube.com/watch?v=${String(rawId).trim()}`)
  if (!id) return { status: 'missing' }

  const hit = cache.get(id)
  if (hit) return hit

  // Only UNCACHED ids reach here, so this budgets outbound egress, not page renders: a document
  // with 30 videos costs 30 on first open and 0 thereafter. Without it one signed-in user can
  // loop distinct ids and get YouTube to rate-limit our egress IP, degrading the check for
  // everyone. Reuses the existing helper rather than adding a second bucket implementation.
  if (!rateLimit(`yt-verify:${user.id}`, 60, 60_000)) return { status: 'unknown' }

  const settle = (result: YoutubeCheck) => {
    // Never cache `unknown`: it means we failed to find out, so the next open should retry.
    if (result.status !== 'unknown') remember(id, result)
    return result
  }

  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${id}`,
      )}&format=json`,
      // A dead embed is not worth blocking a document render on, and Next would otherwise
      // cache this into the page's own revalidation.
      { signal: AbortSignal.timeout(4000), cache: 'no-store' },
    )

    if (res.status === 404 || res.status === 400) return settle({ status: 'missing' })
    if (!res.ok) return settle({ status: 'unknown' })

    const data = (await res.json()) as { title?: unknown; author_name?: unknown }
    return settle({
      status: 'ok',
      title: typeof data.title === 'string' ? data.title : '',
      author: typeof data.author_name === 'string' ? data.author_name : null,
    })
  } catch (error) {
    // Timeout / network / malformed JSON — all "we don't know", never "it's broken".
    logger.debug('StudioActions.verifyYoutubeVideo failed', { id, error: String(error) })
    return settle({ status: 'unknown' })
  }
}
