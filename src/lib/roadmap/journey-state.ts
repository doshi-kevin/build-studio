/**
 * Roadmap journey-state engine — pure, signal-driven, client-safe.
 *
 * Maps a single roadmap node to a *student's* journey state by combining two
 * signals:
 *   1. topic mastery — the student's score on the node's topics, read from the
 *      curated Topic Mastery layer (`skill_mastery`, joined to `topics` by name;
 *      see src/lib/topics). Replaces the old quiz-tag string-match.
 *   2. explicit check-off — stored per student in `roadmap_progress` (wins over inferred)
 *
 * Inferred-first: empty signal never punishes (defaults to not_started); an
 * explicit check-off overrides; topic mastery drives the four-state colour
 * (≥80 mastered, <50 review-next).
 *
 * No DB / server imports — safe to use in client components and unit tests. The
 * per-student topic-score map is built server-side by buildStudentSkillScores
 * (src/lib/topics/roadmap-mastery.ts) and passed in.
 */

export const JOURNEY_STATES = ['mastered', 'review_next', 'in_progress', 'not_started'] as const
export type JourneyState = (typeof JOURNEY_STATES)[number]

/** Accuracy at/above this is "mastered" (matches calculateSkillInsights strengths). */
export const MASTERY_THRESHOLD = 80
/** Accuracy below this is "review next" (matches calculateSkillInsights weaknesses). */
export const REVIEW_THRESHOLD = 50

export interface NodeJourney {
  state: JourneyState
  /** Mastery 0–100 (avg quiz accuracy over the node's measured topics); null when no quiz signal. */
  pct: number | null
  /** Node topics with a quiz signal that the student has mastered (accuracy ≥ MASTERY_THRESHOLD). */
  mastered: number
  /** Node topics that carry a quiz signal at all (the measurable denominator). */
  measured: number
}

export interface NodeJourneyInput {
  /** The node's topic labels (content.topics for auto items, or manual lecture topics). */
  topics: string[]
  /** This student's per-tag accuracy (0–100), keyed by tag lowercased+trimmed. */
  topicAccuracy: Map<string, number>
  /** Student explicitly checked the node off (roadmap_progress) — overrides inferred state. */
  checkedOff?: boolean
  /** A non-quiz completion signal: item completion or professor-set status === 'complete'/'in_progress'. */
  hasProgress?: boolean
}

/** Normalise a topic/tag label so node topics and quiz tags join case-insensitively. */
export function normalizeTopicKey(label: string): string {
  return label.trim().toLowerCase()
}

/**
 * Compute one node's journey state for one student. Pure — same input, same output.
 */
export function computeNodeJourney(input: NodeJourneyInput): NodeJourney {
  const accuracies: number[] = []
  for (const topic of input.topics ?? []) {
    const acc = input.topicAccuracy.get(normalizeTopicKey(topic))
    if (acc !== undefined) accuracies.push(acc)
  }

  const measured = accuracies.length
  const mastered = accuracies.filter((a) => a >= MASTERY_THRESHOLD).length
  const pct = measured > 0
    ? Math.round(accuracies.reduce((sum, a) => sum + a, 0) / measured)
    : null

  // Explicit check-off wins over any inferred state.
  if (input.checkedOff) {
    return { state: 'mastered', pct, mastered, measured }
  }

  // Quiz signal present → it drives the colour.
  if (pct !== null) {
    const state: JourneyState =
      pct >= MASTERY_THRESHOLD ? 'mastered'
        : pct < REVIEW_THRESHOLD ? 'review_next'
          : 'in_progress'
    return { state, pct, mastered, measured }
  }

  // No quiz signal — completion/status is a weak "in progress (unverified)" hint.
  if (input.hasProgress) {
    return { state: 'in_progress', pct: null, mastered, measured }
  }

  // No signal at all — never punish a student for a node with no data.
  return { state: 'not_started', pct: null, mastered, measured }
}

/** Collect the journey states for a set of node keys, in order, skipping any missing. */
export function statesForKeys(
  nodes: Record<string, NodeJourney>,
  keys: string[],
): JourneyState[] {
  const out: JourneyState[] = []
  for (const key of keys) {
    const j = nodes[key]
    if (j) out.push(j.state)
  }
  return out
}

export interface StudentJourneySummary {
  /** Overall mastery 0–100 (avg of node pct over nodes with a quiz signal); null if none. */
  masteryPct: number | null
  /** Count of nodes in each state. */
  counts: Record<JourneyState, number>
  /** Glanceable label derived from masteryPct. */
  overall: 'excelling' | 'on_track' | 'needs_support' | 'not_started'
}

/** Mastery at/above this reads as "excelling"; at/above ON_TRACK_THRESHOLD as "on track". */
export const EXCELLING_THRESHOLD = 80
export const ON_TRACK_THRESHOLD = 55

/** The one masteryPct → glanceable-band mapping — every surface that labels a
 *  mastery figure (roster rows, the journey summary) must use this, so the
 *  bands can never drift apart. */
export function overallFromMasteryPct(masteryPct: number | null): StudentJourneySummary['overall'] {
  return masteryPct === null ? 'not_started'
    : masteryPct >= EXCELLING_THRESHOLD ? 'excelling'
      : masteryPct >= ON_TRACK_THRESHOLD ? 'on_track'
        : 'needs_support'
}

/**
 * Roll a student's per-node journeys up into an overall summary for the roster.
 */
export function summarizeStudentJourney(nodes: NodeJourney[]): StudentJourneySummary {
  const counts: Record<JourneyState, number> = {
    mastered: 0,
    review_next: 0,
    in_progress: 0,
    not_started: 0,
  }
  const measuredPcts: number[] = []
  for (const node of nodes) {
    counts[node.state] += 1
    if (node.pct !== null) measuredPcts.push(node.pct)
  }

  const masteryPct = measuredPcts.length > 0
    ? Math.round(measuredPcts.reduce((sum, p) => sum + p, 0) / measuredPcts.length)
    : null

  return { masteryPct, counts, overall: overallFromMasteryPct(masteryPct) }
}

export interface JourneyNodeInput {
  /** Canvas key `${type}:${id}` — the id segment is what roadmap_progress check-offs key on. */
  key: string
  topics: string[]
}

export interface StudentJourney {
  nodes: Record<string, NodeJourney>
  summary: StudentJourneySummary
}

/**
 * Compute one student's full journey over a set of nodes from a prebuilt
 * per-topic score map (normalised topic name → 0–100, from `skill_mastery`).
 * Each node's topics are looked up in the map; explicit check-offs override.
 * Shared by the professor (per enrolled student) and the student (themselves)
 * so both produce identical results. Pure.
 */
export function journeyFromTopicAccuracy(
  nodeRefs: JourneyNodeInput[],
  topicAccuracy: Map<string, number>,
  checkedOffIds: Set<string> = new Set(),
): StudentJourney {
  const nodes: Record<string, NodeJourney> = {}
  const list: NodeJourney[] = []
  for (const ref of nodeRefs) {
    const rawId = ref.key.slice(ref.key.indexOf(':') + 1)
    const journey = computeNodeJourney({
      topics: ref.topics,
      topicAccuracy,
      checkedOff: checkedOffIds.has(rawId),
    })
    nodes[ref.key] = journey
    list.push(journey)
  }
  return { nodes, summary: summarizeStudentJourney(list) }
}

export interface WeekStruggle {
  /** (student, node) pairs in this week the student has engaged with (state ≠ not_started). */
  engaged: number
  /** Engaged pairs where the student is stuck (review_next or in_progress). */
  struggling: number
  /** struggling / engaged as 0–100; null when nobody has engaged yet. */
  pct: number | null
  /** Head-count view of the same week: students who engaged at all, and how many
   *  are still stuck on at least one of its nodes. Always ≤ the class size, so
   *  this — not the pooled pair counts — is what "N of M stuck here" may claim. */
  students: { engaged: number; struggling: number }
}

/**
 * Class-struggle aggregate for one week/module: across its nodes and every
 * student, how much of the engaged class is stuck (not yet mastered).
 *
 * Reported two ways, because the two consumers need different things. The heat
 * overlay wants intensity, so `pct` pools (student × node) pairs rather than
 * averaging per-node rates — that way a week with one hard lecture isn't diluted
 * by its easy ones. An annotation saying "N of M stuck here" is read as people,
 * so `students` counts heads instead: pooled pairs exceed the class size (6
 * students × 2 nodes = 12) and made the note claim a roster that doesn't exist.
 * Pure; same input, same output.
 */
export function computeWeekStruggle(
  nodeKeys: string[],
  studentNodes: Record<string, NodeJourney>[],
): WeekStruggle {
  let engaged = 0
  let struggling = 0
  let sEngaged = 0
  let sStruggling = 0
  for (const nodes of studentNodes) {
    let touched = false
    let stuck = false
    for (const key of nodeKeys) {
      const j = nodes[key]
      if (!j || j.state === 'not_started') continue
      engaged += 1
      touched = true
      if (j.state === 'review_next' || j.state === 'in_progress') {
        struggling += 1
        stuck = true
      }
    }
    if (touched) sEngaged += 1
    if (stuck) sStruggling += 1
  }
  return {
    engaged,
    struggling,
    pct: engaged > 0 ? Math.round((struggling / engaged) * 100) : null,
    students: { engaged: sEngaged, struggling: sStruggling },
  }
}
