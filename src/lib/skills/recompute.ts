import 'server-only'

// Skill Mastery — the recompute engine, extracted so it can run from a
// background job (the extraction worker's 'recompute-mastery' kind) instead of a
// professor clicking a button. Pure: takes an admin Supabase client + a section
// id, no auth/request coupling.
//
// Idempotent: rebuilds skill_mastery for the section from scratch each run,
// folding ALL real evidence chronologically through the scoring engine so the
// decaying average is deterministic and re-running never double-counts. Sources:
//   - quizzes / exams / assignments: mapped via activity_skills (deterministic).
//   - live-classroom quizzes: tagged to leaf skills (or title name-matched);
//     gated by includeLiveQuiz.

import { logger } from '@/lib/logger'
import { resolveSkillMasteryConfig } from '@/lib/skills/config'
import { evidenceWeight, foldMasteryEvents, subscoresBySkill, splitPointsAcrossSkills, NODE_CHECK_MASTERY_WEIGHT, type MasteryEvent, type QuestionOutcome } from '@/lib/skills/scoring'
import { reconcileSectionSkills } from '@/lib/skills/reconcile'
import { canonicalizeName, matchInPool } from '@/lib/skills/canonical'
import { readAllPages } from '@/lib/supabase/paged-read'
import { selectLeafSkills } from '@/lib/skills/tree'
import { scoreQuizResponse } from '@/lib/live-classroom/interactions/aggregates'
import type { ActivityType } from '@/lib/validations/skill'
import { CHALLENGE_DIFFICULTY_STAKE, type ChallengeDifficulty } from '@/lib/validations/challenge'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

/** lowercase/normalise for fuzzy name-matching of unmapped signals (live quiz). */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

export interface RecomputeResult {
  updated: number // skill_mastery rows written
  events: number // evidence events folded
}

/**
 * Recompute one section's mastery. Throws on a fatal DB write error so the
 * caller (worker) can mark the job failed; returns counts on success.
 */
export async function recomputeSectionMastery(adminDb: AdminDb, sectionId: string): Promise<RecomputeResult> {
  const { data: section } = await adminDb
    .from('course_sections')
    .select('institution_id, settings')
    .eq('id', sectionId)
    .maybeSingle()
  const institutionId: string | undefined = section?.institution_id
  if (!institutionId) {
    logger.warn('recomputeSectionMastery: section not found', { sectionId })
    return { updated: 0, events: 0 }
  }
  const config = resolveSkillMasteryConfig(section?.settings)

  /* Reconcile the skill pool from all sources + auto-derive activity→skill
     mappings (de-duped, additive) BEFORE reading the pool below.
     Order is load-bearing, and getting it wrong is silent. Reconcile both mints
     new skills and promotes suppressed ones to tracked once a quiz tag
     corroborates them. Read the pool first and you get a pre-reconcile snapshot:
       - `excludedIds` still holds a skill reconcile just promoted, so every
         mapping to it is dropped and the section scores blank on its first run.
       - `tagPool` is empty on a section that had no skills, so resolveLabels
         finds nothing, subscoresBySkill produces nothing, and every skill on a
         quiz gets the same whole-quiz percentage — the exact smear
         subscoresBySkill exists to prevent.
     Both were invisible while only sections that already had skills were swept. */
  await reconcileSectionSkills(adminDb, sectionId)

  // Subskills (leaf level mastery is scored at) — also used for name-matching.
  // Excluded skills are dropped from scoring (uncheck-to-drop in the modal).
  const { data: skillRows } = await adminDb
    .from('skills')
    .select('id, name, parent_id, excluded, suppressed')
    .eq('section_id', sectionId)
  const allSkills = (skillRows ?? []) as Array<{
    id: string
    name: string
    parent_id: string | null
    excluded: boolean
    suppressed: boolean
  }>
  // Leaf skills are where mastery is scored — a subtopic, OR a childless
  // top-level skill (which is its own leaf). This matches the mapped-quiz path,
  // which already feeds any tagged skill, so live quizzes aren't artificially
  // limited to sections that happen to use subtopics.
  const leaves = selectLeafSkills(allSkills)
  // Untracked skills drop out of ALL scoring — including mapped quiz/assignment
  // evidence. Both excluded (professor dropped) and suppressed (AI-suggested, not
  // yet corroborated) count as untracked.
  const excludedIds = new Set(allSkills.filter((t) => t.excluded || t.suppressed).map((t) => t.id))
  /* One resolution rule for every attribution path in this file.
     Sorted longest-canonical-first, then id: matchInPool returns the FIRST pool
     entry a candidate matches by substring, and the skills query carries no
     ORDER BY, so an ambiguous name could resolve differently on two runs of the
     same data. Longest first also makes the most SPECIFIC skill win, which is
     what stops a topic named "Integrated rate laws" from also crediting a
     separate "Rate laws". An exact canonical match is tried before any of this,
     so unambiguous names are unaffected. */
  const asPool = (rows: Array<{ id: string; name: string }>) =>
    rows
      .map((t) => ({ id: t.id, canonical: canonicalizeName(t.name) }))
      .sort((a, b) => b.canonical.length - a.canonical.length || a.id.localeCompare(b.id))
  /** Question tags. Any tracked level — a tag legitimately names a parent. */
  const tagPool = asPool(allSkills.filter((t) => !t.excluded && !t.suppressed))
  /** Node-check topics. Leaves only, matching what this path has always scored. */
  const leafPool = asPool(leaves)
  /** Deliberate labels → at most one skill each. Untracked skills are absent from
   *  both pools, so an excluded skill can never be resolved back into scoring. */
  const resolveLabels = (labels: string[], pool: Array<{ id: string; canonical: string }>): string[] => {
    const ids = new Set<string>()
    for (const label of labels) {
      const id = matchInPool(label, pool)
      if (id) ids.add(id)
    }
    return [...ids]
  }
  /* Free prose (a live-quiz TITLE), where containment is the point: "Rate laws
     practice" should find "Rate laws". Keeps the substring sweep but returns only
     the most specific hit, so a title naming the narrower concept does not also
     credit the broader one. */
  const matchLeaf = (text: string): string[] => {
    const t = norm(text)
    const hits = leaves.filter((s) => s.name.length >= 3 && t.includes(norm(s.name)))
    if (hits.length <= 1) return hits.map((s) => s.id)
    const longest = Math.max(...hits.map((s) => s.name.length))
    return hits.filter((s) => s.name.length === longest).map((s) => s.id)
  }

  // Paged: one row per (activity, skill). A section with many activities
  // crosses PostgREST's silent 1000-row cap, and a truncated mapping does not
  // weaken mastery — it drops whole activities out of it.
  const maps = await readAllPages<{ activity_type: ActivityType; activity_id: string; skill_id: string }>(
    () => adminDb.from('activity_skills').select('activity_type, activity_id, skill_id').eq('section_id', sectionId),
    'id',
    'recomputeSectionMastery.activity_skills',
  )
  const mappings = (maps ?? []) as Array<{ activity_type: ActivityType; activity_id: string; skill_id: string }>
  const subsByActivity = new Map<string, string[]>()
  const quizIds = new Set<string>()
  const assignmentIds = new Set<string>()
  for (const m of mappings) {
    if (excludedIds.has(m.skill_id)) continue // excluded skill → never scored
    const arr = subsByActivity.get(`${m.activity_type}:${m.activity_id}`) ?? []
    arr.push(m.skill_id)
    subsByActivity.set(`${m.activity_type}:${m.activity_id}`, arr)
    if (m.activity_type === 'quiz' || m.activity_type === 'exam') quizIds.add(m.activity_id)
    if (m.activity_type === 'assignment') assignmentIds.add(m.activity_id)
  }

  type Ev = MasteryEvent
  const events: Ev[] = []
  const clampPct = (n: number) => Math.max(0, Math.min(100, n))

  /* `.in(col, ids)` becomes a query STRING, so a few thousand uuids build a
     request PostgREST rejects outright — and the rejection surfaces as an empty
     result, not an error, which silently drops the evidence. Read in chunks. */
  const IN_CHUNK = 150
  async function readAllIn<T>(
    table: string,
    columns: string,
    column: string,
    ids: string[],
    source: string,
  ): Promise<T[]> {
    const out: T[] = []
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const slice = ids.slice(i, i + IN_CHUNK)
      out.push(
        ...(await readAllPages<T>(
          () => adminDb.from(table).select(columns).in(column, slice),
          'id',
          source,
        )),
      )
    }
    return out
  }

  // Quizzes / exams (mapped, deterministic).
  if (quizIds.size) {
    // Paged: students × quizzes. At 30 students and 74 quizzes this is already
    // 2 220 rows, so an unpaged read silently kept the first 1 000 and every
    // later quiz simply never counted toward mastery.
    const attempts = await readAllPages<Record<string, unknown>>(
      () => adminDb.from('quiz_attempts').select('id, quiz_id, student_id, earned_points, total_points, score, status, submitted_at')
        .in('quiz_id', [...quizIds]).in('status', ['submitted', 'graded']),
      'id',
      'recomputeSectionMastery.quiz_attempts',
    )
    /* Per-question skill resolution. A quiz's OVERALL percentage used to be
       recorded against every skill it touched, so two topics tested in one quiz
       came out identical and the professor could not tell which to re-teach.
       `quiz_answers` already stores what each question earned and
       `quiz_questions.tags` says which skill it tests, so the split is derivable
       without a schema change. Resolution is intersected with the quiz's
       activity_skills mapping, which has already dropped excluded and suppressed
       skills — a tag must never reach a skill the professor stopped tracking. */
    const attemptIds = (attempts ?? []).map((a) => String((a as Record<string, unknown>).id)).filter(Boolean)
    const answers = await readAllIn<{ attempt_id: string; question_id: string; earned_points: number | null }>(
      'quiz_answers', 'id, attempt_id, question_id, earned_points', 'attempt_id', attemptIds,
      'recomputeSectionMastery.quiz_answers',
    )
    const answersByAttempt = new Map<string, Array<{ question_id: string; earned_points: number | null }>>()
    for (const r of answers) {
      const list = answersByAttempt.get(r.attempt_id) ?? []
      list.push({ question_id: r.question_id, earned_points: r.earned_points })
      answersByAttempt.set(r.attempt_id, list)
    }

    const questionIds = [...new Set(answers.map((r) => r.question_id))]
    const questionMeta = new Map<string, { points: number; skillIds: string[] }>()
    if (questionIds.length) {
      const qRows = await readAllIn<{ id: string; tags: string[] | null; points: number | null }>(
        'quiz_questions', 'id, tags, points', 'id', questionIds,
        'recomputeSectionMastery.quiz_questions',
      )
      for (const q of qRows)
        questionMeta.set(q.id, { points: Number(q.points) || 1, skillIds: resolveLabels(q.tags ?? [], tagPool) })
    }

    for (const a of (attempts ?? []) as Array<Record<string, unknown>>) {
      const total = Number(a.total_points) || 0
      const pct = total > 0 ? clampPct(((Number(a.earned_points) || 0) / total) * 100) : clampPct(Number(a.score) || 0)
      const at = a.submitted_at ? Date.parse(String(a.submitted_at)) : 0
      const subs = subsByActivity.get(`quiz:${a.quiz_id}`) ?? subsByActivity.get(`exam:${a.quiz_id}`) ?? []
      if (!subs.length) continue
      const mapped = new Set(subs)

      const rows = answersByAttempt.get(String(a.id)) ?? []
      const outcomes: QuestionOutcome[] = []
      for (const r of rows) {
        const meta = questionMeta.get(r.question_id)
        if (!meta) continue
        const skillIds = meta.skillIds.filter((sid) => mapped.has(sid))
        if (!skillIds.length) continue
        outcomes.push({ skillIds, earned: Number(r.earned_points) || 0, possible: meta.points })
      }

      const subscores = subscoresBySkill(outcomes)
      if (subscores.length) {
        for (const sub of subscores)
          events.push({
            studentId: String(a.student_id),
            skillId: sub.skillId,
            pct: sub.pct,
            at,
            weight: evidenceWeight(config, 'quiz', sub.points),
          })
        /* A skill the mapping claims this quiz covers, but for which no answered
           question resolved: fall back to the whole-quiz figure so the evidence is
           not silently lost. Happens with untagged questions and with attempts
           predating per-question storage. */
        for (const tid of subs)
          if (!subscores.some((sub) => sub.skillId === tid))
            events.push({ studentId: String(a.student_id), skillId: tid, pct, at, weight: evidenceWeight(config, 'quiz', total || 1) })
      } else {
        // No per-question detail at all — the pre-existing whole-quiz behaviour.
        const weight = evidenceWeight(config, 'quiz', total || 1)
        for (const tid of subs) events.push({ studentId: String(a.student_id), skillId: tid, pct, at, weight })
      }
    }
  }

  // Assignments (mapped, deterministic).
  if (assignmentIds.size) {
    const { data: asg } = await adminDb.from('assignments').select('id, points').in('id', [...assignmentIds])
    const pointsById = new Map<string, number>(
      ((asg ?? []) as Array<{ id: string; points: number | null }>).map((r) => [r.id, Number(r.points) || 0]),
    )
    // Paged for the same reason as the attempts scan above.
    const subsData = await readAllPages<Record<string, unknown>>(
      () => adminDb.from('assignment_submissions').select('assignment_id, student_id, score, graded_at, submitted_at')
        .in('assignment_id', [...assignmentIds]).not('graded_at', 'is', null),
      'id',
      'recomputeSectionMastery.assignment_submissions',
    )
    for (const s of (subsData ?? []) as Array<Record<string, unknown>>) {
      const raw = Number(s.score)
      if (Number.isNaN(raw)) continue
      const pts = pointsById.get(String(s.assignment_id)) ?? 0
      const pct = pts > 0 ? clampPct((raw / pts) * 100) : clampPct(raw)
      const at = s.graded_at
        ? Date.parse(String(s.graded_at))
        : s.submitted_at
          ? Date.parse(String(s.submitted_at))
          : 0
      /* One holistic score, several skills. Splitting the points before weighting
         stops the vaguest evidence outvoting the sharpest: unsplit, a 100-point
         assignment weighed 15.3 against each of four skills while a precise
         3-question quiz subscore weighed 2.6. */
      const asnSubs = subsByActivity.get(`assignment:${s.assignment_id}`) ?? []
      const perSkillPoints = splitPointsAcrossSkills(pts || 1, asnSubs.length)
      const weight = evidenceWeight(config, 'assignment', perSkillPoints)
      for (const tid of asnSubs)
        events.push({ studentId: String(s.student_id), skillId: tid, pct, at, weight })
    }
  }

  // Live-classroom quizzes. Reads the live-classroom system: lc_rooms (this
  // section) → lc_interactions (kind='quiz', the quiz + correct answers live in
  // `payload`) → lc_responses (each student's answers). Grade each response
  // against the payload; attribute it to the subtopics the questions are tagged
  // with (payload questions carry skillIds — AI-mapped or professor-picked),
  // falling back to name-matching the quiz title when a quiz has no tags.
  const leafIdSet = new Set(leaves.map((s) => s.id))
  if (config.includeLiveQuiz && leaves.length) {
    const { data: rooms } = await adminDb.from('lc_rooms').select('id').eq('section_id', sectionId)
    const roomIds = ((rooms ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (roomIds.length) {
      const { data: lq } = await adminDb
        .from('lc_interactions')
        .select('id, payload')
        .eq('kind', 'quiz')
        .in('room_id', roomIds)
      const quizzes = (lq ?? []) as Array<{ id: string; payload: unknown }>
      if (quizzes.length) {
        const byId = new Map(quizzes.map((q) => [q.id, q]))
        const resp = await readAllPages<Record<string, unknown>>(
          () => adminDb.from('lc_responses').select('interaction_id, student_id, response, submitted_at')
            .in('interaction_id', quizzes.map((q) => q.id)),
          'id',
          'recomputeSectionMastery.lc_responses',
        )
        for (const r of (resp ?? []) as Array<Record<string, unknown>>) {
          const quiz = byId.get(String(r.interaction_id))
          if (!quiz) continue
          const payload = (quiz.payload ?? {}) as {
            title?: string
            questions?: Array<{ id: string; correctChoiceId: string; skillIds?: string[] }>
          }
          const questions = Array.isArray(payload.questions) ? payload.questions : []
          if (!questions.length) continue
          const answers = (r.response as { answers?: Record<string, string> } | null)?.answers ?? {}
          const pct = clampPct(scoreQuizResponse(questions, answers) * 100)
          const at = r.submitted_at ? Date.parse(String(r.submitted_at)) : 0
          const weight = evidenceWeight(config, 'quiz', questions.length)
          // Attribution shares ONE source with coverage: the activity_skills rows
          // reconcile writes for this live quiz (activity_type='live_quiz' — from
          // the questions' skill tags + the room's module inheritance). Keep only
          // real (non-excluded) leaf skills. Fall back to the payload's per-question
          // tags, then to title name-matching, for a room not yet reconciled.
          const tagged = new Set<string>(
            (subsByActivity.get(`live_quiz:${String(r.interaction_id)}`) ?? []).filter((tid) => leafIdSet.has(tid)),
          )
          if (!tagged.size)
            for (const q of questions)
              for (const tid of q.skillIds ?? []) if (leafIdSet.has(tid)) tagged.add(tid)
          const targets = tagged.size ? [...tagged] : matchLeaf(payload.title || '')
          for (const tid of targets)
            events.push({ studentId: String(r.student_id), skillId: tid, pct, at, weight })
        }
      }
    }
  }

  // Node checks (roadmap §14, the quiz door's "small mastery boost"): one
  // binary, deliberately tiny event per PASSED check — pct 100 at
  // NODE_CHECK_MASTERY_WEIGHT. Structurally capped: node_check_attempts is
  // UNIQUE per (student, item) and `passed` never regresses, so retries can't
  // stack it. Rebuilding it here is what lets the incremental hook's bump
  // (applyNodeCheckPassToSkillMastery) survive a full recompute. Attribution
  // mirrors the live-quiz fallback: the item has no activity_skills rows, so
  // its extracted topics name-match to leaf skills (excluded ones dropped).
  if (leaves.length) {
    const passedRows = await readAllPages<{ module_item_id: string; student_id: string; updated_at: string | null }>(
      () => adminDb.from('node_check_attempts').select('module_item_id, student_id, updated_at')
        .eq('section_id', sectionId).eq('passed', true),
      'id',
      'recomputeSectionMastery.node_check_attempts',
    )
    const checks = (passedRows ?? []) as Array<{ module_item_id: string; student_id: string; updated_at: string | null }>
    if (checks.length) {
      const itemIds = [...new Set(checks.map((c) => c.module_item_id))]
      const { data: checkedItems } = await adminDb.from('module_items').select('id, content').in('id', itemIds)
      const skillsByItem = new Map<string, string[]>()
      for (const it of (checkedItems ?? []) as Array<{ id: string; content: { topics?: unknown } | null }>) {
        const topics = Array.isArray(it.content?.topics)
          ? (it.content!.topics as unknown[]).filter((t): t is string => typeof t === 'string' && !!t.trim())
          : []
        // The SAME function the incremental hook resolves attribution with —
        // shared so a rebuild reproduces exactly what the hook applied.
        // Deliberate labels, same rule as question tags — a topic naming the
        // narrower concept must not also credit the broader one.
        const ids = resolveLabels(topics, leafPool)
        if (ids.length) skillsByItem.set(it.id, ids)
      }
      for (const c of checks) {
        const at = c.updated_at ? Date.parse(String(c.updated_at)) : 0
        for (const tid of skillsByItem.get(c.module_item_id) ?? [])
          events.push({ studentId: c.student_id, skillId: tid, pct: 100, at, weight: NODE_CHECK_MASTERY_WEIGHT })
      }
    }
  }

  /* Approved challenges (#599). The incremental hook (applyGradeToSkillMastery with
     activityType 'challenge') bumped skill_mastery on approval, but this recompute REPLACES
     the table and had no challenge source — so any unrelated grade or submission in the
     section silently erased recorded challenge evidence, and the number just read lower.

     Rebuilt here for the same reason the node-check block above is: a rebuild has to
     reproduce what the hook applied. Weight matches the hook exactly — stake × max(1,1) with
     points = 1 — so folding it here neither double-counts nor under-counts.

     Claims carry no section_id, so scope through the section's own challenges. A challenge is
     binary: approval is 100% evidence. */
  const { data: sectionChallenges } = await adminDb
    .from('challenges')
    .select('id, difficulty')
    .eq('section_id', sectionId)
  const challengeRows = (sectionChallenges ?? []) as Array<{ id: string; difficulty: string | null }>
  if (challengeRows.length) {
    const difficultyById = new Map(challengeRows.map((c) => [c.id, c.difficulty]))
    const claims = await readAllPages<{ challenge_id: string; user_id: string; reviewed_at: string | null; updated_at: string | null }>(
      () => adminDb.from('challenge_claims').select('challenge_id, user_id, reviewed_at, updated_at')
        .in('challenge_id', challengeRows.map((c) => c.id)).eq('status', 'approved'),
      'id',
      'recomputeSectionMastery.challenge_claims',
    )
    for (const cl of (claims ?? []) as Array<{ challenge_id: string; user_id: string; reviewed_at: string | null; updated_at: string | null }>) {
      const subs = subsByActivity.get(`challenge:${cl.challenge_id}`) ?? []
      if (!subs.length) continue // unmapped challenge → nothing to attribute, same as an unmapped quiz
      const difficulty = (difficultyById.get(cl.challenge_id) ?? 'medium') as ChallengeDifficulty
      const stake = CHALLENGE_DIFFICULTY_STAKE[difficulty] ?? CHALLENGE_DIFFICULTY_STAKE.medium
      const at = Date.parse(String(cl.reviewed_at ?? cl.updated_at ?? '')) || 0
      for (const tid of subs)
        events.push({ studentId: String(cl.user_id), skillId: tid, pct: 100, at, weight: stake })
    }
  }

  // Fold chronologically through the engine (shared with the stress harness).
  const state = foldMasteryEvents(events, config, 50)

  // Rebuild skill_mastery for the section atomically: the RPC deletes the
  // section's rows and inserts the new set in one transaction, serialized per
  // section by an advisory lock, so two concurrent recomputes can't interleave
  // their delete/insert and collide on the (student_id, skill_id) unique key.
  const rows = [...state.entries()].map(([key, v]) => {
    const [studentId, skillId] = key.split(':')
    return {
      student_id: studentId,
      skill_id: skillId,
      score: Math.round(v.score * 10) / 10,
      state: { n: v.n, w: Math.round(v.w * 10000) / 10000, t: Math.round(v.t * 10000) / 10000, lastAt: v.lastAt },
    }
  })
  const { error } = await adminDb.rpc('replace_section_skill_mastery', {
    p_section_id: sectionId,
    p_institution_id: institutionId,
    p_rows: rows,
  })
  if (error) {
    logger.error('recomputeSectionMastery: replace failed', error, { sectionId })
    throw new Error('skill_mastery replace failed')
  }

  logger.info('recomputeSectionMastery: done', { sectionId, events: events.length, rows: rows.length })
  return { updated: rows.length, events: events.length }
}
