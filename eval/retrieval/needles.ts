// The generated needle set — layer 1's corpus-wide coverage check (§11).
//
// The curated golden set is 34 hand-labelled cases over material a human chose.
// That measures ranking well and coverage not at all: a whole lecture could fall
// out of the index and every curated case would stay green. Needles fix the
// blind spot by sampling the corpus itself — one question per sampled page,
// generated FROM that page, with the page as its only gold answer.
//
// The generation rule that makes it a real test: the question may not reuse the
// page's distinctive vocabulary. A question containing "scaled dot-product" will
// find the scaled-dot-product page by lexical luck on any embedding model; one
// that has to ask for it in a student's own words ("why do we divide the scores
// by the square root of the dimension?") is testing retrieval.
//
// Kept separate from `golden.json` on purpose. These are MACHINE-labelled — the
// gold page is whichever page the question was generated from, which is a weaker
// claim than a human reading the text and saying "this is where the answer is".
// They belong in a coverage metric (Hit@k over ~100 pages), not in the curated
// gate's precision means.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// CJS `__dirname`, not `import.meta.url`: the repo has no `"type": "module"`,
// so tsx runs these files as CommonJS.
const HERE = __dirname

export const NEEDLES_PATH = join(HERE, 'needles.json')
export const NEEDLES_BASELINE_PATH = join(HERE, 'needles-baseline.json')

export interface Needle {
  /** `needle-<material slug>-p<page>` — stable across regeneration of the same page. */
  id: string
  /** Gold page, labelled the same way the curated set is: title + page, resolved at run time. */
  material: string
  page: number
  /** The student-style question generated from that page. */
  query: string
  /** Distinctive terms the generator was told not to use — kept so a run can re-verify. */
  banned: string[]
}

export interface NeedleSet {
  corpus: string
  /** Model that wrote the questions, so a regenerated set is traceable. */
  generator: string
  generated: string
  needles: Needle[]
}

/** Word-boundary, case-insensitive: does the question leak a banned term? */
export function leakedTerms(query: string, banned: string[]): string[] {
  const haystack = query.toLowerCase()
  return banned.filter((term) => {
    const t = term.trim().toLowerCase()
    if (!t) return false
    // Escape regex metacharacters — course vocabulary is full of them ("O(n^2)",
    // "P(w|c)", "softmax(QK^T)").
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // \b doesn't fire next to a non-word character, so anchor on either a word
    // boundary or a non-word neighbour, which handles both "attention" and "QK^T".
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack)
  })
}

export function loadNeedleSet(path = NEEDLES_PATH): NeedleSet {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as NeedleSet
  const ids = new Set<string>()
  for (const n of raw.needles) {
    if (ids.has(n.id)) throw new Error(`needles.json: duplicate needle id "${n.id}"`)
    ids.add(n.id)
    if (!n.query.trim()) throw new Error(`needles.json: needle "${n.id}" has no query`)
    // A needle whose question quotes the page's own vocabulary is a lexical
    // lookup wearing a semantic costume — it would score a hit on any model and
    // hide exactly the regression this set exists to catch. Reject at load, not
    // at generation only, so a hand-edited file can't reintroduce one.
    const leaked = leakedTerms(n.query, n.banned)
    if (leaked.length > 0) {
      throw new Error(`needles.json: needle "${n.id}" reuses banned term(s): ${leaked.join(', ')}`)
    }
  }
  return raw
}
