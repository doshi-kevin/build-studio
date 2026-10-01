// The knowledge map's whole safety property is "LLM picks, the graph validates":
// the model writes concept TITLES and this resolver decides which — if any —
// real roadmap node each one names. Two failure modes are worth pinning, and
// both are silent:
//
//   1. A title resolving to the WRONG node. The student is then sent to revise
//      material that is not the prerequisite, with Athena's sentence naming a
//      card they are looking at. Exact-before-substring and the uniqueness
//      guards are what stop that, and each is one `find` away from collapsing.
//   2. A title resolving to NOTHING being papered over. An unmatched concept has
//      to disappear from the path AND be reported, or the tool ships a map that
//      quietly omits the step the model thought mattered most.
//
// Plus the ordering: prerequisite edges are the only real ordering signal, so
// when they exist they must beat the model's guess, and when they don't the
// model's order must survive untouched rather than being invented over.

import { describe, it, expect } from 'vitest'
import {
  courseVocabulary,
  matchFocus,
  matchNode,
  orderStops,
  resolveKnowledgePath,
  type PathCandidate,
  type PathStop,
} from '@/lib/roadmap/knowledge-path'

const node = (id: string, title: string, topics: string[] = []): PathCandidate => ({
  key: `module_item:${id}`,
  title,
  topics,
})

// "Attention Is All You Need" sits BEFORE "Attention" on purpose: substring-first
// resolves the short title to the long card, which is the bug annotation-target's
// exact-first rule exists to fix. Fixture order is the test.
const NODES: PathCandidate[] = [
  node('n1', 'Tokenization', ['tokenization', 'subword units']),
  node('n2', 'Word Embeddings', ['embeddings', 'word2vec']),
  node('n3', 'Recurrent Neural Networks', ['rnn']),
  node('n4', 'Attention Is All You Need', ['transformers', 'multi-head attention']),
  node('n5', 'Attention', ['attention']),
]

const key = (id: string) => `module_item:${id}`

describe('matchNode — a proposed title finds its node, or none', () => {
  it('prefers an exact title over a longer one that merely contains it', () => {
    // The long card comes first in the list; only exact-across-all-nodes-first
    // sends "Attention" to its own card.
    expect(matchNode('Attention', NODES)?.key).toBe(key('n5'))
    expect(matchNode('  aTTention ', NODES)?.key).toBe(key('n5'))
  })

  it('falls back to a title containing the label, word for word', () => {
    expect(matchNode('Is All You Need', NODES)?.key).toBe(key('n4'))
  })

  it('matches a topic the node is tagged with, which is often what the model names', () => {
    // "word2vec" is on no title anywhere — the topic leg is the only way there,
    // and it is the realistic case: models name concepts, not lecture titles.
    expect(matchNode('word2vec', NODES)?.key).toBe(key('n2'))
    // And an exact topic SHORTER than the paraphrase leg's floor: "rnn" is how a
    // model names that lecture, and the exact-topic leg is the only one allowed
    // to match something that small.
    expect(matchNode('rnn', NODES)?.key).toBe(key('n3'))
  })

  it('accepts a word-for-word paraphrase of a title', () => {
    expect(matchNode('recurrent networks', NODES)?.key).toBe(key('n3'))
  })

  it('refuses a match that is not on a word boundary', () => {
    // A bare `includes` would find this inside "Word Embeddings" and put a stop
    // on the wrong lecture. The probe has to clear MIN_LABEL_MATCH_LEN to reach
    // the paraphrase leg at all — a shorter one ("bed") never gets past the
    // length guard, so it would pass even with the word-boundary rule deleted.
    expect(matchNode('bedding', NODES)).toBeUndefined()
    // The length guard itself, on its own footing.
    expect(matchNode('bed', NODES)).toBeUndefined()
  })

  it('drops a STOP whose top two candidates are dead level', () => {
    // Same tier, same title tightness — the ranking genuinely cannot separate
    // them, and a stop on the wrong card sends the student to revise material
    // that is not the prerequisite. A dropped stop is the cheaper mistake.
    const ambiguous = [node('a', 'Neural Machine Translation'), node('b', 'Neural Language Models')]
    expect(matchNode('neural', ambiguous)).toBeUndefined()
  })

  it('picks the tightest title when the candidates are NOT level', () => {
    // The live failure, verbatim: "attention" is a whole-word subset of all four
    // of these. Dropping on ambiguity lost the focus on the single most obvious
    // question the tool exists for, so the tightest title wins instead — the
    // lecture, not the two reference readings or the explainer video.
    const attention = [
      node('a', 'Lecture 5: Seq2Seq and Attention'),
      node('b', 'Attention as a soft lookup table'),
      node('c', 'Vaswani et al. — Attention Is All You Need'),
      node('d', '3Blue1Brown — Attention in transformers, step by step'),
    ]
    expect(matchNode('attention', attention)?.key).toBe(key('a'))
  })

  it('ignores a parenthetical gloss, which no lecture title carries', () => {
    // "(RNNs)" left in means every word of the gloss must appear on the node too,
    // which is what made this real model output match nothing at all.
    expect(matchNode('Recurrent Neural Networks (RNNs)', NODES)?.key).toBe(key('n3'))
  })

  it('folds a trailing plural, because models pluralise and topic labels do not', () => {
    const tagged = [node('a', 'Lecture 3: Word Vectors', ['word embedding'])]
    expect(matchNode('Word Embeddings', tagged)?.key).toBe(key('a'))
    // …and not by chopping any trailing s: "access" must not become "acces".
    expect(matchNode('access', [node('b', 'Data Access Patterns')])?.key).toBe(key('b'))
  })

  it('drops a concept that names nothing in the course', () => {
    expect(matchNode('Quantum Chromodynamics', NODES)).toBeUndefined()
  })
})

describe('courseVocabulary — what a refusal hands back', () => {
  it('lists titles and topics in course order, without repeating a name', () => {
    const vocab = courseVocabulary(NODES)
    expect(vocab.slice(0, 4)).toEqual([
      'Tokenization',
      'subword units',
      'Word Embeddings',
      'embeddings',
    ])
    // "Attention" is n5's title AND n5's topic, and "attention" already appeared
    // — a menu that repeats itself wastes the model's one retry.
    expect(vocab.filter((v) => v.toLowerCase() === 'attention')).toHaveLength(1)
  })

  it('stays bounded — the correction is a menu, not the whole course', () => {
    const many = Array.from({ length: 80 }, (_, i) => node(`x${i}`, `Lecture ${i}`))
    expect(courseVocabulary(many)).toHaveLength(50)
  })
})

describe('matchFocus — the concept the question is about', () => {
  it('strips the lead-in and resolves what is left', () => {
    expect(matchFocus('What do I need to understand attention?', NODES)?.key).toBe(key('n5'))
    expect(matchFocus('what should I learn before transformers', NODES)?.key).toBe(key('n4'))
    expect(matchFocus('what leads up to recurrent neural networks?', NODES)?.key).toBe(key('n3'))
  })

  it('finds a node name sitting inside a question it has no lead-in for', () => {
    expect(matchFocus('honestly, tokenization is confusing me', NODES)?.key).toBe(key('n1'))
  })

  it('takes the most specific name when several appear in the question', () => {
    // No lead-in to strip, and both "attention" (n5) and "multi-head attention"
    // (n4's topic) sit inside the sentence — ambiguous to the ordinary matcher.
    // The student asked about the longer one; the short card is the wrong lens.
    expect(matchFocus("I'm lost on multi-head attention", NODES)?.key).toBe(key('n4'))
  })

  it('resolves the four-attention course that made the tool refuse in the live test', () => {
    const attention = [
      node('a', 'Lecture 5: Seq2Seq and Attention', ['attention']),
      node('b', 'Attention as a soft lookup table', ['attention']),
      node('c', 'Vaswani et al. — Attention Is All You Need', ['attention']),
      node('d', '3Blue1Brown — Attention in transformers, step by step', ['attention']),
    ]
    // All four carry the topic "attention" exactly, so the tier ties; the
    // tightest title breaks it in favour of the lecture.
    expect(matchFocus('What do I need to understand attention?', attention)?.key).toBe(key('a'))
  })

  it('takes the earliest of dead-level candidates rather than giving up', () => {
    // The opposite call from `matchNode`, which drops this same input: no focus
    // means no map at all, so a slightly-off destination beats refusing — the
    // student can see which card was lit and Athena named it.
    const level = [node('a', 'Neural Machine Translation'), node('b', 'Neural Language Models')]
    expect(matchNode('neural', level)).toBeUndefined()
    expect(matchFocus('what leads up to neural', level)?.key).toBe(key('a'))
  })

  it('returns nothing when the question names no material — the honest-failure signal', () => {
    expect(matchFocus('what do I need to understand quantum chromodynamics?', NODES)).toBeUndefined()
  })
})

describe('orderStops — the graph beats the guess, and only the graph', () => {
  const stop = (id: string): PathStop => ({ nodeKey: key(id), title: id, why: 'because' })

  it('leaves the model order alone when no prerequisite edge connects the stops', () => {
    // Inventing an order from nothing would be a claim the roadmap never made.
    const stops = [stop('n3'), stop('n1'), stop('n2')]
    expect(orderStops(stops, []).map((s) => s.nodeKey)).toEqual([key('n3'), key('n1'), key('n2')])
  })

  it('topologically reorders when the professor drew the prerequisites', () => {
    const stops = [stop('n3'), stop('n2'), stop('n1')]
    const edges = [
      { from: key('n1'), to: key('n2') },
      { from: key('n2'), to: key('n3') },
    ]
    expect(orderStops(stops, edges).map((s) => s.nodeKey)).toEqual([key('n1'), key('n2'), key('n3')])
  })

  it('keeps the model order for pairs the graph says nothing about', () => {
    // n1 → n3 is the only constraint; n2 is unconstrained and must not be
    // shuffled by the sort's internal bookkeeping.
    const stops = [stop('n2'), stop('n3'), stop('n1')]
    const ordered = orderStops(stops, [{ from: key('n1'), to: key('n3') }]).map((s) => s.nodeKey)
    expect(ordered).toEqual([key('n2'), key('n1'), key('n3')])
  })

  it('ignores an edge whose other end is not on this path', () => {
    const stops = [stop('n2'), stop('n1')]
    const ordered = orderStops(stops, [{ from: key('n9'), to: key('n2') }]).map((s) => s.nodeKey)
    expect(ordered).toEqual([key('n2'), key('n1')])
  })

  it('loses no stop to a cycle a professor drew', () => {
    // Kahn emits nothing from a cycle. Dropping those stops would silently
    // shorten a real path — worse than showing it in the model's order.
    const stops = [stop('n1'), stop('n2')]
    const cyclic = [
      { from: key('n1'), to: key('n2') },
      { from: key('n2'), to: key('n1') },
    ]
    expect(orderStops(stops, cyclic).map((s) => s.nodeKey)).toEqual([key('n1'), key('n2')])
  })
})

describe('resolveKnowledgePath — the whole resolution', () => {
  const concept = (title: string) => ({ title, why: `why ${title}` })

  it('keeps only the concepts that exist, and reports the ones that do not', () => {
    const resolved = resolveKnowledgePath({
      question: 'what do I need to understand attention?',
      concepts: [concept('Tokenization'), concept('Latent Diffusion'), concept('word2vec')],
      nodes: NODES,
    })

    expect(resolved.focus).toEqual({ nodeKey: key('n5'), title: 'Attention' })
    expect(resolved.stops.map((s) => s.nodeKey)).toEqual([key('n1'), key('n2')])
    // The why line rides through untouched — it is the only model prose the
    // payload keeps, and the answer repeats it back to the student.
    expect(resolved.stops[0].why).toBe('why Tokenization')
    expect(resolved.unmatched).toEqual(['Latent Diffusion'])
  })

  it('drops a proposed stop that IS the destination', () => {
    // Models routinely list the queried concept as its own last prerequisite.
    // Leaving it in would draw a stop on the focus card and count it twice.
    const resolved = resolveKnowledgePath({
      question: 'what leads up to attention?',
      concepts: [concept('Tokenization'), concept('Word Embeddings'), concept('Attention')],
      nodes: NODES,
    })

    expect(resolved.stops.map((s) => s.title)).toEqual(['Tokenization', 'Word Embeddings'])
    expect(resolved.unmatched).toEqual([])
  })

  it('dedupes two concept titles that resolve to the same node', () => {
    const resolved = resolveKnowledgePath({
      question: 'what do I need to understand attention?',
      concepts: [concept('Tokenization'), concept('subword units'), concept('Word Embeddings')],
      nodes: NODES,
    })

    expect(resolved.stops.map((s) => s.nodeKey)).toEqual([key('n1'), key('n2')])
  })

  it('orders the survivors by the professor edges, not the model order', () => {
    const resolved = resolveKnowledgePath({
      question: 'what do I need to understand attention?',
      concepts: [concept('Recurrent Neural Networks'), concept('Word Embeddings'), concept('Tokenization')],
      nodes: NODES,
      prerequisiteEdges: [
        { from: key('n1'), to: key('n2') },
        { from: key('n2'), to: key('n3') },
      ],
    })

    expect(resolved.stops.map((s) => s.title)).toEqual([
      'Tokenization',
      'Word Embeddings',
      'Recurrent Neural Networks',
    ])
  })

  it('reports a path too thin to draw instead of padding it', () => {
    // One survivor is the tool's correction trigger — the resolver's job is to
    // hand back the truth (one stop, two names that matched nothing), not to
    // reach for a second node.
    const resolved = resolveKnowledgePath({
      question: 'what do I need to understand attention?',
      concepts: [concept('Tokenization'), concept('Latent Diffusion'), concept('Kalman Filters')],
      nodes: NODES,
    })

    expect(resolved.stops).toHaveLength(1)
    expect(resolved.unmatched).toEqual(['Latent Diffusion', 'Kalman Filters'])
  })

  it('has no focus, and so no path, when the question is off the map', () => {
    const resolved = resolveKnowledgePath({
      question: 'what do I need to understand renaissance fresco technique?',
      concepts: [concept('Tokenization'), concept('Word Embeddings')],
      nodes: NODES,
    })

    expect(resolved.focus).toBeNull()
    // The stops still resolve — the tool refuses on the missing focus, and the
    // resolver reporting both halves is what lets it say which one failed.
    expect(resolved.stops).toHaveLength(2)
  })
})
