/**
 * Project Validation Schemas — Zod schemas for project workspace CRUD.
 *
 * Used in:
 * 1. Client-side: react-hook-form resolver for instant form validation
 * 2. Server-side: server actions validate input as defense in depth
 */

import { z } from 'zod'

// ── Enums ────────────────────────────────────────────────────────

export const PROJECT_STATUSES = ['draft', 'active', 'completed', 'archived'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const PROJECT_VISIBILITIES = ['private', 'course', 'public'] as const
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number]

export const MEMBER_ROLES = ['owner', 'member', 'viewer'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

export const PHASE_STATUSES = ['not_started', 'in_progress', 'completed', 'blocked'] as const
export type PhaseStatus = (typeof PHASE_STATUSES)[number]

export const CONTRIBUTOR_STATUSES = ['pending', 'approved', 'rejected'] as const
export type ContributorStatus = (typeof CONTRIBUTOR_STATUSES)[number]

// ── Labels ───────────────────────────────────────────────────────

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  completed: 'Completed',
  archived: 'Archived',
}

export const PROJECT_VISIBILITY_LABELS: Record<ProjectVisibility, string> = {
  private: 'Private',
  course: 'Course',
  public: 'Public',
}

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = {
  owner: 'Owner',
  member: 'Member',
  viewer: 'Viewer',
}

export const PHASE_STATUS_LABELS: Record<PhaseStatus, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  completed: 'Completed',
  blocked: 'Blocked',
}

// ── Team Statuses ───────────────────────────────────────────────

export const TEAM_STATUSES = ['active', 'completed', 'archived'] as const
export type TeamStatus = (typeof TEAM_STATUSES)[number]

export const TEAM_STATUS_LABELS: Record<TeamStatus, string> = {
  active: 'Active',
  completed: 'Completed',
  archived: 'Archived',
}

// ── Project Assignment Schemas (professor creates) ──────────────

export const createProjectSchema = z.object({
  title: z
    .string()
    .min(1, 'Title is required')
    .max(200, 'Title must be at most 200 characters')
    .trim(),
  description: z
    .string()
    .max(5000, 'Description must be at most 5,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  guidelines: z
    .string()
    .max(10000, 'Guidelines must be at most 10,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  status: z.enum(PROJECT_STATUSES).default('active'),
  visibility: z.enum(PROJECT_VISIBILITIES).default('course'),
  max_team_size: z.coerce
    .number({ message: 'Team size must be a number' })
    .int('Team size must be a whole number')
    .min(1, 'Team size must be at least 1')
    .max(20, 'Team size cannot exceed 20')
    .default(5),

  due_date: z.string().nullable().optional(),

  // Whether members of this project can enable a team chat workspace.
  // Ignored for individual projects (max_team_size == 1) since those
  // have no teams. Defaults to true to match legacy course-level
  // behavior.
  allow_team_workspace: z.boolean().default(true),
})

export const updateProjectSchema = createProjectSchema.partial()

export type CreateProjectInput = z.infer<typeof createProjectSchema>
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>

// ── Team Schemas (student creates under a project) ──────────────

export const createTeamSchema = z.object({
  name: z
    .string()
    .min(1, 'Team name is required')
    .max(100, 'Team name must be at most 100 characters')
    .trim(),
  description: z
    .string()
    .max(2000, 'Description must be at most 2,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
})

export const updateTeamSchema = createTeamSchema.partial()

export type CreateTeamInput = z.infer<typeof createTeamSchema>
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>

// ── Phase Schemas ────────────────────────────────────────────────

export const createPhaseSchema = z.object({
  title: z
    .string()
    .min(1, 'Title is required')
    .max(200, 'Title must be at most 200 characters')
    .trim(),
  description: z
    .string()
    .max(2000, 'Description must be at most 2,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  status: z.enum(PHASE_STATUSES).default('not_started'),
  start_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
})

export const updatePhaseSchema = createPhaseSchema.partial()

export type CreatePhaseInput = z.infer<typeof createPhaseSchema>
export type UpdatePhaseInput = z.infer<typeof updatePhaseSchema>

// ── Member Schemas ───────────────────────────────────────────────

export const addMemberSchema = z.object({
  user_id: z.string().min(1, 'User is required'),
  role: z.enum(MEMBER_ROLES).default('member'),
})

export const updateMemberSchema = z.object({
  role: z.enum(MEMBER_ROLES).optional(),
  contribution_summary: z
    .string()
    .max(2000, 'Contribution summary must be at most 2,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
})

export type AddMemberInput = z.infer<typeof addMemberSchema>
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>

// ── Showcase Schemas ─────────────────────────────────────────────

export const updateShowcaseSchema = z.object({
  showcase_enabled: z.boolean(),
  tagline: z
    .string()
    .max(300, 'Tagline must be at most 300 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  showcase_description: z
    .string()
    .max(5000, 'Description must be at most 5,000 characters')
    .trim()
    .optional()
    .or(z.literal('')),
  external_url: z.string().url().optional().or(z.literal('')),
})

export type UpdateShowcaseInput = z.infer<typeof updateShowcaseSchema>

// ── Planning Doc Schemas ────────────────────────────────────────

export const savePlanningDocSchema = z.object({
  content: z
    .string()
    .max(20000, 'Planning doc must be at most 20,000 characters')
    .trim(),
})

export type SavePlanningDocInput = z.infer<typeof savePlanningDocSchema>

// ── Phase Item Schemas ──────────────────────────────────────────

export const createPhaseItemSchema = z.object({
  title: z
    .string()
    .min(1, 'Title is required')
    .max(500, 'Title must be at most 500 characters')
    .trim(),
})

export const updatePhaseItemSchema = z.object({
  title: z
    .string()
    .min(1, 'Title is required')
    .max(500, 'Title must be at most 500 characters')
    .trim()
    .optional(),
  is_completed: z.boolean().optional(),
})

export type CreatePhaseItemInput = z.infer<typeof createPhaseItemSchema>
export type UpdatePhaseItemInput = z.infer<typeof updatePhaseItemSchema>

// ── AI Phase Generation Schemas ─────────────────────────────────

/** Schema for a single AI-generated phase (returned from LLM) */
export const generatedPhaseSchema = z.object({
  title: z.string().max(200),
  description: z.string().max(2000),
  start_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
})

export type GeneratedPhase = z.infer<typeof generatedPhaseSchema>

// ── Master Phase Schemas (professor's official project structure) ──

const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')

export const masterPhaseSchema = z.object({
  name: z
    .string()
    .min(1, 'Phase name is required')
    .max(120, 'Phase name must be at most 120 characters')
    .trim(),
  start_date: isoDateString.nullable().optional(),
  end_date: isoDateString.nullable().optional(),
})

export const updateMasterPhaseSchema = masterPhaseSchema.partial()

export const PHASE_ITEM_TYPES = ['assignment', 'quiz'] as const
export type PhaseItemType = (typeof PHASE_ITEM_TYPES)[number]

export const placePhaseItemSchema = z.object({
  item_type: z.enum(PHASE_ITEM_TYPES),
  item_id: z.string().uuid(),
  position: z.number().int().min(0).max(500),
})

export const reorderIdsSchema = z.array(z.string().uuid()).min(1).max(100)

export type MasterPhaseInput = z.infer<typeof masterPhaseSchema>
export type UpdateMasterPhaseInput = z.infer<typeof updateMasterPhaseSchema>
export type PlacePhaseItemInput = z.infer<typeof placePhaseItemSchema>

// ── Grading-engine schemas (weighted phase items → computed grade) ──

export const GRADE_GRAINS = ['team', 'individual'] as const
export const GRADE_SCORING_MODES = ['numeric', 'levels'] as const

export const rubricItemLevelSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1, 'Level needs a label').max(80).trim(),
  points: z.coerce.number().min(0).max(1000),
})

/** Patch the grading config on an existing placed item. */
export const phaseItemGradingSchema = z.object({
  weight: z.coerce.number().min(0).max(1000),
  grain: z.enum(GRADE_GRAINS),
  scoring_mode: z.enum(GRADE_SCORING_MODES),
  levels: z.array(rubricItemLevelSchema).max(10),
  manual_title: z.string().max(120).trim().optional(),
  // min(1): the DB CHECK is `manual_max IS NULL OR manual_max > 0`, and a 0-point
  // item can't be graded anyway. Matches addManualItemSchema below.
  manual_max: z.coerce.number().min(1).max(1000).nullable().optional(),
})

/** Create a manual or attendance item (no assignment/quiz behind it). */
export const addManualItemSchema = z.object({
  item_type: z.enum(['manual', 'attendance']),
  manual_title: z.string().min(1, 'Title is required').max(120).trim(),
  weight: z.coerce.number().min(0).max(1000),
  grain: z.enum(GRADE_GRAINS),
  manual_max: z.coerce.number().min(1).max(1000).optional(),
})

/** Persist one manual/level result for a team or a student. */
export const gradeItemScoreSchema = z
  .object({
    team_id: z.string().uuid().nullable().optional(),
    student_id: z.string().uuid().nullable().optional(),
    earned: z.coerce.number().min(0).max(100000).nullable().optional(),
    level_id: z.string().max(64).nullable().optional(),
  })
  .refine((d) => Boolean(d.team_id) !== Boolean(d.student_id), {
    message: 'Provide exactly one of team_id or student_id',
  })

export type RubricItemLevel = z.infer<typeof rubricItemLevelSchema>
export type PhaseItemGradingInput = z.infer<typeof phaseItemGradingSchema>
export type AddManualItemInput = z.infer<typeof addManualItemSchema>
export type GradeItemScoreInput = z.infer<typeof gradeItemScoreSchema>
