// C14's ranking is the part that can be quietly wrong: every input is already
// on the challenge board, so a bad match doesn't error — it just proposes the
// wrong thing confidently, which is worse. The edges worth pinning are the ones
// where "no answer" is the correct answer, and the deadline ordering that makes
// the proposal actionable rather than merely relevant.

import { describe, it, expect } from 'vitest'
import { rankChallenges, type ChallengeCandidate } from '@/lib/ai/student-tutor/challenge-match'

const NOW = '2026-07-31T12:00:00.000Z'
const inDays = (n: number) => new Date(Date.parse(NOW) + n * 86_400_000).toISOString()

const SKILLS = { 'skill-graphs': 'Graph Traversal', 'skill-nlp': 'Tokenization' }

function candidate(over: Partial<ChallengeCandidate> & { id: string }): ChallengeCandidate {
  return {
    title: over.id,
    points: 10,
    bonusPoints: 0,
    dueAt: null,
    difficulty: 'medium',
    skillIds: ['skill-graphs'],
    ...over,
  }
}

function rank(over: Partial<Parameters<typeof rankChallenges>[0]> = {}) {
  return rankChallenges({
    candidates: [candidate({ id: 'c1' })],
    strongSkillIds: ['skill-graphs'],
    skillNameById: SKILLS,
    claimedChallengeIds: [],
    now: NOW,
    ...over,
  })
}

describe('rankChallenges — when there is nothing to propose', () => {
  it('reports no_open_challenges rather than proposing a closed one', () => {
    const result = rank({ candidates: [candidate({ id: 'c1', dueAt: inDays(-1) })] })
    expect(result).toEqual({ matched: false, reason: 'no_open_challenges' })
  })

  it('treats an already-claimed challenge as not on offer', () => {
    expect(rank({ claimedChallengeIds: ['c1'] })).toEqual({
      matched: false,
      reason: 'no_open_challenges',
    })
  })

  it('distinguishes "nothing at mastery yet" from "nothing matches"', () => {
    expect(rank({ strongSkillIds: [] })).toEqual({ matched: false, reason: 'no_strong_skills' })
    expect(rank({ strongSkillIds: ['skill-nlp'] })).toEqual({
      matched: false,
      reason: 'no_matching_challenge',
    })
  })
})

describe('rankChallenges — ordering', () => {
  it('puts the strongest match first, then the soonest deadline', () => {
    const result = rank({
      candidates: [
        candidate({ id: 'later', dueAt: inDays(10) }),
        candidate({ id: 'sooner', dueAt: inDays(2) }),
        candidate({ id: 'both-skills', dueAt: inDays(30), skillIds: ['skill-graphs', 'skill-nlp'] }),
      ],
      strongSkillIds: ['skill-graphs', 'skill-nlp'],
    })

    expect(result.matched).toBe(true)
    if (!result.matched) return
    // Two matched skills beats a nearer deadline — that's the claim the answer
    // makes ("this plays to your strengths"), not "this is due first".
    expect(result.top.id).toBe('both-skills')
    expect(result.top.matchedSkills).toEqual(['Graph Traversal', 'Tokenization'])
    expect(result.alternatives.map((a) => a.id)).toEqual(['sooner', 'later'])
  })

  it('sinks an open-ended challenge below anything with a real deadline', () => {
    const result = rank({
      candidates: [candidate({ id: 'open-ended' }), candidate({ id: 'dated', dueAt: inDays(9) })],
    })
    expect(result.matched && result.top.id).toBe('dated')
  })

  it('offers at most two alternatives — a proposal, not a menu', () => {
    const result = rank({
      candidates: ['a', 'b', 'c', 'd', 'e'].map((id, i) => candidate({ id, dueAt: inDays(i + 1) })),
    })
    expect(result.matched && result.alternatives).toHaveLength(2)
  })

  it('reports whole days to close, which is what the answer says out loud', () => {
    const result = rank({ candidates: [candidate({ id: 'c1', dueAt: inDays(3) })] })
    expect(result.matched && result.top.closesInDays).toBe(3)
  })
})

describe('rankChallenges — bad data costs a signal, not the suggestion', () => {
  it('keeps a challenge whose due date will not parse', () => {
    const result = rank({ candidates: [candidate({ id: 'c1', dueAt: 'not-a-date' })] })
    expect(result.matched && result.top.id).toBe('c1')
    expect(result.matched && result.top.closesInDays).toBeNaN()
  })

  it('drops a matched skill with no name rather than showing an id to the student', () => {
    const result = rank({
      candidates: [candidate({ id: 'c1', skillIds: ['skill-graphs', 'skill-unnamed'] })],
      strongSkillIds: ['skill-graphs', 'skill-unnamed'],
    })
    expect(result.matched && result.top.matchedSkills).toEqual(['Graph Traversal'])
  })
})
