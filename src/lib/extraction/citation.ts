// Source-citation primitive (Phase 4, docs/designs §5/§13.4).
//
// Turns an extracted unit + its document context into a citation a reader can
// see and click: a label like "[Transformers, slide 14]", a deep-link to the
// module item at that page (+ optional bbox highlight), and a trust badge
// derived from how the unit was read (sourceMethod).
//
// Pure + framework-agnostic so the AI tutor, quiz generator, and UI can all
// share it. The deep-link's `?item/&page/#bbox` params are consumed by the
// document viewer (a separate UI surface); until that lands the link still
// resolves to the module page.

/** How a unit was read — the citation-trust dial (§5). */
export type SourceMethod = 'native' | 'omml' | 'geometric' | 'ocr' | 'vision'

/** Normalized bbox: fractions of page width/height in [0,1], top-left origin (§5). */
export interface NormalizedBbox {
  x: number
  y: number
  width: number
  height: number
}

export interface CitationContext {
  role: 'student' | 'professor'
  sectionId: string
  moduleId: string
  moduleItemId: string
  /** Document title shown in the label, e.g. "Transformers". */
  title: string
  /** Decks cite "slide N"; prose/PDFs cite "page N". */
  isSlides: boolean
}

export interface Citation {
  /** Human label, e.g. "[Transformers, slide 14]". */
  label: string
  /** Deep-link to the module item at the page, with optional bbox highlight. */
  href: string
  /** 'exact' = deterministic read (native/omml/geometric/ocr); 'ai-read' = VLM transcription. */
  trust: 'exact' | 'ai-read'
}

/** Only the VLM-transcribed units are flagged as AI-read; the rest are deterministic. */
export function citationTrust(method: SourceMethod): 'exact' | 'ai-read' {
  return method === 'vision' ? 'ai-read' : 'exact'
}

/** A citation the tutor emitted in its answer, e.g. "[Transformers, page 14]".
 *  One entry per page: a multi-page marker yields several, all sharing `raw`. */
export interface ParsedCitation {
  raw: string
  title: string
  page: number
}

// Matches the marker the tutor is instructed to emit: [Title, page N] / [Title,
// slide N]. Group 2 is a comma-separated LIST, because the model also emits
// [Title, page 44, 51] for one passage spanning pages — that used to fall
// through and leave the raw bracket sitting in the prose. Singular/plural
// "page"/"pages" both accepted since a list reads naturally as the latter.
//
// The title group stays lazy so a comma inside the title still works: for
// "[Lecture 3, Intro, page 5]" it first tries "Lecture 3", fails to find
// page/slide after the comma, then expands to "Lecture 3, Intro".
//
// ABBREVIATIONS accepted too — `p.`, `pp.`, `pg.`, `pgs.`, `sl.` (#659). Nothing
// constrains the model to spell out "page", so this is phrasing variance: the same
// question rendered 12 chips one time and 10 raw brackets the next. And the failure was
// all-or-nothing — the "N sources · M pages" block is built from these same matches, so
// one abbreviation stripped EVERY citation from the answer, not just its own chip.
// The trailing dot is optional because models write both "p. 35" and "p 35".
//
// Exported so the chat UI can replace inline tokens with numbered citation chips.
export const CITATION_RE =
  /\[([^\][]+?),\s*(?:pages?|slides?|pp?\.?|pgs?\.?|sl\.?)\s*(\d+(?:\s*,\s*\d+)*)\]/gi

/** The page numbers in a CITATION_RE group-2 match ("44" or "44, 51").
 *  Deduped here rather than at each caller: a model that emits "page 44, 44"
 *  would otherwise get two chips both numbered 1 — rendering as "11" next to a
 *  Sources list claiming one source, since parseCitations dedupes and the chip
 *  replacement did not. Both callers must see the same list. */
export function citationPages(pageList: string): number[] {
  return [...new Set(pageList.split(',').map((p) => Number(p.trim())))]
}

/**
 * Match a cited title to a document: exact (case/space-insensitive) first, then
 * a bidirectional substring match. Returns undefined when nothing matches (the
 * citation then renders as a non-clickable source).
 */
export function matchCitationDoc<T extends { title: string }>(
  citationTitle: string,
  docs: T[],
): T | undefined {
  const norm = (s: string) => s.toLowerCase().trim()
  const c = norm(citationTitle)
  return (
    docs.find((d) => norm(d.title) === c) ??
    docs.find((d) => norm(d.title).includes(c) || c.includes(norm(d.title)))
  )
}

/** Pull the unique [Title, page N] citations out of an answer, in order of
 *  appearance. A multi-page marker expands to one entry per page, so
 *  "[Deck, page 44, 51]" becomes two citations the reader can open separately. */
export function parseCitations(answer: string): ParsedCitation[] {
  const out: ParsedCitation[] = []
  const seen = new Set<string>()
  for (const m of answer.matchAll(CITATION_RE)) {
    const title = m[1].trim()
    for (const page of citationPages(m[2])) {
      const key = `${title.toLowerCase()}#${page}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ raw: m[0], title, page })
    }
  }
  return out
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const round4 = (n: number) => Math.round(n * 1e4) / 1e4

/**
 * Convert a raw per-format bbox to the uniform citation space: fractions of
 * page size in [0,1] with a TOP-LEFT origin (§5). PDFs (pdfjs) are points with
 * a bottom-left origin → pass originBottomLeft=true to flip y. PPTX/DrawingML is
 * already top-left → pass false.
 */
export function normalizeBbox(
  bbox: { x: number; y: number; width: number; height: number },
  pageWidth: number,
  pageHeight: number,
  originBottomLeft: boolean,
): NormalizedBbox {
  if (pageWidth <= 0 || pageHeight <= 0) return { x: 0, y: 0, width: 0, height: 0 }
  const topY = originBottomLeft ? pageHeight - (bbox.y + bbox.height) : bbox.y
  return {
    x: round4(clamp01(bbox.x / pageWidth)),
    y: round4(clamp01(topY / pageHeight)),
    width: round4(clamp01(bbox.width / pageWidth)),
    height: round4(clamp01(bbox.height / pageHeight)),
  }
}

/**
 * Build a citation for a unit on a given page. `bbox` (if present) must already
 * be normalized via normalizeBbox.
 */
export function formatCitation(
  ctx: CitationContext,
  unit: { pageNumber: number; sourceMethod: SourceMethod; bbox?: NormalizedBbox },
): Citation {
  const noun = ctx.isSlides ? 'slide' : 'page'
  const label = `[${ctx.title}, ${noun} ${unit.pageNumber}]`

  const base = `/${ctx.role}/courses/${ctx.sectionId}/modules/${ctx.moduleId}`
  const query = `?item=${encodeURIComponent(ctx.moduleItemId)}&page=${unit.pageNumber}`
  const hash = unit.bbox
    ? `#bbox=${unit.bbox.x},${unit.bbox.y},${unit.bbox.width},${unit.bbox.height}`
    : ''

  return { label, href: `${base}${query}${hash}`, trust: citationTrust(unit.sourceMethod) }
}
