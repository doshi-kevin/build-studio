/**
 * Pure draft → server-action-input translators for the professor AI assistant.
 *
 * These are pulled into a pure,
 * server-import-free module so they can be unit-tested directly (the approve
 * actions themselves are `'use server'` and pull in next/cache, so they can't
 * be imported in jsdom tests). Each translator maps the loose camelCase draft
 * the MODEL produces into the exact (snake_case) shape an EXISTING vetted
 * server action accepts; the action re-validates against its strict schema.
 */

import type { CreateChallengeInput } from '@/lib/validations/challenge'
import type { CreateAssignmentInput } from '@/lib/validations/assignment'
import type { ChallengeDraft, RubricDraft, FeedbackDraft, AssignmentDraft } from './schemas'

/** draft_challenge → createChallenge input. badge_id is deliberately never set
 *  (the model can't know real badge UUIDs). */
export function toChallengeInput(d: ChallengeDraft): CreateChallengeInput {
  return {
    title: d.title,
    description: d.description ?? '',
    type: d.type,
    difficulty: d.difficulty,
    points: d.points,
    bonus_points: d.bonusPoints,
    max_claims: d.maxClaims ?? null,
    due_at: d.dueDate ?? null,
    // The model can't know real section skill UUIDs; the professor links skills in the UI.
    skill_ids: [],
  }
}

/** draft_rubric → a single markdown block, appended to the chosen project.
 *  Renders per-criterion so criteria with differing level counts stay readable. */
export function rubricToMarkdown(d: RubricDraft): string {
  const lines: string[] = [`## ${d.title}`, '']
  for (const c of d.criteria) {
    lines.push(`### ${c.name}${c.description ? ` — ${c.description}` : ''}`)
    for (const lvl of c.levels) {
      lines.push(`- **${lvl.label}** (${lvl.points} pts): ${lvl.description}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}

/** draft_assignment → createAssignment input. dueDate → dueAt (empty → null);
 *  the strict createAssignmentSchema re-validates points + fileTypes server-side. */
export function toAssignmentInput(d: AssignmentDraft): CreateAssignmentInput {
  return {
    title: d.title,
    instructions: d.instructions ?? '',
    dueAt: d.dueDate || null,
    points: d.points,
    fileTypes: d.fileTypes,
  }
}

/** draft_feedback → the message body posted via the reply path. There is no
 *  score anywhere in the pipeline — feedback is qualitative only. */
export function feedbackToMessage(d: FeedbackDraft): string {
  return d.feedback.trim()
}
