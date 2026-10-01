// Tests for the roadmap journey-state engine (computeNodeJourney + summarizeStudentJourney).
// Covers the four-state thresholds, explicit check-off override, the "no signal never
// punishes" default, completion-only fallback, and the per-student roll-up labels.

import { describe, it, expect } from 'vitest'
import {
  computeNodeJourney,
  summarizeStudentJourney,
  computeWeekStruggle,
  journeyFromTopicAccuracy,
  statesForKeys,
  normalizeTopicKey,
  MASTERY_THRESHOLD,
  REVIEW_THRESHOLD,
  type NodeJourney,
} from '@/lib/roadmap/journey-state'

/** Build a one-node journey in a given state (pct only matters for roll-ups). */
function node(state: NodeJourney['state']): NodeJourney {
  return { state, pct: state === 'not_started' ? null : 70, mastered: 0, measured: 1 }
}

/** Build a topic-accuracy map keyed the same way the engine looks topics up. */
function acc(entries: Record<string, number>): Map<string, number> {
  const m = new Map<string, number>()
  for (const [tag, value] of Object.entries(entries)) m.set(normalizeTopicKey(tag), value)
  return m
}

describe('computeNodeJourney', () => {
  it('marks a node mastered when average topic accuracy ≥ 80', () => {
    const r = computeNodeJourney({
      topics: ['Self-Attention', 'Multi-Head Attention'],
      topicAccuracy: acc({ 'self-attention': 90, 'multi-head attention': 86 }),
    })
    expect(r.state).toBe('mastered')
    expect(r.pct).toBe(88)
    expect(r.mastered).toBe(2)
    expect(r.measured).toBe(2)
  })

  it('marks a node review_next when average accuracy < 50', () => {
    const r = computeNodeJourney({
      topics: ['KNN', 'Cross-Entropy'],
      topicAccuracy: acc({ knn: 40, 'cross-entropy': 48 }),
    })
    expect(r.state).toBe('review_next')
    expect(r.pct).toBe(44)
  })

  it('marks a node in_progress for accuracy in the 50–80 band', () => {
    const r = computeNodeJourney({
      topics: ['Convolutions'],
      topicAccuracy: acc({ convolutions: 64 }),
    })
    expect(r.state).toBe('in_progress')
    expect(r.pct).toBe(64)
  })

  it('treats the threshold boundaries inclusively (80 = mastered, 50 = in_progress)', () => {
    expect(
      computeNodeJourney({ topics: ['t'], topicAccuracy: acc({ t: MASTERY_THRESHOLD }) }).state,
    ).toBe('mastered')
    expect(
      computeNodeJourney({ topics: ['t'], topicAccuracy: acc({ t: REVIEW_THRESHOLD }) }).state,
    ).toBe('in_progress')
    expect(
      computeNodeJourney({ topics: ['t'], topicAccuracy: acc({ t: REVIEW_THRESHOLD - 1 }) }).state,
    ).toBe('review_next')
  })

  it('only averages topics that carry a quiz signal (ignores unmeasured topics)', () => {
    const r = computeNodeJourney({
      topics: ['Measured', 'Unmeasured'],
      topicAccuracy: acc({ measured: 90 }),
    })
    expect(r.measured).toBe(1)
    expect(r.pct).toBe(90)
    expect(r.state).toBe('mastered')
  })

  it('explicit check-off overrides inferred state, even a weak one', () => {
    const r = computeNodeJourney({
      topics: ['KNN'],
      topicAccuracy: acc({ knn: 30 }), // would be review_next
      checkedOff: true,
    })
    expect(r.state).toBe('mastered')
  })

  it('defaults to not_started with no signal at all (never punishes empty data)', () => {
    const r = computeNodeJourney({ topics: ['Anything'], topicAccuracy: acc({}) })
    expect(r.state).toBe('not_started')
    expect(r.pct).toBeNull()
    expect(r.measured).toBe(0)
  })

  it('falls back to in_progress when there is completion but no quiz signal', () => {
    const r = computeNodeJourney({
      topics: ['Anything'],
      topicAccuracy: acc({}),
      hasProgress: true,
    })
    expect(r.state).toBe('in_progress')
    expect(r.pct).toBeNull()
  })

  it('prefers the quiz signal over a weak completion hint', () => {
    const r = computeNodeJourney({
      topics: ['KNN'],
      topicAccuracy: acc({ knn: 40 }),
      hasProgress: true,
    })
    expect(r.state).toBe('review_next')
  })

  it('matches topics to tags case- and whitespace-insensitively', () => {
    const r = computeNodeJourney({
      topics: ['  Self-Attention  '],
      topicAccuracy: acc({ 'SELF-ATTENTION': 95 }),
    })
    expect(r.state).toBe('mastered')
  })
})

describe('summarizeStudentJourney', () => {
  const nodes: NodeJourney[] = [
    { state: 'mastered', pct: 90, mastered: 2, measured: 2 },
    { state: 'review_next', pct: 40, mastered: 0, measured: 2 },
    { state: 'not_started', pct: null, mastered: 0, measured: 0 },
  ]

  it('averages mastery only over nodes with a quiz signal', () => {
    const s = summarizeStudentJourney(nodes)
    expect(s.masteryPct).toBe(65) // (90 + 40) / 2, the null node excluded
  })

  it('counts nodes by state', () => {
    const s = summarizeStudentJourney(nodes)
    expect(s.counts).toEqual({ mastered: 1, review_next: 1, in_progress: 0, not_started: 1 })
  })

  it('labels overall standing from mastery (excelling / on_track / needs_support)', () => {
    expect(summarizeStudentJourney([{ state: 'mastered', pct: 92, mastered: 1, measured: 1 }]).overall).toBe('excelling')
    expect(summarizeStudentJourney([{ state: 'in_progress', pct: 60, mastered: 0, measured: 1 }]).overall).toBe('on_track')
    expect(summarizeStudentJourney([{ state: 'review_next', pct: 35, mastered: 0, measured: 1 }]).overall).toBe('needs_support')
  })

  it('labels a student with no quiz signal as not_started rather than needs_support', () => {
    const s = summarizeStudentJourney([{ state: 'not_started', pct: null, mastered: 0, measured: 0 }])
    expect(s.masteryPct).toBeNull()
    expect(s.overall).toBe('not_started')
  })
})

describe('computeWeekStruggle', () => {
  const KEYS = ['module_item:a', 'module_item:b']

  it('pools (student × node) pairs: counts engaged and struggling across the week', () => {
    const students = [
      { 'module_item:a': node('mastered'), 'module_item:b': node('review_next') },
      { 'module_item:a': node('in_progress'), 'module_item:b': node('mastered') },
    ]
    const r = computeWeekStruggle(KEYS, students)
    expect(r.engaged).toBe(4) // all four pairs have a signal
    expect(r.struggling).toBe(2) // one review_next + one in_progress
    expect(r.pct).toBe(50)
  })

  it('ignores not_started pairs (never punishes nodes nobody has reached)', () => {
    const students = [
      { 'module_item:a': node('mastered'), 'module_item:b': node('not_started') },
      { 'module_item:a': node('not_started'), 'module_item:b': node('not_started') },
    ]
    const r = computeWeekStruggle(KEYS, students)
    expect(r.engaged).toBe(1)
    expect(r.struggling).toBe(0)
    expect(r.pct).toBe(0)
  })

  it('returns null pct when no one has engaged with the week', () => {
    const r = computeWeekStruggle(KEYS, [{ 'module_item:a': node('not_started') }])
    expect(r.engaged).toBe(0)
    expect(r.pct).toBeNull()
  })

  it('skips nodes a student has no entry for', () => {
    const r = computeWeekStruggle(KEYS, [{ 'module_item:a': node('review_next') }])
    expect(r.engaged).toBe(1)
    expect(r.struggling).toBe(1)
    expect(r.pct).toBe(100)
  })

  it('counts heads separately, so student totals never exceed the class size', () => {
    // 3 students × 2 nodes = 6 pooled pairs, but only 3 people: a note saying
    // "N of M stuck here" must read M as 3, not 6.
    const students = [
      { 'module_item:a': node('review_next'), 'module_item:b': node('in_progress') }, // stuck on both
      { 'module_item:a': node('mastered'), 'module_item:b': node('review_next') }, // stuck on one
      { 'module_item:a': node('mastered'), 'module_item:b': node('mastered') }, // fine
    ]
    const r = computeWeekStruggle(KEYS, students)
    expect(r.engaged).toBe(6) // pooled pairs, for the heat overlay
    expect(r.students).toEqual({ engaged: 3, struggling: 2 })
    expect(r.students.engaged).toBeLessThanOrEqual(students.length)
  })

  it('does not count a student who has not reached the week at all', () => {
    const students = [
      { 'module_item:a': node('in_progress'), 'module_item:b': node('not_started') },
      { 'module_item:a': node('not_started'), 'module_item:b': node('not_started') },
    ]
    expect(computeWeekStruggle(KEYS, students).students).toEqual({ engaged: 1, struggling: 1 })
  })
})

describe('journeyFromTopicAccuracy', () => {
  const refs = [
    { key: 'module_item:a', topics: ['Self-Attention'] },
    { key: 'module_item:b', topics: ['KNN'] },
    { key: 'module_item:c', topics: ['Untracked Topic'] },
  ]
  // Topic Mastery scores keyed by normalised topic name (the new signal source).
  const topicAccuracy = new Map<string, number>([
    [normalizeTopicKey('Self-Attention'), 100],
    [normalizeTopicKey('KNN'), 0],
  ])

  it('derives each node state from the student’s topic mastery on its topics', () => {
    const { nodes } = journeyFromTopicAccuracy(refs, topicAccuracy)
    expect(nodes['module_item:a'].state).toBe('mastered') // 100
    expect(nodes['module_item:b'].state).toBe('review_next') // 0
    expect(nodes['module_item:c'].state).toBe('not_started') // no mastery signal
  })

  it('applies an explicit check-off (by raw node id) as a mastered override', () => {
    const { nodes } = journeyFromTopicAccuracy(refs, topicAccuracy, new Set(['b']))
    expect(nodes['module_item:b'].state).toBe('mastered') // was review_next, checked off
  })

  it('rolls the nodes up into a summary', () => {
    const { summary } = journeyFromTopicAccuracy(refs, topicAccuracy)
    expect(summary.counts.mastered).toBe(1)
    expect(summary.counts.review_next).toBe(1)
    expect(summary.counts.not_started).toBe(1)
    expect(summary.masteryPct).toBe(50) // avg of 100 and 0 over the two measured nodes
  })
})

describe('statesForKeys (class-lens roster pip row)', () => {
  const nodes = {
    'module_item:a': node('mastered'),
    'module_item:b': node('review_next'),
    'module_item:c': node('in_progress'),
  }

  it('follows the order of the keys asked for, not the map', () => {
    expect(statesForKeys(nodes, ['module_item:c', 'module_item:a'])).toEqual(['in_progress', 'mastered'])
  })

  // The pip row renders one pip per returned state, so a key the student has no
  // entry for must drop out rather than emit a placeholder — otherwise every pip
  // after the gap reads as belonging to the wrong node.
  it('skips keys with no entry instead of emitting a placeholder', () => {
    expect(statesForKeys(nodes, ['module_item:a', 'module_item:missing', 'module_item:b'])).toEqual([
      'mastered',
      'review_next',
    ])
  })

  it('returns [] for no keys and for a week whose nodes are all missing', () => {
    expect(statesForKeys(nodes, [])).toEqual([])
    expect(statesForKeys({}, ['module_item:a'])).toEqual([])
  })
})
