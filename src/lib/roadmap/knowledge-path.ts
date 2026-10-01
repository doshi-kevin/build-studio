/**
 * The knowledge map's resolver — "LLM picks, the graph validates".
 *
 * A student asks "what do I need to understand X?". The model answers with
 * CONCEPT TITLES it drew from the course material, in the order it thinks they
 * build. This module is the validation half: every proposed title is matched
 * against the section's REAL roadmap nodes, and a title that matches nothing is
 * dropped rather than drawn. The model never supplies a node key, so the worst
 * a bad proposal can do is produce a shorter path — never a node that isn't
 * there, and never a node from another course (the caller hands in this
 * section's nodes and nothing else).
 *
 * Pure — no DB, no server imports — so the matching rules are unit-testable
 * without a Supabase double, and the IO half stays in the tool.
 *
 * Every candidate a label could mean is RANKED rather than filtered
 * (`rankNodeMatches`), in four tiers: exact title → exact topic label → the
 * label names the node → the node's name is a fragment of the label. Ties break
 * on the tightest title (fewest words is the tighter claim on a concept), then
 * course order. Exact-before-anything is `resolveTarget`'s rule and it holds for
 * the reason annotation-target.ts documents — a course with both "Attention" and
 * "Attention Is All You Need" resolves the short title to the long card if a
 * looser leg runs first.
 *
 * What is NOT borrowed is `resolveTarget`'s bare-substring fallback. Its targets
 * are authored against the map; these are SPOKEN, so the same fallback finds
 * "bed" inside "Word Embeddings" and puts a stop on the wrong lecture. The
 * paraphrase tiers are whole-word overlap instead, long enough to mean something.
 *
 * Ranking replaced a hard "ambiguous → drop" rule after the first live test.
 * "attention" is a whole-word subset of FOUR titles in a real NLP course
 * ("Lecture 5: Seq2Seq and Attention", "Attention as a soft lookup table",
 * "Vaswani et al. — Attention Is All You Need", "3Blue1Brown — Attention in
 * transformers…"), so dropping on ambiguity lost the FOCUS — and no focus means
 * no feature — on the single most obvious question the tool exists for. Ambiguity
 * is normal on a real roadmap, not a corner case. What survives of the old rule
 * is narrower and only where it earns its keep: a STOP whose top two candidates
 * are dead level (same tier, same title tightness) is still dropped, because a
 * stop on the wrong card sends the student to revise material that isn't the
 * prerequisite. A focus takes the earliest of equals — a slightly-off destination
 * beats no map at all, and the student can see which card was lit.
 */

import { MIN_LABEL_MATCH_LEN, normalizeLabel } from '@/lib/roadmap/annotation-target'

/** A roadmap node a path may pass through. */
export interface PathCandidate {
  /** Canvas key `module_item:<id>`. */
  key: string
  title: string
  /** The node's topic labels — a second name the same material answers to. */
  topics?: string[]
}

/** What the model proposed: a concept and one line on why it comes first. */
export interface ProposedConcept {
  title: string
  why: string
}

export interface PathStop {
  nodeKey: string
  title: string
  why: string
}

/** A `prerequisite` roadmap edge, as node keys. `from` must be understood
 *  before `to` (the roadmap draws "do this first —" on `to`). */
export interface PrereqEdge {
  from: string
  to: string
}

export interface ResolvedPath {
  /** The queried concept's own node, or null when the question names nothing on
   *  this roadmap — the signal to answer in prose instead of drawing a path. */
  focus: { nodeKey: string; title: string } | null
  /** Ordered foundational → focus. Never contains the focus node itself. */
  stops: PathStop[]
  /** Proposed titles that matched no node, so the model can be told what it
   *  invented rather than silently shipping a two-stop path. */
  unmatched: string[]
}

/** Every name a node answers to, title first (title beats topic on a tie). */
const labelsOf = (n: PathCandidate): string[] => [n.title, ...(n.topics ?? [])]

// ── Comparing two spoken labels ───────────────────────────────────────────────
//
// `annotation-target.ts`'s vocabulary is shared with study-artifact's module
// anchor, whose suite pins its exact semantics — so the two extra liberties this
// resolver needs are LOCAL rather than pushed into the shared helpers:
//
//   · a parenthetical gloss is stripped. Models write "Recurrent Neural Networks
//     (RNNs) and LSTMs"; no lecture title carries the gloss, and left in, every
//     word inside it has to appear on the node too — which poisons the subset
//     test in both directions and was one of the two live-test failures.
//   · a trailing plural is folded. "Word Embeddings" and the topic "word
//     embedding" are one concept, and models pluralise freely.

const PARENTHETICAL = /\([^)]*\)/g

/** Normalised, minus any parenthetical gloss. */
const softLabel = (s: string) => normalizeLabel(s.replace(PARENTHETICAL, ' '))

/** Crudest possible stemmer, and deliberately so: only a trailing plural, only
 *  on a word long enough that dropping a letter can't invent a different one
 *  ("as" → "a"), and never on "ss" ("access" → "acces"). */
const singular = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)

/** A label as comparable words. */
const wordsOf = (s: string): string[] => softLabel(s).split(/\W+/).filter(Boolean).map(singular)

/** The whole label as one comparable string — for the exact tiers. */
const labelKey = (s: string) => wordsOf(s).join(' ')

const covers = (sup: ReadonlySet<string>, sub: readonly string[]): boolean =>
  sub.length > 0 && sub.every((w) => sup.has(w))

/** How confidently a label names a node — lower is better. A plain object, not
 *  a `const enum`, which `isolatedModules` forbids. */
const Tier = {
  ExactTitle: 0,
  ExactTopic: 1,
  /** The label names the node: every word of the label is on one of its names. */
  LabelNamesNode: 2,
  /** The node's name is a fragment of the label — weaker, since the label may be
   *  a whole sentence that merely mentions it. */
  NodeInsideLabel: 3,
} as const
type Tier = (typeof Tier)[keyof typeof Tier]

export interface RankedMatch {
  node: PathCandidate
  tier: Tier
  /** Words in the node's TITLE. Fewer is a tighter claim on the concept, which
   *  is why "Lecture 5: Seq2Seq and Attention" outranks "Vaswani et al. —
   *  Attention Is All You Need" for the label "attention". */
  titleWords: number
  /** Position in the caller's node list, which is course order. */
  index: number
}

/** Every node a label could name, best first. Empty when it names nothing. */
export function rankNodeMatches(
  label: string,
  nodes: readonly PathCandidate[],
): RankedMatch[] {
  const want = wordsOf(label)
  if (want.length === 0) return []
  const wantKey = want.join(' ')
  const wantSet = new Set(want)
  // Below this, a fragment ("AI", "ML") coincidence-matches unrelated titles —
  // so it gates the paraphrase tiers only. An exact match is exact at any length.
  const paraphrasable = softLabel(label).length >= MIN_LABEL_MATCH_LEN

  const hits: RankedMatch[] = []
  nodes.forEach((node, index) => {
    const titleWords = wordsOf(node.title).length
    let tier: Tier | undefined

    if (labelKey(node.title) === wantKey) tier = Tier.ExactTitle
    else if ((node.topics ?? []).some((t) => labelKey(t) === wantKey)) tier = Tier.ExactTopic
    else if (paraphrasable) {
      for (const l of labelsOf(node)) {
        if (softLabel(l).length < MIN_LABEL_MATCH_LEN) continue
        const have = wordsOf(l)
        if (have.length === 0) continue
        if (covers(new Set(have), want)) {
          tier = Tier.LabelNamesNode
          break
        }
        if (covers(wantSet, have)) tier = Tier.NodeInsideLabel
      }
    }

    if (tier !== undefined) hits.push({ node, tier, titleWords, index })
  })

  return hits.sort(
    (a, b) => a.tier - b.tier || a.titleWords - b.titleWords || a.index - b.index,
  )
}

/** Two candidates the ranking genuinely cannot separate. */
const deadHeat = (a: RankedMatch, b: RankedMatch) =>
  a.tier === b.tier && a.titleWords === b.titleWords

/**
 * Resolve one proposed concept to one node, or nothing.
 *
 * A dead heat is dropped: unlike the focus, a stop is optional, and putting one
 * on the wrong card tells the student to go revise material that is not the
 * prerequisite. Everything else takes the ranking's winner.
 */
export function matchNode(
  label: string,
  nodes: readonly PathCandidate[],
): PathCandidate | undefined {
  const ranked = rankNodeMatches(label, nodes)
  if (ranked.length === 0) return undefined
  if (ranked.length > 1 && deadHeat(ranked[0], ranked[1])) return undefined
  return ranked[0].node
}

/**
 * The course's own vocabulary — node titles and distinct topic labels, in course
 * order. Handed back with every refusal so the model can retry with names that
 * exist instead of guessing again (the same self-correcting shape
 * `leave_study_artifact` uses when it returns the real module names).
 */
export function courseVocabulary(nodes: readonly PathCandidate[], limit = 50): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    for (const label of labelsOf(node)) {
      const key = labelKey(label)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(label.trim())
      if (out.length >= limit) return out
    }
  }
  return out
}

/** The phrasings the tool is described for. Stripping one turns "what do I need
 *  to understand transformer attention?" into "transformer attention", which the
 *  ordinary matcher can then resolve. */
const LEAD_INS: RegExp[] = [
  /^what\s+(?:do|would)\s+i\s+need\s+(?:to\s+(?:know|understand|learn|get|grasp)\s+)?(?:before|first|for|to\s+get)?\s*/,
  /^what\s+should\s+i\s+(?:know|learn|study|review|understand)\s+(?:first\s+)?(?:before|for|to\s+understand)?\s*/,
  /^what\s+(?:leads?|builds?)\s+up\s+to\s+/,
  /^what\s+comes\s+before\s+/,
  /^what\s+are\s+the\s+(?:prereqs?|prerequisites?)\s+(?:for|of|to)\s+/,
  /^(?:the\s+)?(?:prereqs?|prerequisites?)\s+(?:for|of|to)\s+/,
  /^how\s+do\s+i\s+(?:get\s+to|work\s+up\s+to|understand|learn)\s+/,
  /^i\s+(?:want|need)\s+to\s+(?:understand|learn|get)\s+/,
]

/**
 * Resolve the concept the QUESTION is about.
 *
 * Two legs, because a question is not a label. First strip a known lead-in and
 * take the best node the remainder NAMES — a dead heat included, since no focus
 * means no map at all and the earliest of equals is still on the subject. That
 * leg deliberately ignores the weakest tier (a node name merely appearing inside
 * the text), because at that tier the text is a whole sentence and "tightest
 * title" is the wrong tie-break for it.
 *
 * The second leg is that tier, done properly: the most SPECIFIC node name
 * sitting word-for-word inside the question. When "attention" and "multi-head
 * attention" both appear in "I'm lost on multi-head attention", the longer name
 * is what the student asked about; the shorter card would light the wrong lens.
 */
export function matchFocus(
  question: string,
  nodes: readonly PathCandidate[],
): PathCandidate | undefined {
  const asked = normalizeLabel(question).replace(/[?.!]+$/, '').trim()
  if (!asked) return undefined

  let topic = asked
  for (const re of LEAD_INS) {
    const stripped = topic.replace(re, '').trim()
    if (stripped !== topic && stripped) {
      topic = stripped
      break
    }
  }
  const named = rankNodeMatches(topic, nodes).find((r) => r.tier < Tier.NodeInsideLabel)
  if (named) return named.node

  const askedWords = new Set(wordsOf(asked))
  let best: { node: PathCandidate; words: number } | undefined
  for (const n of nodes) {
    for (const label of labelsOf(n)) {
      if (softLabel(label).length < MIN_LABEL_MATCH_LEN) continue
      const have = wordsOf(label)
      if (!covers(askedWords, have)) continue
      if (!best || have.length > best.words) best = { node: n, words: have.length }
    }
  }
  return best?.node
}

/**
 * Put the surviving stops in prerequisite order.
 *
 * The professor's `prerequisite` edges are the only real ordering signal we
 * have, so when any exist among these stops they win: a topological sort with
 * the model's own order as the tie-break, so an unconstrained pair keeps the
 * sequence the model proposed. With no edges between them the model's order
 * stands unchanged — inventing an order from nothing would be a claim the graph
 * never made. A cycle (professors can draw one) leaves nodes unemitted by Kahn's
 * algorithm; those are appended in model order rather than dropped, because a
 * missing stop is a worse lie than a mis-ordered one.
 */
export function orderStops(stops: PathStop[], edges: readonly PrereqEdge[]): PathStop[] {
  const index = new Map(stops.map((s, i) => [s.nodeKey, i]))
  const inDegree = new Map(stops.map((s) => [s.nodeKey, 0]))
  const outgoing = new Map<string, string[]>()
  const seen = new Set<string>()

  for (const e of edges) {
    if (e.from === e.to) continue
    if (!index.has(e.from) || !index.has(e.to)) continue
    const pair = `${e.from}|${e.to}`
    if (seen.has(pair)) continue
    seen.add(pair)
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e.to])
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1)
  }
  if (seen.size === 0) return stops

  const queue = stops.filter((s) => inDegree.get(s.nodeKey) === 0).map((s) => s.nodeKey)
  const ordered: string[] = []
  const emitted = new Set<string>()
  while (queue.length > 0) {
    queue.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0))
    const key = queue.shift() as string
    ordered.push(key)
    emitted.add(key)
    for (const next of outgoing.get(key) ?? []) {
      const left = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, left)
      if (left === 0) queue.push(next)
    }
  }
  for (const s of stops) if (!emitted.has(s.nodeKey)) ordered.push(s.nodeKey)

  return ordered.map((key) => stops[index.get(key) as number])
}

/**
 * The whole resolution: focus from the question, stops from the proposed
 * concepts, ordered by the graph. Unmatched proposals are reported, not
 * invented; a proposal that resolves to the focus node itself is dropped (the
 * destination is not a step on the way to itself), as is a duplicate.
 */
export function resolveKnowledgePath(input: {
  question: string
  concepts: readonly ProposedConcept[]
  nodes: readonly PathCandidate[]
  prerequisiteEdges?: readonly PrereqEdge[]
}): ResolvedPath {
  const focusNode = matchFocus(input.question, input.nodes)
  const stops: PathStop[] = []
  const unmatched: string[] = []
  const claimed = new Set<string>(focusNode ? [focusNode.key] : [])

  for (const concept of input.concepts) {
    const hit = matchNode(concept.title, input.nodes)
    if (!hit) {
      unmatched.push(concept.title)
      continue
    }
    if (claimed.has(hit.key)) continue
    claimed.add(hit.key)
    stops.push({ nodeKey: hit.key, title: hit.title, why: concept.why })
  }

  return {
    focus: focusNode ? { nodeKey: focusNode.key, title: focusNode.title } : null,
    stops: orderStops(stops, input.prerequisiteEdges ?? []),
    unmatched,
  }
}
