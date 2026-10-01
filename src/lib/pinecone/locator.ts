// Explicit-locator direct lookup (design doc §4 "Explicit locator"): when a
// query literally names a place — "lecture 6 slide 27", "page 40 of the
// transformers notes", "word2vec page 3" — resolve it to an exact
// (module_item, page) so that page can be pinned into retrieval deterministically,
// no vector similarity involved. Pure resolver (no I/O); the caller pins the
// result through the SAME visibility/tenant gate as any other page.

export interface LocatorItem {
  moduleItemId: string
  title: string
}
export interface ResolvedLocator {
  moduleItemId: string
  page: number
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Dropped when deriving a material's distinctive keywords — structural/among-
// every-title words that shouldn't drive a match.
const TITLE_STOP = new Set([
  'lecture', 'notes', 'note', 'slides', 'slide', 'pptx', 'ppt', 'deck', 'the', 'of', 'and', 'to',
  'intro', 'introduction', 'guide', 'guidelines', 'sample', 'exam', 'part', 'week', 'course', 'final', 'format',
])

/**
 * Resolve an explicit locator to (moduleItemId, page), or null when the query
 * carries no locator or it's ambiguous (never pin a wrong page). `items` should
 * be the section's embeddable materials (those with stored concepts) so
 * external readings/links can't create phantom matches.
 */
export function resolveLocator(query: string, items: LocatorItem[]): ResolvedLocator | null {
  // A page/slide number is REQUIRED and must follow a page/slide keyword — never
  // a bare number (so "the 3 types of attention" isn't a locator).
  const pageM = /(?:\bslides?\b|\bpages?\b|\bpg\b|\bp\.)\s*#?\s*(\d{1,4})/i.exec(query)
  if (!pageM) return null
  const page = Number(pageM[1])
  if (!Number.isInteger(page) || page < 1) return null

  const nq = ` ${norm(query)} `
  // "slides"/"deck"/"pptx" (a deck reference) → the slide deck; a bare "slide N"
  // is just a page synonym → the primary material.
  const wantsDeck = /\b(?:slides|deck|pptx|powerpoint|presentation)\b/i.test(query)
  const isDeck = (t: string) => /\b(?:slide|slides|pptx|ppt|deck)\b/.test(norm(t))

  // Material — anchored lecture-number path first (precise), else a distinctive
  // keyword match against the titles.
  let candidates: LocatorItem[]
  const lecM = /\blecture\s+(\d{1,2})\b/i.exec(query)
  if (lecM) {
    const re = new RegExp(`^lecture ${lecM[1]}\\b`)
    candidates = items.filter((it) => re.test(norm(it.title)))
  } else {
    const scored = items
      .map((it) => {
        const words = norm(it.title)
          .split(' ')
          .filter((w) => w.length >= 4 && !TITLE_STOP.has(w) && !/^\d+$/.test(w))
        return { it, hits: words.filter((w) => nq.includes(` ${w} `)).length }
      })
      .filter((s) => s.hits > 0)
    const max = scored.reduce((m, s) => Math.max(m, s.hits), 0)
    candidates = scored.filter((s) => s.hits === max).map((s) => s.it)
  }
  if (candidates.length === 0) return null

  // Disambiguate a deck vs its primary material by the deck cue.
  if (candidates.length > 1) {
    const pref = candidates.filter((it) => (wantsDeck ? isDeck(it.title) : !isDeck(it.title)))
    if (pref.length) candidates = pref
  }
  if (candidates.length !== 1) return null // still ambiguous → refuse to guess

  return { moduleItemId: candidates[0].moduleItemId, page }
}
