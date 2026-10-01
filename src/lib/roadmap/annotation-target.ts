/**
 * annotation-target — how an annotation finds the card it belongs to.
 *
 * ONE implementation, because there were two: the annotation layer resolves a
 * target against React Flow nodes to position the note, and the triage engine
 * resolves the same string against the course data to decide which module band
 * the note lives in and what kind of card it hit. They were separate copies of
 * the same matching rules, so "which module is this on" and "where is it drawn"
 * could disagree — and a fix to either was a fix to half the behaviour.
 *
 * The forms, most specific first:
 *
 *   `item:<uuid>`  → the card whose node key is that module item. Exact, so it
 *                    cannot land on the wrong card. Generated annotations should
 *                    use this: they are produced from rows that already know the
 *                    id, and nobody proof-reads them against the real map.
 *   `session:<t>`  → the live-session tile (sessions often share a lecture's title).
 *   `module:<t>`   → the module band (a class-aggregate note like "3 stuck here"
 *                    must not land on a resource whose title contains the module's).
 *   `<title>`      → a card by title.
 *
 * Title matching prefers an EXACT match before falling back to substring, and that
 * ordering is the whole fix for a real bug: a course with both "Attention" and
 * "Attention Is All You Need" resolved the first to the second, because the
 * shorter title is a substring of the longer one and the longer card came first.
 * Every generated signal carries the card's FULL title, so exact-first sends each
 * to its own card; substring is kept for hand-authored notes that deliberately
 * write a fragment ("Lecture 3" for "Lecture 3: Attention").
 *
 * Two cards with the SAME title are still ambiguous by title alone — that is what
 * `item:` is for.
 */

export type TargetGroup = 'res' | 'sess' | 'mod'

/** What a target string asks for, once its prefix is read. */
export interface ParsedTarget {
  /** Which kinds of card may answer, in order of preference. */
  order: readonly TargetGroup[]
  /** The title (or fragment) to match, empty for an id target. */
  query: string
  /** Set for `item:<id>` — match the node key's id instead of the title. */
  itemId?: string
}

const ITEM = /^item:(.*)$/
const SESSION = /^session:(.*)$/
const MODULE = /^module:(.*)$/

export function parseTarget(target: string): ParsedTarget {
  const item = ITEM.exec(target)
  if (item) return { order: ['res'], query: '', itemId: item[1] }
  const sess = SESSION.exec(target)
  if (sess) return { order: ['sess'], query: sess[1] }
  const mod = MODULE.exec(target)
  if (mod) return { order: ['mod'], query: mod[1] }
  // Resources first, module bands last: the `rule` variant targets a module title,
  // and a lecture sharing that title must not pull the scope line onto itself.
  return { order: ['res', 'sess', 'mod'], query: target }
}

/**
 * Find the entry an annotation target names, or undefined.
 *
 * Generic over the caller's entry type — the layer holds React Flow nodes, the
 * triage engine holds its own located rows — so both get identical rules from one
 * place. `key` is the card's node key (`module_item:{id}`) where it has one.
 */
export function resolveTarget<T>(
  entries: readonly T[],
  target: string,
  get: {
    group: (e: T) => TargetGroup
    title: (e: T) => string
    key?: (e: T) => string | undefined
  },
): T | undefined {
  const { order, query, itemId } = parseTarget(target)

  if (itemId !== undefined) {
    if (!get.key) return undefined
    return entries.find((e) => {
      const k = get.key!(e)
      if (!k) return false
      // `module_item:{uuid}` — split on the FIRST colon, as parseNodeKey does.
      return k.slice(k.indexOf(':') + 1) === itemId
    })
  }

  for (const g of order) {
    // Exact before substring, within the same group: see the header.
    const exact = entries.find((e) => get.group(e) === g && get.title(e) === query)
    if (exact) return exact
    const partial = entries.find((e) => get.group(e) === g && get.title(e).includes(query))
    if (partial) return partial
  }
  return undefined
}

// ── Spoken labels ─────────────────────────────────────────────────────────────
//
// `resolveTarget` answers "which card does this target name?" for a string
// authored AGAINST the map. These three are the same vocabulary for a label that
// was SPOKEN — a module name the model paraphrased, a concept title an LLM
// proposed — and they live here so "when are two labels the same thing" has one
// answer rather than one per caller.

/** The case/whitespace-insensitive form both sides of a comparison go into. */
export const normalizeLabel = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** Shortest label the word-overlap fallback will match on. Below this a tiny
 *  fragment ("AI", "ML") coincidence-matches unrelated titles. */
export const MIN_LABEL_MATCH_LEN = 4

const labelWords = (s: string): string[] => s.split(/\W+/).filter((w) => w.length > 0)

/** True when every word of `sub` appears as a WHOLE word in `sup` — a paraphrase
 *  overlap ("recurrent networks" ⊆ "recurrent neural networks"), never a bare
 *  substring: "rate" is not a word of "operators", so it does not match. */
export function labelWordSubset(sub: string, sup: string): boolean {
  const have = new Set(labelWords(sup))
  const want = labelWords(sub)
  return want.length > 0 && want.every((w) => have.has(w))
}
