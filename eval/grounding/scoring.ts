// The deterministic half of the grounding eval, as pure functions.
//
// Split out of export.ts for one reason: that file opens a Supabase client and
// runs `main()` at import, so a unit test can never load it — and this is the
// logic most worth testing, because a bug here silently mis-scores the sharpest
// metric the eval has (a citation the model invented). Covered in CI by
// `src/__tests__/eval-grounding-scoring.test.ts`, which needs no keys.

import { round4 } from '../retrieval/metrics'

export interface Citation {
  material: string
  page: number
}

export interface CitationScores {
  citations: Citation[]
  fabricated_citations: Citation[]
  citation_validity: number | null
  citation_correctness: number | null
}

/** `[Some Title, page 14]` / `[Some Title (spoken), slide 3]` — the marker the prompt
 *  contracts for and the client renders as a chip. Kept in sync with CITATION_RE in
 *  `src/lib/ai/conversation-utils.ts`; duplicated rather than imported because that
 *  module is client-side and this one runs under tsx. */
const CITATION_RE = /\[([^[\]]+?),\s*(?:page|slide)\s+(\d+)\]/gi
/** One `Title, page N` pair — used to unpack a compound marker the model
 *  occasionally writes, e.g. `[Lecture 2, page 9; Lecture 7, page 22]`. The
 *  contract asks for one page per marker; reading both beats scoring the whole
 *  thing as a citation of a document called "Lecture 2, page 9; Lecture 7". */
const CITATION_PAIR_RE = /^(.*?),\s*(?:page|slide)\s+(\d+)$/i

/** Pull every `[Title, page N]` out of an answer, de-duplicated. */
export function parseCitations(answer: string): Citation[] {
  const out = new Map<string, Citation>()
  const add = (rawMaterial: string, rawPage: string) => {
    const material = rawMaterial.replace(/\s*\(spoken\)\s*$/i, '').trim()
    const page = Number(rawPage)
    if (!material || !Number.isFinite(page)) return
    out.set(`${normalizeTitle(material)}#${page}`, { material, page })
  }
  for (const m of answer.matchAll(CITATION_RE)) {
    // A well-formed marker holds one pair; a compound one holds several,
    // separated by `;`. Splitting first means the common case is unaffected.
    const segments = m[1].split(';')
    if (segments.length === 1) {
      add(m[1], m[2])
      continue
    }
    for (const [i, seg] of segments.entries()) {
      const pair = seg.trim().match(CITATION_PAIR_RE)
      // The last segment's page lives outside the split, in the regex's own capture.
      if (pair) add(pair[1], pair[2])
      else if (i === segments.length - 1) add(seg, m[2])
    }
  }
  return [...out.values()]
}

/** Lower-case, punctuation-flattened, whitespace-collapsed — for comparing a
 *  cited title against a real one. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[—–-]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Does this citation name one of the pages the model was actually shown?
 *
 * Page number first, title second, and the title match is deliberately loose:
 * the model routinely shortens "Lecture 7: Pretraining and Post-training" to
 * "Lecture 7", which is the same citation as far as a student clicking the chip
 * is concerned. An exact-string check scored seven of those as INVENTED — a
 * false alarm in the sharpest metric this eval has, which is worse than useless.
 *
 * The looseness is bounded by the page number and by requiring EXACTLY ONE
 * context page to match: this corpus holds both "Lecture 7: Pretraining…" and
 * "Lecture 7 — Attention & Transformers", so a bare "Lecture 7" is only accepted
 * when just one of them contributed that page.
 */
function matchesContext(cit: Citation, contextPages: Citation[]): boolean {
  const cited = normalizeTitle(cit.material)
  const samePage = contextPages.filter((p) => p.page === cit.page)
  const compatible = samePage.filter((p) => {
    const real = normalizeTitle(p.material)
    return real === cited || real.startsWith(cited) || cited.startsWith(real)
  })
  return compatible.length === 1
}

/**
 * The deterministic half, as a pure function of what was said and what was shown.
 *
 * Separated so `--rescore` can re-derive every number from `records.jsonl`
 * without paying for a fresh generation: sharpening a metric definition should
 * cost nothing, and re-running the model would change the answers underneath the
 * change being evaluated.
 */
export function scoreAnswer(
  answer: string,
  contextLabels: Citation[],
  goldLabels: Citation[],
): CitationScores {
  const citations = parseCitations(answer)
  const fabricated = citations.filter((cit) => !matchesContext(cit, contextLabels))
  return {
    citations,
    fabricated_citations: fabricated,
    // "Did every citation name a page the model was actually shown?" A case with
    // no citations has nothing to be valid or invalid about, hence null.
    citation_validity: citations.length === 0 ? null : round4((citations.length - fabricated.length) / citations.length),
    // "…and was it one of the pages a human labelled as answering this question?"
    // Gold labels are NOT exhaustive — a citation to another retrieved page is
    // legitimate — so read this as concentration on the labelled pages, not as a
    // share of citations that are "wrong".
    citation_correctness:
      citations.length === 0 || goldLabels.length === 0
        ? null
        : round4(citations.filter((cit) => matchesContext(cit, goldLabels)).length / citations.length),
  }
}
