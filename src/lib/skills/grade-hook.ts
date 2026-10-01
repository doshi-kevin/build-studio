// Skill Mastery — incremental update from a single graded activity.
//
// Called from the grade-finalizing server actions (quiz submit, adaptive
// submit, assignment grade) AFTER the grade is committed and the caller has
// already authorized the student/section. It updates ONLY that one student's
// mapped subtopic scores via the same engine the full recompute uses — a
// per-student upsert, never a section-wide delete, so a whole class submitting
// at once can't race (each student writes only their own rows).
//
// This is NOT a server action (no 'use server') so it can't be invoked from the
// client — exposing it would let an attacker forge mastery. It must never throw:
// skill tracking is best-effort and must not break grading.

import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveSkillMasteryConfig, type SkillMasteryConfig } from '@/lib/skills/config'
import { nextMasteryTarget, capMasteryMove, evidenceWeight, recencyDecay, subscoresBySkill, splitPointsAcrossSkills, NODE_CHECK_MASTERY_WEIGHT, type QuestionOutcome } from '@/lib/skills/scoring'
import { selectLeafSkills } from '@/lib/skills/tree'
import { canonicalizeName, matchInPool } from '@/lib/skills/canonical'
import { logger } from '@/lib/logger'
import type { ActivityType } from '@/lib/validations/skill'

export interface GradeEvidence {
  sectionId: string
  studentId: string
  activityType: ActivityType
  activityId: string
  /** Score as a percentage (0–100). */
  pct: number
  /** Max points the activity was worth, for stake weighting (defaults to 1). */
  points?: number
  /** Optional per-call stake override, replacing the config's per-type multiplier.
   *  Challenges use this to scale the mastery nudge by difficulty (see
   *  CHALLENGE_DIFFICULTY_STAKE). Omit for graded activities (quiz/assignment/exam),
   *  which keep the section's configured stake. */
  stake?: number
  /** The quiz attempt this grade came from. Supplied, the hook scores each skill
   *  on ITS OWN questions instead of recording the whole-quiz percentage against
   *  every skill the quiz touches — the same split the background rebuild makes,
   *  so the two cannot disagree. Omitted, the whole-quiz figure is used. */
  attemptId?: string
  /** When the evidence was EARNED (submitted_at for a quiz, graded_at for an
   *  assignment) as an ISO string or epoch ms. The rebuild dates every event this
   *  way, so passing it keeps the incremental write and the nightly rebuild on the
   *  same clock. Omitted, the hook falls back to now — correct for work graded as
   *  it happens, wrong for a backlog graded weeks late, and the rebuild corrects
   *  it either way. */
  occurredAt?: string | number
}

/**
 * Fold one graded activity into a student's skill mastery. No-op (silently) if
 * the section has no skills yet or the activity isn't mapped to any subtopic —
 * the professor simply hasn't set Skill Mastery up, which is fine.
 */
export async function applyGradeToSkillMastery(ev: GradeEvidence): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: section } = await adminDb
      .from('course_sections')
      .select('institution_id, settings')
      .eq('id', ev.sectionId)
      .maybeSingle()
    if (!section?.institution_id) return

    const { data: maps } = await adminDb
      .from('activity_skills')
      .select('skill_id')
      .eq('section_id', ev.sectionId)
      .eq('activity_type', ev.activityType)
      .eq('activity_id', ev.activityId)
    const mappedIds = ((maps ?? []) as Array<{ skill_id: string }>).map((m) => m.skill_id)
    if (mappedIds.length === 0) return // activity not mapped → nothing to update

    /* Skip untracked skills — EXCLUDED (professor dropped it) and SUPPRESSED
       (AI-suggested, not yet corroborated) both count. Filtering only `excluded`
       let the hook score a suppressed skill on submit while the rebuild, which
       drops both, deleted the row hours later: a number that appears and then
       vanishes on its own. The rebuild's filter is recompute.ts's `excludedIds`. */
    const { data: exRows } = await adminDb
      .from('skills')
      .select('id, excluded, suppressed')
      .in('id', mappedIds)
    const untracked = new Set(
      ((exRows ?? []) as Array<{ id: string; excluded: boolean; suppressed: boolean }>)
        .filter((r) => r.excluded || r.suppressed)
        .map((r) => r.id),
    )
    const skillIds = mappedIds.filter((id) => !untracked.has(id))
    if (skillIds.length === 0) return

    const config = resolveSkillMasteryConfig(section.settings)
    const assessedPoints = ev.points && ev.points > 0 ? ev.points : 1

    // A per-call stake override (challenges) keeps the old single-weight shape:
    // there are no questions to split and the score is binary.
    let perSkill: Array<{ skillId: string; pct: number; weight: number }>
    if (ev.stake != null) {
      const weight = ev.stake * Math.max(1, assessedPoints)
      perSkill = skillIds.map((skillId) => ({ skillId, pct: ev.pct, weight }))
    } else if (ev.attemptId) {
      perSkill = await quizSubscores(adminDb, ev, skillIds, config, assessedPoints)
    } else if (ev.activityType === 'assignment') {
      // One holistic score across several skills — split the points before
      // weighting, matching the rebuild. See splitPointsAcrossSkills.
      const weight = evidenceWeight(config, 'assignment', splitPointsAcrossSkills(assessedPoints, skillIds.length))
      perSkill = skillIds.map((skillId) => ({ skillId, pct: ev.pct, weight }))
    } else {
      const weight = evidenceWeight(config, ev.activityType, assessedPoints)
      perSkill = skillIds.map((skillId) => ({ skillId, pct: ev.pct, weight }))
    }

    await foldEvidence(adminDb, {
      sectionId: ev.sectionId,
      institutionId: section.institution_id,
      studentId: ev.studentId,
      perSkill,
      occurredAt: ev.occurredAt,
      config,
      source: 'applyGradeToSkillMastery',
    })
  } catch (err) {
    logger.error('applyGradeToSkillMastery: unexpected', err, { sectionId: ev.sectionId })
  }
}

/**
 * Resolve deliberate labels (question tags, node-check topics) to at most one
 * skill each — the same rule reconcile used to build activity_skills and the
 * background rebuild uses to fold evidence.
 *
 * Sorted longest-canonical-first, then id. matchInPool returns the first pool
 * entry a label matches by substring and the skills query carries no ORDER BY,
 * so an ambiguous label could resolve differently on two runs. Longest first
 * also makes the most specific skill win, which is what stops a topic named
 * "Integrated rate laws" from also crediting a separate "Rate laws".
 */
function resolveLabels(
  labels: string[],
  skills: Array<{ id: string; name: string; excluded?: boolean; suppressed?: boolean }>,
): string[] {
  // Untracked skills are dropped before matching, so a label can never resolve
  // an excluded skill back into scoring — the rebuild does the same.
  const pool = skills
    .filter((t) => !t.excluded && !t.suppressed)
    .map((t) => ({ id: t.id, canonical: canonicalizeName(t.name) }))
    .sort((a, b) => b.canonical.length - a.canonical.length || a.id.localeCompare(b.id))
  const ids = new Set<string>()
  for (const label of labels) {
    const id = matchInPool(label, pool)
    if (id) ids.add(id)
  }
  return [...ids]
}

/**
 * Score each skill on the questions that actually tested it.
 *
 * Reads the attempt's per-question results and the tags on those questions, then
 * groups earned/possible points by skill. Falls back to the whole-quiz figure for
 * any mapped skill no answered question resolved to, and for attempts with no
 * per-question rows at all, so nothing is lost. Mirrors the rebuild in
 * recomputeSectionMastery exactly; if the two drifted, a professor's number would
 * change on its own when the background job caught up.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function quizSubscores(adminDb: any, ev: GradeEvidence, skillIds: string[], config: SkillMasteryConfig, assessedPoints: number): Promise<Array<{ skillId: string; pct: number; weight: number }>> {
  const wholeQuiz = () =>
    skillIds.map((skillId) => ({ skillId, pct: ev.pct, weight: evidenceWeight(config, ev.activityType, assessedPoints) }))
  try {
    const { data: answers } = await adminDb
      .from('quiz_answers')
      .select('question_id, earned_points')
      .eq('attempt_id', ev.attemptId)
    const rows = (answers ?? []) as Array<{ question_id: string; earned_points: number | null }>
    if (!rows.length) return wholeQuiz()

    const { data: qRows } = await adminDb
      .from('quiz_questions')
      .select('id, tags, points')
      .in('id', [...new Set(rows.map((r) => r.question_id))])
    const questions = (qRows ?? []) as Array<{ id: string; tags: string[] | null; points: number | null }>
    if (!questions.length) return wholeQuiz()

    const { data: skillRows } = await adminDb
      .from('skills')
      .select('id, name, parent_id, excluded, suppressed')
      .eq('section_id', ev.sectionId)
    const allSkills = (skillRows ?? []) as Array<{ id: string; name: string; parent_id: string | null; excluded: boolean; suppressed: boolean }>

    const mapped = new Set(skillIds)
    // Same resolution reconcile used to build activity_skills, and the same the
    // background rebuild uses — see the note in recompute.ts. A tag resolves to
    // one skill, exact canonical match first.
    // Most specific first, then id — see the note in recompute.ts.
    const pool = allSkills
      .map((t) => ({ id: t.id, canonical: canonicalizeName(t.name) }))
      .sort((a, b) => b.canonical.length - a.canonical.length || a.id.localeCompare(b.id))
    const meta = new Map(questions.map((q) => {
      const ids = new Set<string>()
      for (const tag of q.tags ?? []) {
        const id = matchInPool(tag, pool)
        if (id) ids.add(id)
      }
      return [q.id, { points: Number(q.points) || 1, skillIds: [...ids] }]
    }))
    const outcomes: QuestionOutcome[] = []
    for (const r of rows) {
      const m = meta.get(r.question_id)
      if (!m) continue
      const ids = m.skillIds.filter((sid) => mapped.has(sid))
      if (!ids.length) continue
      outcomes.push({ skillIds: ids, earned: Number(r.earned_points) || 0, possible: m.points })
    }

    const subs = subscoresBySkill(outcomes)
    if (!subs.length) return wholeQuiz()
    const out = subs.map((sub) => ({ skillId: sub.skillId, pct: sub.pct, weight: evidenceWeight(config, ev.activityType, sub.points) }))
    for (const skillId of skillIds)
      if (!subs.some((sub) => sub.skillId === skillId))
        out.push({ skillId, pct: ev.pct, weight: evidenceWeight(config, ev.activityType, assessedPoints) })
    return out
  } catch (err) {
    logger.warn('quizSubscores: falling back to the whole-quiz score', { sectionId: ev.sectionId, error: String(err) })
    return wholeQuiz()
  }
}

/**
 * Fold one piece of evidence into a student's per-skill rows — the shared
 * read-fold-upsert tail of both hooks. Per-student upsert only, never a
 * section-wide write, so concurrent submitters each touch their own rows.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function foldEvidence(adminDb: any, args: {
  sectionId: string
  institutionId: string
  studentId: string
  /** One entry per skill: what this activity says about THAT skill specifically. */
  perSkill: Array<{ skillId: string; pct: number; weight: number }>
  /** When the evidence was earned; defaults to now. */
  occurredAt?: string | number
  config: SkillMasteryConfig
  source: string
}): Promise<void> {
  if (!args.perSkill.length) return
  const skillIds = args.perSkill.map((e) => e.skillId)

  const { data: prev } = await adminDb
    .from('skill_mastery')
    .select('skill_id, score, state, updated_at')
    .eq('section_id', args.sectionId)
    .eq('student_id', args.studentId)
    .in('skill_id', skillIds)
  const prevMap = new Map<string, { score: number | null; n: number; w: number; t: number | null; lastAt: number }>()
  for (const r of (prev ?? []) as Array<{
    skill_id: string
    score: number | null
    state: { n?: number; w?: number; t?: number; lastAt?: number } | null
    updated_at: string | null
  }>) {
    const n = typeof r.state?.n === 'number' ? r.state.n : r.score != null ? 1 : 0
    prevMap.set(r.skill_id, {
      score: r.score == null ? null : Number(r.score),
      n,
      // Rows written before the engine recorded accumulated weight fall back to
      // the event count, which is the right order of magnitude and self-corrects
      // on the next background recompute.
      w: typeof r.state?.w === 'number' ? r.state.w : n,
      t: typeof r.state?.t === 'number' ? r.state.t : r.score == null ? null : Number(r.score),
      // When the previous evidence landed. Without it the hook could not age
      // prior weight the way the rebuild does, so the two drifted apart with
      // every week that passed — a number that moved on its own.
      lastAt: typeof r.state?.lastAt === 'number'
        ? r.state.lastAt
        : r.updated_at
          ? Date.parse(r.updated_at)
          : 0,
    })
  }

  /* Age the standing evidence from when this work was EARNED, not from when the
     grade was entered. A professor clearing a two-week backlog would otherwise
     have every item dated today, decaying nothing, while the rebuild dates them
     properly — and the two answers would drift apart for no reason a user could
     see. Guarded: an unparseable or future date falls back to now. */
  const enteredMs = Date.now()
  const parsed = args.occurredAt == null ? NaN : new Date(args.occurredAt).getTime()
  const nowMs = Number.isFinite(parsed) && parsed > 0 && parsed <= enteredMs ? parsed : enteredMs
  const now = new Date(enteredMs).toISOString()
  const rows = args.perSkill.map(({ skillId: tid, pct: rawPct, weight }) => {
    const pct = Math.max(0, Math.min(100, rawPct))
    const p = prevMap.get(tid) ?? { score: null, n: 0, w: 0, t: null, lastAt: 0 }
    // Age the standing evidence exactly as foldMasteryEvents does, so the
    // incremental write and the authoritative rebuild are the same arithmetic on
    // the same inputs and cannot disagree for reasons a professor can see.
    const carried = p.t == null ? 0 : p.w * recencyDecay(nowMs - p.lastAt)
    const target = nextMasteryTarget(p.t, pct, weight, args.config, 50, p.t == null ? undefined : carried)
    const score = capMasteryMove(p.score, target, 50)
    return {
      section_id: args.sectionId,
      institution_id: args.institutionId,
      student_id: args.studentId,
      skill_id: tid,
      score: Math.round(score * 10) / 10,
      state: {
        n: p.n + 1,
        // Four decimals, not three: unlike the rebuild — which recomputes state
        // from scratch every time — the hook feeds its own rounding back in on
        // the next grade, so the error compounds.
        w: Math.round((carried + Math.max(0, weight)) * 10000) / 10000,
        t: Math.round(target * 10000) / 10000,
        lastAt: nowMs,
      },
      updated_at: now,
    }
  })

  const { error } = await adminDb
    .from('skill_mastery')
    .upsert(rows, { onConflict: 'student_id,skill_id' })
  if (error) {
    logger.error(`${args.source}: upsert failed`, error, {
      sectionId: args.sectionId,
      studentId: args.studentId,
    })
  }
}

/**
 * Fold one PASSED node check (roadmap §14) into the student's mastery — the
 * "small mastery boost" the quiz door advertises. Called from
 * `submitMyNodeCheck` ONLY on `firstPass` (the false→true transition), so a
 * re-submit after passing can never re-apply it; the section recompute
 * rebuilds the same one-event-per-item signal from `node_check_attempts`, so
 * the bump survives full rebuilds without double-counting.
 *
 * Attribution mirrors the recompute's fallback for unmapped signals: node
 * checks have no activity_skills rows, so the item's extracted topics
 * (`module_items.content.topics`) are name-matched to the section's leaf
 * skills. No match → silently nothing, same as an unmapped quiz.
 */
export async function applyNodeCheckPassToSkillMastery(ev: {
  sectionId: string
  studentId: string
  moduleItemId: string
}): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const [{ data: section }, { data: item }, { data: skillRows }] = await Promise.all([
      adminDb.from('course_sections').select('institution_id, settings').eq('id', ev.sectionId).maybeSingle(),
      // Section predicate IN the statement, not just in the caller's guards —
      // a second caller of this exported hook must not be able to attribute
      // another section's topics (same rule gradeNodeCheck applies to itself).
      adminDb
        .from('module_items')
        .select('content, modules!inner(section_id)')
        .eq('id', ev.moduleItemId)
        .eq('modules.section_id', ev.sectionId)
        .maybeSingle(),
      adminDb.from('skills').select('id, name, parent_id, excluded, suppressed').eq('section_id', ev.sectionId),
    ])
    if (!section?.institution_id) return

    const topics = Array.isArray(item?.content?.topics)
      ? (item.content.topics as unknown[]).filter((t): t is string => typeof t === 'string' && !!t.trim())
      : []
    if (!topics.length) return

    const all = (skillRows ?? []) as Array<{ id: string; name: string; parent_id: string | null; excluded: boolean; suppressed: boolean }>
    // Leaves only, matching the rebuild's node-check path.
    const skillIds = resolveLabels(topics, selectLeafSkills(all))
    if (!skillIds.length) return

    await foldEvidence(adminDb, {
      sectionId: ev.sectionId,
      institutionId: section.institution_id,
      studentId: ev.studentId,
      perSkill: skillIds.map((skillId) => ({ skillId, pct: 100, weight: NODE_CHECK_MASTERY_WEIGHT })),
      config: resolveSkillMasteryConfig(section.settings),
      source: 'applyNodeCheckPassToSkillMastery',
    })
  } catch (err) {
    logger.error('applyNodeCheckPassToSkillMastery: unexpected', err, { sectionId: ev.sectionId })
  }
}
