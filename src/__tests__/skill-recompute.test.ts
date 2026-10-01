// Tests for the Skill Mastery recompute engine (src/lib/skills/recompute.ts).
//
// recomputeSectionMastery folds ALL real evidence chronologically through the
// pure scoring engine and rebuilds skill_mastery from scratch. The behaviours
// worth pinning (deterministic, no luck involved):
//   - quiz attempts map to their subtopics via activity_skills,
//   - excluded subtopics are dropped from ALL scoring — both the name-matched
//     set (live-quiz) and mapped quiz/assignment evidence,
//   - chronological folding through nextMasteryScore is order-dependent,
//   - the rebuild is idempotent (delete-then-insert; re-run = same rows),
//   - no evidence ⇒ no rows written.
//
// Driven by a table-routed in-memory admin double. Covers both the mapped graded
// path (quiz_attempts via activity_skills) and the live-classroom path
// (lc_rooms → lc_interactions → lc_responses, graded from payload + name-matched).

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
// reconcileSectionSkills runs many extra table reads/writes; stub it out so the
// test isolates the folding/rebuild logic (its dedup core is covered separately).
// Note the stub is a no-op, which makes this suite blind to WHEN the skill pool
// is read relative to reconcile — a real bug once lived in that gap. Ordering is
// covered by skill-recompute-pool-order.test.ts, whose stub mutates the fixture
// on purpose. Do not read this suite's green as covering that.
/* reconcileSectionSkills is stubbed (it does DB + AI work these tests do not
   exercise), but matchInPool is a pure name-matching primitive the recompute now
   resolves every question tag and node-check topic through. Keep the REAL one, so
   these tests still prove which skill a label lands on. */
vi.mock('@/lib/skills/reconcile', async () => {
  const actual = await vi.importActual<typeof import('@/lib/skills/reconcile')>('@/lib/skills/reconcile')
  return {
    ...actual,
    reconcileSectionSkills: vi.fn().mockResolvedValue({ added: 0, mapped: 0 }),
  }
})

import { recomputeSectionMastery } from '@/lib/skills/recompute'
import { nextMasteryScore, evidenceWeight, foldMasteryEvents } from '@/lib/skills/scoring'
import { DEFAULT_TOPIC_MASTERY_CONFIG as CFG } from '@/lib/skills/config'

// ── Table-routed admin double ─────────────────────────────────────────────
// Each from(table) returns a thenable chain whose terminal resolution (await,
// .maybeSingle(), .in(), .eq()) yields { data, error } from the fixture map.
// We also capture skill_mastery deletes and inserts.

interface Fixture {
  course_sections?: { institution_id: string; settings?: unknown } | null
  skills?: Array<{ id: string; name: string; parent_id: string | null; excluded: boolean }>
  activity_skills?: Array<{ activity_type: string; activity_id: string; skill_id: string }>
  quiz_attempts?: Array<Record<string, unknown>>
  assignments?: Array<Record<string, unknown>>
  assignment_submissions?: Array<Record<string, unknown>>
  lc_rooms?: Array<{ id: string }>
  lc_interactions?: Array<{ id: string; payload: unknown }>
  lc_responses?: Array<Record<string, unknown>>
  node_check_attempts?: Array<Record<string, unknown>>
  module_items?: Array<{ id: string; content: unknown }>
  challenges?: Array<{ id: string; difficulty: string | null }>
  challenge_claims?: Array<Record<string, unknown>>
}

function makeAdmin(fx: Fixture) {
  const deletes: string[] = []
  const inserts: Array<Record<string, unknown>> = []

  function chain(table: string) {
    let result: { data: unknown; error: unknown } = { data: [], error: null }
    if (table === 'course_sections') result = { data: fx.course_sections ?? null, error: null }
    if (table === 'skills') result = { data: fx.skills ?? [], error: null }
    if (table === 'activity_skills') result = { data: fx.activity_skills ?? [], error: null }
    if (table === 'quiz_attempts') result = { data: fx.quiz_attempts ?? [], error: null }
    if (table === 'assignments') result = { data: fx.assignments ?? [], error: null }
    if (table === 'assignment_submissions') result = { data: fx.assignment_submissions ?? [], error: null }
    if (table === 'lc_rooms') result = { data: fx.lc_rooms ?? [], error: null }
    if (table === 'lc_interactions') result = { data: fx.lc_interactions ?? [], error: null }
    if (table === 'lc_responses') result = { data: fx.lc_responses ?? [], error: null }
    if (table === 'node_check_attempts') result = { data: fx.node_check_attempts ?? [], error: null }
    if (table === 'module_items') result = { data: fx.module_items ?? [], error: null }
    if (table === 'challenges') result = { data: fx.challenges ?? [], error: null }
    if (table === 'challenge_claims') result = { data: fx.challenge_claims ?? [], error: null }

    const self: Record<string, unknown> = {}
    const passthrough = ['select', 'in', 'is', 'not', 'order', 'limit']
    for (const m of passthrough) self[m] = () => self
    /* .eq() is NOT a blanket passthrough for challenge_claims: the recompute filters on
       status='approved', and a double that ignores it would pass even if production dropped
       the filter — the test would then prove nothing about which claims count as evidence. */
    self.eq = (col: string, val: unknown) => {
      if (table === 'challenge_claims' && col === 'status') {
        const rows = (fx.challenge_claims ?? []) as Array<Record<string, unknown>>
        result = { data: rows.filter((r) => r.status === val), error: null }
      }
      return self
    }
    /* readAllPages ends every paged read with .order(col).range(from, to). The
       fixtures are far under one page, so page 0 resolves the whole set and any
       later page is empty — which is also what tells the helper to stop. Added
       when the recompute's scans became paged; it grants the double a new chain
       method and changes no expectation. */
    self.range = async (from: number) => (from === 0 ? result : { data: [], error: null })
    self.maybeSingle = async () => result
    self.single = async () => result
    self.then = (resolve: (v: unknown) => unknown) => resolve(result)
    self.delete = () => ({
      eq: async () => {
        deletes.push(table)
        return { data: null, error: null }
      },
    })
    self.insert = async (rows: Array<Record<string, unknown>>) => {
      inserts.push(...rows)
      return { data: null, error: null }
    }
    return self
  }

  // The rebuild is now one atomic RPC (replace_section_skill_mastery) instead of
  // a raw delete + insert on skill_mastery. Emulate its semantics so the
  // delete/insert capture the same way the assertions expect.
  const rpc = async (name: string, params: Record<string, unknown>) => {
    if (name === 'replace_section_skill_mastery') {
      deletes.push('skill_mastery')
      inserts.push(...((params?.p_rows as Array<Record<string, unknown>>) ?? []))
    }
    return { data: null, error: null }
  }

  return { admin: { from: (t: string) => chain(t), rpc }, deletes, inserts }
}

const baseFx = (over: Partial<Fixture> = {}): Fixture => ({
  course_sections: { institution_id: 'inst-1' },
  skills: [
    { id: 'main', name: 'Calculus', parent_id: null, excluded: false },
    { id: 'sub-a', name: 'Limits', parent_id: 'main', excluded: false },
    { id: 'sub-x', name: 'Excluded', parent_id: 'main', excluded: true },
  ],
  activity_skills: [
    { activity_type: 'quiz', activity_id: 'q1', skill_id: 'sub-a' },
    { activity_type: 'quiz', activity_id: 'q2', skill_id: 'sub-a' },
  ],
  ...over,
})

describe('recomputeSectionMastery', () => {
  it('returns zero and writes nothing when the section is missing', async () => {
    const { admin, inserts } = makeAdmin({ course_sections: null })
    const res = await recomputeSectionMastery(admin, 'sec-1')
    expect(res).toEqual({ updated: 0, events: 0 })
    expect(inserts).toHaveLength(0)
  })

  it('folds quiz evidence chronologically and writes one row per (student, subtopic)', async () => {
    const fx = baseFx({
      quiz_attempts: [
        // student s1, two quizzes mapped to sub-a — folded oldest→newest.
        { quiz_id: 'q1', student_id: 's1', earned_points: 6, total_points: 10, status: 'submitted', submitted_at: '2026-01-01T00:00:00Z' }, // 60%
        { quiz_id: 'q2', student_id: 's1', earned_points: 9, total_points: 10, status: 'graded', submitted_at: '2026-02-01T00:00:00Z' }, // 90%
      ],
    })
    const { admin, inserts, deletes } = makeAdmin(fx)
    const res = await recomputeSectionMastery(admin, 'sec-1')

    // Only sub-a is scored (sub-x is excluded and filtered out of subtopics).
    expect(res.updated).toBe(1)
    expect(deletes).toContain('skill_mastery') // idempotent rebuild
    expect(inserts).toHaveLength(1)
    const row = inserts[0]
    expect(row.student_id).toBe('s1')
    expect(row.skill_id).toBe('sub-a')
    expect((row.state as { n: number }).n).toBe(2)

    // Reproduce the fold with the same function production uses, rather than a
    // hand-rolled chain that can drift from it.
    const w = evidenceWeight(CFG, 'quiz', 10)
    const expected = foldMasteryEvents(
      [
        { studentId: 's1', skillId: 'sub-a', pct: 60, at: Date.parse('2026-01-01T00:00:00Z'), weight: w },
        { studentId: 's1', skillId: 'sub-a', pct: 90, at: Date.parse('2026-02-01T00:00:00Z'), weight: w },
      ],
      CFG,
      50,
    ).get('s1:sub-a')!
    expect(row.score).toBeCloseTo(expected.score, 5)
  })

  it('folds live-classroom quiz evidence, graded from the payload and name-matched to a subtopic by title', async () => {
    // A live-classroom quiz (lc_rooms → lc_interactions kind=quiz → lc_responses).
    // The quiz+answers live in the interaction payload; the response is graded
    // against it, and its title is name-matched to the subtopic "Limits".
    const fx = baseFx({
      activity_skills: [], // isolate the live-classroom path (no mapped graded quizzes)
      lc_rooms: [{ id: 'room1' }],
      lc_interactions: [
        {
          id: 'lq1',
          payload: {
            title: 'Pop quiz: Limits', // contains subtopic "Limits" → matches sub-a
            questions: [
              { id: 'qq1', correctChoiceId: 'c1' },
              { id: 'qq2', correctChoiceId: 'c2' },
            ],
          },
        },
      ],
      lc_responses: [
        // 2/2 correct = 100%.
        { interaction_id: 'lq1', student_id: 's1', response: { answers: { qq1: 'c1', qq2: 'c2' } }, submitted_at: '2026-03-01T00:00:00Z' },
      ],
    })
    const { admin, inserts } = makeAdmin(fx)
    const res = await recomputeSectionMastery(admin, 'sec-1')

    expect(res.updated).toBe(1)
    expect(inserts).toHaveLength(1)
    const row = inserts[0]
    expect(row.student_id).toBe('s1')
    expect(row.skill_id).toBe('sub-a') // matched "Limits" by title, not by a mapping
    expect((row.state as { n: number }).n).toBe(1)

    // 100% evidence from the cold-start seed (50) must move the score up.
    const expected = Math.round(nextMasteryScore(null, 100, evidenceWeight(CFG, 'quiz', 2), CFG, 50) * 10) / 10
    expect(row.score).toBeCloseTo(expected, 5)
    expect(row.score as number).toBeGreaterThan(50)
  })

  it('skips a live-classroom quiz whose title name-matches no subtopic — no rows', async () => {
    // Same graded live-quiz path, but the payload title contains no subtopic
    // name. matchSubskills returns [] so no evidence is folded.
    const fx = baseFx({
      activity_skills: [],
      lc_rooms: [{ id: 'room1' }],
      lc_interactions: [
        {
          id: 'lq1',
          payload: {
            title: 'Warm-up: general review', // no subtopic name ("Limits") present
            questions: [{ id: 'qq1', correctChoiceId: 'c1' }],
          },
        },
      ],
      lc_responses: [
        { interaction_id: 'lq1', student_id: 's1', response: { answers: { qq1: 'c1' } }, submitted_at: '2026-03-01T00:00:00Z' },
      ],
    })
    const { admin, inserts } = makeAdmin(fx)
    const res = await recomputeSectionMastery(admin, 'sec-1')
    expect(res).toEqual({ updated: 0, events: 0 })
    expect(inserts).toHaveLength(0)
  })

  it('skips a live-classroom quiz with a malformed payload (no questions) even when the title matches', async () => {
    // Title name-matches "Limits", but the payload carries no questions array.
    // The `if (!questions.length) continue` guard must drop it (can't grade).
    const fx = baseFx({
      activity_skills: [],
      lc_rooms: [{ id: 'room1' }],
      lc_interactions: [{ id: 'lq1', payload: { title: 'Pop quiz: Limits' } }], // questions missing
      lc_responses: [
        { interaction_id: 'lq1', student_id: 's1', response: { answers: {} }, submitted_at: '2026-03-01T00:00:00Z' },
      ],
    })
    const { admin, inserts } = makeAdmin(fx)
    const res = await recomputeSectionMastery(admin, 'sec-1')
    expect(res).toEqual({ updated: 0, events: 0 })
    expect(inserts).toHaveLength(0)
  })

  it('attributes live-quiz evidence by the questions’ skillIds when present — tags win over the title, non-subtopic ids are dropped', async () => {
    // Title matches NO subtopic ("Checkpoint 3"), so a title-only path would score
    // nothing. But the question is tagged with sub-a plus a bogus id — mastery must
    // attribute to sub-a (the real subtopic) and ignore the bogus tag.
    const fx = baseFx({
      activity_skills: [],
      lc_rooms: [{ id: 'room1' }],
      lc_interactions: [
        {
          id: 'lq1',
          payload: {
            title: 'Checkpoint 3',
            questions: [{ id: 'qq1', correctChoiceId: 'c1', skillIds: ['sub-a', 'not-a-subtopic'] }],
          },
        },
      ],
      lc_responses: [
        { interaction_id: 'lq1', student_id: 's1', response: { answers: { qq1: 'c1' } }, submitted_at: '2026-03-01T00:00:00Z' },
      ],
    })
    const { admin, inserts } = makeAdmin(fx)
    const res = await recomputeSectionMastery(admin, 'sec-1')
    expect(res.updated).toBe(1)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].skill_id).toBe('sub-a') // tagged subtopic; bogus id filtered out; title ignored
    expect(inserts[0].student_id).toBe('s1')
  })

  it('scores a childless top-level skill from a live quiz — leaf, not just subtopics', async () => {
    // Regression: a section whose skills are all top-level (no subtopics) must
    // still be feedable by a live quiz. A top-level skill with no children is its
    // own leaf, so both a title name-match and a skillIds tag should score it.
    const fx: Fixture = {
      course_sections: { institution_id: 'inst-1' },
      skills: [{ id: 'solo', name: 'Vectors', parent_id: null, excluded: false }], // no children → leaf
      activity_skills: [],
      lc_rooms: [{ id: 'room1' }],
      lc_interactions: [
        // q by title match ("Vectors"); qq by explicit tag on the top-level skill.
        { id: 'lq1', payload: { title: 'Pop quiz: Vectors', questions: [{ id: 'q', correctChoiceId: 'c1' }] } },
        { id: 'lq2', payload: { title: 'Checkpoint', questions: [{ id: 'qq', correctChoiceId: 'c1', skillIds: ['solo'] }] } },
      ],
      lc_responses: [
        { interaction_id: 'lq1', student_id: 's1', response: { answers: { q: 'c1' } }, submitted_at: '2026-03-01T00:00:00Z' },
        { interaction_id: 'lq2', student_id: 's1', response: { answers: { qq: 'c1' } }, submitted_at: '2026-03-02T00:00:00Z' },
      ],
    }
    const { admin, inserts } = makeAdmin(fx)
    const res = await recomputeSectionMastery(admin, 'sec-1')
    expect(res.updated).toBe(1)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].skill_id).toBe('solo')
    expect((inserts[0].state as { n: number }).n).toBe(2) // both the matched + tagged quiz folded in
  })

  it('drops an excluded subtopic even when a live-quiz question is tagged with it', async () => {
    // sub-x is excluded → filtered out of the subtopic set, so a skillIds tag
    // pointing at it must not score (uncheck-to-drop applies to live quizzes too).
    const fx = baseFx({
      activity_skills: [],
      lc_rooms: [{ id: 'room1' }],
      lc_interactions: [
        { id: 'lq1', payload: { title: 'Checkpoint 4', questions: [{ id: 'qq1', correctChoiceId: 'c1', skillIds: ['sub-x'] }] } },
      ],
      lc_responses: [
        { interaction_id: 'lq1', student_id: 's1', response: { answers: { qq1: 'c1' } }, submitted_at: '2026-03-01T00:00:00Z' },
      ],
    })
    const { admin, inserts } = makeAdmin(fx)
    const res = await recomputeSectionMastery(admin, 'sec-1')
    expect(res).toEqual({ updated: 0, events: 0 })
    expect(inserts).toHaveLength(0)
  })

  it('gates mapped quiz evidence by `excluded` — an excluded subtopic is not scored', async () => {
    // q1 is explicitly mapped to the excluded subtopic sub-x via activity_skills.
    // Uncheck-to-drop must stop tracking: excluded skills are filtered out of the
    // mapped quiz/assignment evidence too, not just the name-matched set.
    const fx = baseFx({
      activity_skills: [{ activity_type: 'quiz', activity_id: 'q1', skill_id: 'sub-x' }],
      quiz_attempts: [
        { quiz_id: 'q1', student_id: 's1', earned_points: 5, total_points: 10, status: 'submitted', submitted_at: '2026-01-01T00:00:00Z' },
      ],
    })
    const { admin, inserts } = makeAdmin(fx)
    const res = await recomputeSectionMastery(admin, 'sec-1')
    expect(res.updated).toBe(0)
    expect(inserts).toHaveLength(0)
  })

  it('writes nothing (but still deletes) when there is no evidence — clean slate', async () => {
    const { admin, inserts, deletes } = makeAdmin(baseFx({ quiz_attempts: [] }))
    const res = await recomputeSectionMastery(admin, 'sec-1')
    expect(res).toEqual({ updated: 0, events: 0 })
    expect(deletes).toContain('skill_mastery') // stale rows still cleared
    expect(inserts).toHaveLength(0)
  })

  it('is order-independent in input: chronology comes from submitted_at, not array order', async () => {
    // Same two attempts as the happy path but supplied newest-first.
    const fx = baseFx({
      quiz_attempts: [
        { quiz_id: 'q2', student_id: 's1', earned_points: 9, total_points: 10, status: 'graded', submitted_at: '2026-02-01T00:00:00Z' },
        { quiz_id: 'q1', student_id: 's1', earned_points: 6, total_points: 10, status: 'submitted', submitted_at: '2026-01-01T00:00:00Z' },
      ],
    })
    const { admin, inserts } = makeAdmin(fx)
    await recomputeSectionMastery(admin, 'sec-1')

    const w = evidenceWeight(CFG, 'quiz', 10)
    const expected = foldMasteryEvents(
      [
        { studentId: 's1', skillId: 'sub-a', pct: 60, at: Date.parse('2026-01-01T00:00:00Z'), weight: w }, // Jan first
        { studentId: 's1', skillId: 'sub-a', pct: 90, at: Date.parse('2026-02-01T00:00:00Z'), weight: w }, // Feb second
      ],
      CFG,
      50,
    ).get('s1:sub-a')!
    expect(inserts[0].score).toBeCloseTo(expected.score, 5)
  })

  // ── node checks (§14, the quiz door's "small mastery boost") ─────────────

  it('folds a passed node check as one tiny, name-matched event', async () => {
    const fx = baseFx({
      activity_skills: [],
      node_check_attempts: [
        { module_item_id: 'mi-1', student_id: 's1', passed: true, updated_at: '2026-03-01T00:00:00Z' },
      ],
      module_items: [{ id: 'mi-1', content: { topics: ['Limits and continuity'] } }],
    })
    const { admin, inserts } = makeAdmin(fx)
    const res = await recomputeSectionMastery(admin, 'sec-1')

    expect(res.events).toBe(1)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].skill_id).toBe('sub-a') // topic name-matched to the leaf
    /* The load-bearing claim is MAGNITUDE, deliberately as a bound rather than
       re-deriving it from NODE_CHECK_MASTERY_WEIGHT (which would pass at any
       weight): a pass is a nudge of a few points from the cold-start 50 — not
       the ~+17 a 100% two-point quiz earns. Raising the weight until node
       checks "count" is the farming hole this bound guards. */
    expect(inserts[0].score as number).toBeGreaterThan(50)
    expect(inserts[0].score as number).toBeLessThan(56)
  })

  it('scores nothing for a passed check whose topics match no leaf skill', async () => {
    const fx = baseFx({
      activity_skills: [],
      node_check_attempts: [
        { module_item_id: 'mi-1', student_id: 's1', passed: true, updated_at: '2026-03-01T00:00:00Z' },
      ],
      // No leaf name appears in the topic ('Excluded' is untracked and must not match either).
      module_items: [{ id: 'mi-1', content: { topics: ['General review', 'Excluded'] } }],
    })
    const { admin, inserts } = makeAdmin(fx)
    const res = await recomputeSectionMastery(admin, 'sec-1')
    expect(res.events).toBe(0)
    expect(inserts).toHaveLength(0)
  })
})

/**
 * #599 — an approved challenge bumped skill_mastery via the incremental hook, but the
 * recompute REPLACES the table and had no challenge source. So any later grade in the section
 * silently erased recorded challenge evidence.
 *
 * The load-bearing assertion is that a rebuild driven ONLY by challenge evidence still writes
 * a row: that is precisely what the bug destroyed. Weight parity with the hook is asserted
 * separately, because a rebuild that folds the evidence at the wrong weight is its own bug.
 */
describe('recompute — approved challenge evidence survives a rebuild (#599)', () => {
  const SKILLS = [{ id: 's1', name: 'Recursion', parent_id: null, excluded: false }]

  it('rebuilds mastery from an approved challenge, instead of dropping it', async () => {
    const { admin, inserts } = makeAdmin({
      course_sections: { institution_id: 'inst-1' },
      skills: SKILLS,
      activity_skills: [{ activity_type: 'challenge', activity_id: 'ch-1', skill_id: 's1' }],
      challenges: [{ id: 'ch-1', difficulty: 'hard' }],
      challenge_claims: [
        { challenge_id: 'ch-1', user_id: 'stu-1', status: 'approved', reviewed_at: '2026-03-01T00:00:00.000Z' },
      ],
    })

    await recomputeSectionMastery(admin as never, 'sec-1')

    const row = inserts.find((r) => r.student_id === 'stu-1' && r.skill_id === 's1')
    expect(row).toBeDefined()
    /* Same fold the hook performs: pct 100 at stake × max(1, points=1) — 'hard' ⇒ 0.75.
       Rounded to 1dp, as the rebuild stores it. Asserting the WEIGHT matters as much as
       asserting a row exists: folding challenge evidence at the wrong stake would still
       produce a row, just a wrong number. */
    expect(row!.score).toBe(Math.round(nextMasteryScore(null, 100, 0.75, CFG, 50) * 10) / 10)
  })

  it('ignores non-approved claims — a pending or rejected claim is not evidence', async () => {
    /* The double now honours .eq('status', …), so this genuinely exercises the production
       filter: both claims below would produce a row if the filter were dropped. */
    const { admin, inserts } = makeAdmin({
      course_sections: { institution_id: 'inst-1' },
      skills: SKILLS,
      activity_skills: [{ activity_type: 'challenge', activity_id: 'ch-1', skill_id: 's1' }],
      challenges: [{ id: 'ch-1', difficulty: 'hard' }],
      challenge_claims: [
        { challenge_id: 'ch-1', user_id: 'stu-1', status: 'pending', reviewed_at: '2026-03-01T00:00:00.000Z' },
        { challenge_id: 'ch-1', user_id: 'stu-2', status: 'rejected', reviewed_at: '2026-03-02T00:00:00.000Z' },
      ],
    })

    await recomputeSectionMastery(admin as never, 'sec-1')
    expect(inserts).toHaveLength(0)
  })

  it('drops an UNMAPPED challenge rather than guessing a skill for it', async () => {
    const { admin, inserts } = makeAdmin({
      course_sections: { institution_id: 'inst-1' },
      skills: SKILLS,
      activity_skills: [], // no challenge:ch-1 mapping
      challenges: [{ id: 'ch-1', difficulty: 'medium' }],
      challenge_claims: [
        { challenge_id: 'ch-1', user_id: 'stu-1', status: 'approved', reviewed_at: '2026-03-01T00:00:00.000Z' },
      ],
    })

    await recomputeSectionMastery(admin as never, 'sec-1')
    expect(inserts).toHaveLength(0)
  })
})

