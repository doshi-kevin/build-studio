// Skill Mastery — validation schemas and shared types for the per-section
// skill hierarchy (Slice 1). The `skills` table is two-level: a main skill
// (parent_id = null) with subtopics (parent_id -> a main skill).

import { z } from 'zod'

export const TOPIC_NAME_MAX = 120

/** Persisted skill row. Mirrors the `skills` table; `types.ts` regenerates
 *  from the migration once it's applied, after which reads can drop the cast. */
export interface SkillRow {
  id: string
  section_id: string
  institution_id: string
  parent_id: string | null
  name: string
  info: string | null
  source: 'ai' | 'professor'
  placement_pinned: boolean
  /** Soft-exclude: kept in the pool but not tracked for mastery (uncheck to drop). */
  excluded: boolean
  /** AI-suggested but not yet corroborated — in the pool, shown in Curate as a
   *  "Suggested" opt-in, but NOT scored/coverage-counted until the professor (or
   *  the reconcile corroboration gate) promotes it. Distinct from `excluded`
   *  (professor dropped it). */
  suppressed: boolean
  /** The `course_skills` entry this skill was seeded from, or now feeds. Null =
   *  curated only in this section so far (src/lib/skills/library.ts). */
  library_skill_id: string | null
  position: number
  created_at: string
  updated_at: string
}

/** A main skill with its subtopics — the shape the editor renders. */
export interface SkillTreeNode extends SkillRow {
  subtopics: SkillRow[]
}

const skillName = z
  .string()
  .trim()
  .min(1, 'Enter a skill name.')
  .max(TOPIC_NAME_MAX, `Keep it under ${TOPIC_NAME_MAX} characters.`)

export const addSkillSchema = z.object({
  sectionId: z.string().uuid(),
  name: skillName,
  // null/absent => a main skill; a uuid => a subtopic of that main skill.
  parentId: z.string().uuid().nullable().optional(),
})

export const renameSkillSchema = z.object({
  sectionId: z.string().uuid(),
  skillId: z.string().uuid(),
  name: skillName,
})

export const deleteSkillSchema = z.object({
  sectionId: z.string().uuid(),
  skillId: z.string().uuid(),
})

/** Soft-exclude / re-include a skill (the modal's include checkbox). */
export const setSkillExcludedSchema = z.object({
  sectionId: z.string().uuid(),
  skillId: z.string().uuid(),
  excluded: z.boolean(),
})

/** Promote a suggested skill to tracked (suppressed=false), or push back to
 *  suggested. Drives the Curate "Suggested" group's Track button. */
export const setSkillSuppressedSchema = z.object({
  sectionId: z.string().uuid(),
  skillId: z.string().uuid(),
  suppressed: z.boolean(),
})

/** One AI-suggested main skill with its subtopics — ephemeral, returned to the
 *  client for review; the accepted subset is inserted via applySkillSuggestions. */
export const suggestedSkillSchema = z.object({
  name: skillName,
  info: z.string().trim().max(500).optional(),
  subtopics: z
    .array(
      z.object({
        name: skillName,
        info: z.string().trim().max(500).optional(),
      }),
    )
    .default([]),
})
export type SuggestedSkill = z.infer<typeof suggestedSkillSchema>

export const applySkillSuggestionsSchema = z.object({
  sectionId: z.string().uuid(),
  skills: z.array(suggestedSkillSchema).min(1).max(60),
})

// ── Activity ↔ skill mapping ────────────────────────────────────

export const ACTIVITY_TYPES = ['quiz', 'assignment', 'exam', 'challenge'] as const
export type ActivityType = (typeof ACTIVITY_TYPES)[number]

export interface ActivitySkillRow {
  id: string
  section_id: string
  activity_id: string
  activity_type: ActivityType
  skill_id: string
}

// ── Review modal: confirm the full reviewed skill tree ──────────
// The modal is the canonical list editor — Confirm reconciles the section's
// skills to exactly this tree (upsert by id, insert new, drop omitted).

const reviewedNodeBase = {
  id: z.string().uuid().optional(), // present = existing row; absent = insert
  name: skillName,
  source: z.enum(['ai', 'professor']).default('ai'),
  // pinned = professor placed it; AI re-suggestion won't move it later.
  pinned: z.boolean().default(false),
}

export const reviewedSkillSchema = z.object({
  ...reviewedNodeBase,
  subtopics: z.array(z.object(reviewedNodeBase)).default([]),
})
export type ReviewedSkill = z.infer<typeof reviewedSkillSchema>

export const confirmSkillReviewSchema = z.object({
  sectionId: z.string().uuid(),
  skills: z.array(reviewedSkillSchema).max(80),
})

// ── Placement (drag re-parent / Move) + reorder ─────────────────

export const setSkillPlacementSchema = z.object({
  sectionId: z.string().uuid(),
  skillId: z.string().uuid(),
  // null => promote to main skill; uuid => nest under that main skill.
  parentId: z.string().uuid().nullable(),
  // professor placements pin by default; AI moves never pin.
  pinned: z.boolean().default(true),
})

export const reorderSkillsSchema = z.object({
  sectionId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  orderedIds: z.array(z.string().uuid()).max(200),
})

// ── Mastery (read models for the dashboard / drill-down / roadmap) ──

export interface MasteryRow {
  student_id: string
  skill_id: string
  score: number | null
}

/** One main skill with its rolled-up class score + per-subtopic class scores. */
export interface SkillClassScore {
  skillId: string
  name: string
  parentId: string | null
  source: 'ai' | 'professor'
  classScore: number | null
  subtopics: Array<{ skillId: string; name: string; classScore: number | null; source: 'ai' | 'professor' }>
}
