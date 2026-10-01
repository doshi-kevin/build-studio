// Class insight facts (src/lib/roadmap/class-insight.ts) — the snapshot the
// Class analytics drawer's AI narrative is written from. Everything the model
// is allowed to say comes from here, so the rules worth pinning are the ones
// that keep the prose from contradicting the drawer underneath it.

import { describe, it, expect } from 'vitest'
import { buildClassInsightFacts, CLASS_MAX_STUDENTS, type ClassRosterFact, type ClassSkillFact, classInsightBlocker} from '@/lib/roadmap/class-insight'

const counts = (mastered: number, review = 0, prog = 0, not = 0) => ({
  mastered, review_next: review, in_progress: prog, not_started: not,
})

const student = (
  name: string,
  overall: ClassRosterFact['overall'],
  masteryPct: number | null,
  quizAvg: number | null = null,
): ClassRosterFact => ({ name, overall, masteryPct, quizAvg, counts: counts(1) })

const stats = (over: Partial<Parameters<typeof buildClassInsightFacts>[1]> = {}) => ({
  classMastery: 61,
  classQuizAvg: 70,
  excelling: 1,
  needsSupport: 2,
  totalStudents: 4,
  ...over,
})

const skill = (name: string, score: number, atRisk = 0): ClassSkillFact => ({ name, score, atRisk })

describe('buildClassInsightFacts', () => {
  it('names the lowest-scoring students below the bar, capped, with a true total', () => {
    const students: ClassRosterFact[] = [
      student('Ada Lovelace', 'excelling', 91),
      student('Bo Chen', 'needs_support', 44, 51),
      student('Cy Patel', 'needs_support', 31, 40),
      student('Di Okafor', 'needs_support', 38),
      student('Eli Ruiz', 'needs_support', 49),
      student('Fay Kim', 'needs_support', 22),
      student('Gus Hall', 'on_track', 70),
    ]
    const facts = buildClassInsightFacts(students, stats({ needsSupport: 5, totalStudents: 7 }), [], 0)

    expect(facts.needsAttention.map((s) => s.name)).toEqual(['Fay Kim', 'Cy Patel', 'Di Okafor', 'Bo Chen'])
    expect(facts.needsAttention).toHaveLength(CLASS_MAX_STUDENTS)
    // the CAP must not become the count — 5 students are behind, not 4
    expect(facts.needsAttentionCount).toBe(5)
    expect(facts.needsAttention[1]).toEqual({ name: 'Cy Patel', masteryPct: 31, quizAvg: 40 })
  })

  it('never lets one skill be both the weakest and the strongest', () => {
    // 3 scored skills: fewer than the 4-skill cap, so "strongest" must stay
    // empty rather than re-listing rows the weakest list already named.
    const facts = buildClassInsightFacts([], stats(), [skill('Tokenization', 30), skill('Attention', 55), skill('RNNs', 80)], 0)
    expect(facts.weakestSkills.map((s) => s.name)).toEqual(['Tokenization', 'Attention', 'RNNs'])
    expect(facts.strongestSkills).toEqual([])
  })

  it('reads strongest off the tail, best first, once there are skills to spare', () => {
    const ranked = [
      skill('Tokenization', 20, 6), skill('Attention', 35), skill('Embeddings', 44),
      skill('N-grams', 52), skill('POS tagging', 68), skill('RNNs', 88),
    ]
    const facts = buildClassInsightFacts([], stats(), ranked, 2)
    expect(facts.weakestSkills.map((s) => s.name)).toEqual(['Tokenization', 'Attention', 'Embeddings', 'N-grams'])
    expect(facts.strongestSkills.map((s) => s.name)).toEqual(['RNNs', 'POS tagging'])
    expect(facts.weakestSkills[0].atRisk).toBe(6)
    expect(facts.skillsWithoutData).toBe(2)
  })

  it('splits the standing four ways so they sum to the roster', () => {
    const students: ClassRosterFact[] = [
      student('Ada', 'excelling', 91),
      student('Bo', 'on_track', 72),
      student('Cy', 'needs_support', 40),
      student('Di', 'not_started', null),
    ]
    const facts = buildClassInsightFacts(students, stats({ excelling: 1, needsSupport: 1 }), [], 0)
    expect(facts.excelling + facts.onTrack + facts.needsSupport + facts.noData).toBe(facts.totalStudents)
    // a student with no graded work is missing data, not a low score — they are
    // named separately so the prose can't report them as underperforming
    expect(facts.noSignalStudents).toEqual(['Di'])
    expect(facts.needsAttention.map((s) => s.name)).toEqual(['Cy'])
  })

  it('breaks equal scores at the cap by name, not by the order the roster arrived in', () => {
    // 5 students on the SAME mastery and only 4 slots. Without the name
    // tiebreak, which one is dropped comes down to the roster read's row order —
    // and since the snapshot is hashed to decide whether to re-bill the model,
    // that means a reshuffle costs a model call and shows the professor a
    // different shortlist for identical numbers.
    const names = ['Zoe Adams', 'Bo Chen', 'Ada Lovelace', 'Cy Patel', 'Di Okafor']
    const tied = names.map((n) => student(n, 'needs_support', 40))
    const expected = ['Ada Lovelace', 'Bo Chen', 'Cy Patel', 'Di Okafor']

    expect(buildClassInsightFacts(tied, stats({ needsSupport: 5, totalStudents: 5 }), [], 0)
      .needsAttention.map((s) => s.name)).toEqual(expected)
    expect(buildClassInsightFacts([...tied].reverse(), stats({ needsSupport: 5, totalStudents: 5 }), [], 0)
      .needsAttention.map((s) => s.name)).toEqual(expected)
  })

  it('yields a byte-identical snapshot for the same roster in a different order', () => {
    /* THE CACHE KEY IS THIS SNAPSHOT'S JSON: `signalHash` is sha256 over
       JSON.stringify(facts), so identical JSON is identical hash and this is the
       cache guard, one step earlier and with a readable diff when it fails.
       Every capped or sliced list in here therefore needs an order of its own —
       `needsAttention` (tiebroken) and `noSignalStudents` (sorted). The roster
       read is ORDER BY student_id for the same reason, but that only protects
       this one caller; the invariant has to hold in the builder. */
    const roster: ClassRosterFact[] = [
      student('Ada Lovelace', 'excelling', 91, 88),
      student('Bo Chen', 'needs_support', 44, 51),
      student('Cy Patel', 'needs_support', 44, 40), // tied with Bo
      student('Di Okafor', 'not_started', null),
      student('Eli Ruiz', 'not_started', null),
      student('Fay Kim', 'not_started', null),
      student('Gus Hall', 'not_started', null),
      student('Hana Sato', 'not_started', null), // 5 with no signal, cap is 4
      student('Ivo Marek', 'on_track', 70, 74),
    ]
    const ranked = [skill('Tokenization', 20, 6), skill('Attention', 35), skill('RNNs', 88)]
    const build = (r: ClassRosterFact[]) =>
      buildClassInsightFacts(r, stats({ excelling: 1, needsSupport: 2, totalStudents: 9 }), ranked, 1)

    const rotated = [...roster.slice(4), ...roster.slice(0, 4)]
    expect(JSON.stringify(build(rotated))).toBe(JSON.stringify(build(roster)))
    expect(JSON.stringify(build([...roster].reverse()))).toBe(JSON.stringify(build(roster)))
    // and the capped list is the shortlist it claims to be, not an arbitrary 4
    expect(build(roster).noSignalStudents).toEqual(['Di Okafor', 'Eli Ruiz', 'Fay Kim', 'Gus Hall'])
  })

  it('sums the journey mix across the whole roster', () => {
    const students: ClassRosterFact[] = [
      { ...student('Ada', 'excelling', 91), counts: counts(5, 1, 2, 0) },
      { ...student('Bo', 'needs_support', 30), counts: counts(1, 2, 0, 5) },
    ]
    const facts = buildClassInsightFacts(students, stats(), [], 0)
    expect(facts.journeyCounts).toEqual({ mastered: 6, review_next: 3, in_progress: 2, not_started: 5 })
  })
})

describe('classInsightBlocker — when not to write a narrative at all', () => {
  /* The drawer used to render zeroed tiles and still pay for a model call to
     narrate them. The only guard was a line in the prompt asking the model to
     mention sparseness, which is a request, not a state. */
  it('refuses on an empty roster', () => {
    expect(classInsightBlocker({ totalStudents: 0, classMasteryPct: 71, classQuizAvg: 68 }))
      .toMatch(/no students/i)
  })

  it('refuses when nothing has been graded, however many students are enrolled', () => {
    expect(classInsightBlocker({ totalStudents: 30, classMasteryPct: null, classQuizAvg: null }))
      .toMatch(/nothing has been graded/i)
  })

  it('allows it on mastery alone, so an assignments-only course still gets a narrative', () => {
    expect(classInsightBlocker({ totalStudents: 30, classMasteryPct: 64, classQuizAvg: null })).toBeNull()
  })

  it('allows it on quiz scores alone', () => {
    expect(classInsightBlocker({ totalStudents: 30, classMasteryPct: null, classQuizAvg: 72 })).toBeNull()
  })

  it('treats a genuine zero as evidence, not as absence', () => {
    // 0% is a real, alarming number. null is "nobody measured".
    expect(classInsightBlocker({ totalStudents: 5, classMasteryPct: 0, classQuizAvg: null })).toBeNull()
  })
})
