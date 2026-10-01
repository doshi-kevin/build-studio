import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseAboutContent, type LearningOutcomesBlock } from '@/lib/validations/course-about'
import { skillQueries } from '@/lib/supabase/queries'
import { resolveSkillMasteryConfig } from '@/lib/skills/config'
import { aggregateSectionMastery } from '@/lib/skills/aggregate'
import type { EvidenceCandidate } from './types'

export interface GatheredEvidence {
  candidates: EvidenceCandidate[]
  /** tag → accuracy (0–100), from submitted quiz answers. */
  /** Class mastery per curated skill, keyed by skill ID. Was keyed by raw quiz
   *  tag; skill IDs are stable, so renaming a skill no longer churns the
   *  attainment hash and forces a needless re-run. */
  masteryBySkill: Record<string, number>
  /** total scored answers — the min-N gate for showing attainment. */
  quizResponseCount: number
}

const QUIZ_SIGNAL_MAX_QUESTIONS = 40

interface ModuleItemContent {
  extraction?: { status?: string; summary?: string; topics?: string[] }
  summary?: string
  topics?: string[]
}

/**
 * Stage 1 — deterministic gather. Reads a section's outcome-bearing artifacts
 * (CLOs, lecture summaries+topics, assignments+rubrics, quizzes) and normalizes
 * them into evidence candidates, plus per-tag quiz mastery for attainment.
 * No AI here.
 */
export async function gatherEvidence(
  admin: SupabaseClient,
  sectionId: string,
): Promise<GatheredEvidence> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = admin as any
  const candidates: EvidenceCandidate[] = []

  // 1. CLOs — from course_sections.settings "about" blocks.
  const { data: section } = await db
    .from('course_sections')
    .select('settings')
    .eq('id', sectionId)
    .maybeSingle()
  if (section?.settings) {
    const about = parseAboutContent(section.settings)
    const loBlock = about.blocks.find((b) => b.type === 'learning-outcomes') as
      | LearningOutcomesBlock
      | undefined
    for (const o of loBlock?.data.outcomes ?? []) {
      const text = o.text?.trim()
      if (text) {
        candidates.push({
          sourceType: 'clo',
          // CLOs live in course_sections.settings JSON, so o.id is an editor-local
          // id (e.g. "lo-6"), NOT a DB uuid — and evidence_source_id is a uuid column.
          // There's no CLO table to reference, so store null; the CLO text is in signal.
          sourceId: null,
          // Distinct, readable worker name for the roster (CLOs share no title otherwise).
          title: `Learning outcome: ${text.length > 44 ? `${text.slice(0, 44)}…` : text}`,
          signal: text,
          cap: 'R',
        })
      }
    }
  }

  /* 2. Modules themselves, then the material inside them.
     The module's own title + description used to be invisible here — this selected `id`
     alone, purely to reach the items — so a professor editing a description to describe
     their content better changed nothing the mapper reads, the content hash was identical,
     and the re-run early-aborted as "unchanged" (#631). Ordered by id for the same reason
     the item query is: Postgres row order is arbitrary and repeated runs must see identical
     inputs, or the hash churns on its own. */
  const { data: modules } = await db
    .from('modules')
    .select('id, title, description')
    .eq('section_id', sectionId)
    .order('id')
  const moduleIds = (modules ?? []).map((m: { id: string }) => m.id)
  for (const m of (modules ?? []) as Array<{ id: string; title: string | null; description: string | null }>) {
    const parts = [m.title, m.description].filter((v): v is string => !!v && v.trim().length > 0)
    // A module with neither is pure structure and carries no signal to map.
    if (parts.length === 0) continue
    candidates.push({
      sourceType: 'module',
      sourceId: m.id,
      title: m.title || 'Module',
      signal: parts.join('\n'),
      cap: 'R',
    })
  }
  if (moduleIds.length > 0) {
    const { data: items } = await db
      .from('module_items')
      .select('id, title, content')
      .in('module_id', moduleIds)
      .eq('is_visible', true)
      .order('id') // stable order — Postgres row order is otherwise arbitrary, and repeated runs must see identical inputs
    for (const it of (items ?? []) as Array<{ id: string; title: string; content: ModuleItemContent | null }>) {
      const summary = it.content?.extraction?.summary ?? it.content?.summary
      const topics = it.content?.extraction?.topics ?? it.content?.topics ?? []
      const parts = [summary, topics.length ? `Topics: ${topics.join(', ')}` : ''].filter(Boolean)
      if (parts.length === 0) continue // not extracted yet — no signal
      candidates.push({
        sourceType: 'module_item',
        sourceId: it.id,
        title: it.title || 'Lecture',
        signal: parts.join('\n'),
        cap: 'R',
      })
    }
  }

  // 3. Assignments.
  const { data: assignments } = await db
    .from('assignments')
    .select('id, title, description, guidelines, rubric')
    .eq('section_id', sectionId)
    .order('id')
  for (const a of (assignments ?? []) as Array<{
    id: string
    title: string
    description: string
    guidelines: string
    rubric: Array<{ concept?: string; criterion?: string }> | null
  }>) {
    const rubricConcepts = Array.isArray(a.rubric)
      ? a.rubric.map((r) => r?.concept ?? r?.criterion ?? '').filter(Boolean).join('; ')
      : ''
    const parts = [a.title, a.description, a.guidelines, rubricConcepts ? `Rubric: ${rubricConcepts}` : ''].filter(Boolean)
    candidates.push({
      sourceType: 'assignment',
      sourceId: a.id,
      title: a.title || 'Assignment',
      signal: parts.join('\n'),
      cap: 'M',
    })
  }

  // 4. Quizzes — one section-level aggregate candidate + per-tag mastery.
  const { data: questions } = await db
    .from('quiz_questions')
    .select('id, question_text, tags')
    .eq('section_id', sectionId)
    .order('id') // the signal samples the first 40 questions — the subset must be stable across runs
  const questionRows = (questions ?? []) as Array<{ id: string; question_text: string; tags: string[] | null }>
  const masteryBySkill: Record<string, number> = {}
  let quizResponseCount = 0

  if (questionRows.length > 0) {
    const allTags = Array.from(new Set(questionRows.flatMap((q) => q.tags ?? []))).sort()
    const sampleTexts = questionRows
      .slice(0, QUIZ_SIGNAL_MAX_QUESTIONS)
      .map((q) => q.question_text)
      .filter(Boolean)
    const signalParts = [
      allTags.length ? `Topics assessed: ${allTags.join(', ')}` : '',
      sampleTexts.length ? `Sample questions:\n- ${sampleTexts.join('\n- ')}` : '',
    ].filter(Boolean)
    if (signalParts.length > 0) {
      candidates.push({ sourceType: 'quiz', sourceId: null, title: 'Quizzes', signal: signalParts.join('\n'), cap: 'M' })
    }

    const { data: attempts } = await db
      .from('quiz_attempts')
      .select('id')
      .eq('section_id', sectionId)
      .eq('status', 'submitted')
    const attemptIds = (attempts ?? []).map((a: { id: string }) => a.id)
    if (attemptIds.length > 0) {
      const { data: answerRows } = await db
        .from('quiz_answers')
        .select('question_id, is_correct')
        .in('attempt_id', attemptIds)
      const answers = ((answerRows ?? []) as Array<{ question_id: string; is_correct: boolean | null }>)
        .filter((a) => a.is_correct !== null)
        .map((a) => ({ questionId: a.question_id, isCorrect: a.is_correct === true }))
      quizResponseCount = answers.length
    }
  }

  /* Mastery is computed for EVERY section, not only sections with quizzes.
     It used to sit inside the two quiz conditionals above, which was right when
     the number was literally counted from quiz answers. It is now the curated
     skill mastery, which folds in assignments, live-classroom quizzes and node
     checks — so gating it on quizzes existing meant an assignments-only course
     silently contributed nothing.

     Note what this does NOT change: reduce.ts still gates attainment on
     quizResponseCount >= MIN_QUIZ_RESPONSES and attaches it only to
     quiz-sourced indicators, so an assignments-only course still reports no
     attainment. That gate is now the limiting factor rather than this fetch.
     Changing it alters what accreditation attainment means, which is a product
     call, so it stays for a separate change. */
  const [skillRows, masteryRows, sectionRes] = await Promise.all([
    skillQueries.listSectionSkills(db, sectionId),
    skillQueries.getSectionMasteryRows(db, sectionId),
    db.from('course_sections').select('settings').eq('id', sectionId).maybeSingle(),
  ])
  const tracked = (skillRows ?? []).filter((s) => !s.excluded && !s.suppressed)
  const view = aggregateSectionMastery(tracked, masteryRows ?? [], resolveSkillMasteryConfig(sectionRes?.data?.settings))
  for (const t of view.ranked) {
    if (t.classScore != null) masteryBySkill[t.skillId] = t.classScore
  }

  return { candidates, masteryBySkill, quizResponseCount }
}
