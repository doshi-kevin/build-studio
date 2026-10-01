/**
 * Tool schemas + client/route contract for the assignment-scoped Athena.
 *
 * Client-safe: pure zod + types, NO server imports — imported by the client panel
 * (to type fill payloads) AND the server route (to define tools), so it must never
 * pull anything server-only into the browser bundle.
 *
 * Two SURFACES (not a per-template enum any more). Note the vocabulary: a SURFACE is
 * which screen the panel is mounted on (below); a MODE is the orthogonal
 * standard/frontier switch further down. They are separate axes on purpose.
 *  - 'authoring' — the GENERIC template surface. One fill tool `apply_edits` whose typed
 *    op payload comes from the TEMPLATE_REGISTRY keyed by `kind` (files/notebook/verbal/
 *    document/…). The editor registers a getState() + onApply(ops); the panel forwards
 *    the model's apply_edits call to onApply, which writes into the editor's React
 *    state. Nothing persists here — the editor's own Save/autosave is the write path.
 *  - 'grade' — unchanged: summarize_submission (read-only, server-side) + fill_feedback,
 *    with a hard grading-safety boundary. Not a template.
 *
 * Fill schemas stay loose where helpful; each editor's real Save-time schema
 * (createAssignmentSchema / studioDocSchema / verbalAssessmentSchema) re-validates.
 */

import { z } from 'zod'
import { AUTHORING_KINDS } from './templates/registry'
import { rubricQuestionSchema } from '@/lib/validations/assignment'

// ── grade: fill_feedback ─────────────────────────────────────────
// Drafts qualitative feedback prose into the feedback textarea. NEVER a numeric or
// letter grade — Athena articulates the professor's judgment, never forms or scores it.
export const fillFeedbackSchema = z.object({
  feedback: z
    .string()
    .min(1)
    .max(10000)
    .describe('Qualitative feedback prose for the feedback box — strengths and specific next steps. NO numeric or letter grade, ever.'),
})
export type FillFeedback = z.infer<typeof fillFeedbackSchema>

// The fill tools the client must handle.
//  - apply_edits: authoring mode (payload = { ops }, typed per-kind by the registry).
//  - fill_feedback: grade mode.
//  - set_quiz_settings / generate_questions: quiz authoring only. generate_questions is a
//    fill rather than a server tool because the run it starts takes minutes (the studio's
//    own streaming route allows 300s) and this chat route is capped at 60 — so the client
//    hands it to the studio, which already owns that request, its progress banner, and
//    its reattach-after-reload behaviour.
//  - set_rubric / set_design_notes: FRONTIER mode only. Unlike every fill above, these two
//    are HOST-INDEPENDENT — they need only (sectionId, assignmentId, payload), no editor
//    access — so the panel handles them itself instead of forwarding to a host onFill.
//    That keeps one implementation instead of five, and is why they persist through vetted
//    server actions rather than landing in editor state (a rubric has no place on the
//    notebook/document canvas, and design notes must never touch a student-facing field).
export const ASSIGNMENT_FILL_TOOLS = [
  'apply_edits',
  'fill_feedback',
  'set_quiz_settings',
  'generate_questions',
  'set_rubric',
  'set_design_notes',
] as const
export type AssignmentFillTool = (typeof ASSIGNMENT_FILL_TOOLS)[number]

/** The two fills the PANEL owns (see the note above) rather than the host editor. */
export const PANEL_OWNED_FILL_TOOLS = ['set_rubric', 'set_design_notes'] as const
export type PanelOwnedFillTool = (typeof PANEL_OWNED_FILL_TOOLS)[number]

// Which mode the panel is mounted on. Drives which tools the route exposes and how
// the prompt is built. 'authoring' is generic across every template `kind`.
export const ASSIGNMENT_ASSISTANT_SURFACES = ['authoring', 'grade'] as const
export type AssignmentAssistantSurface = (typeof ASSIGNMENT_ASSISTANT_SURFACES)[number]

// ── Frontier mode ────────────────────────────────────────────────
// An ORTHOGONAL switch layered over the `authoring` surface — deliberately NOT a third
// `ASSIGNMENT_ASSISTANT_SURFACES` member. buildSurfaceBlock() falls through to authoring
// while buildAssignmentAssistantTools() falls through to grade, so a third surface value
// would silently pair the authoring prompt with grading-only tools.
//
// 'standard'  — today's behaviour, unchanged.
// 'frontier'  — the assignment-DESIGN arc: learn the field's current edge, verify a
//               real-world shell is live and free, offer pairings, then build with the
//               seven properties + safety gate satisfied.
export const ASSIGNMENT_ASSISTANT_MODES = ['standard', 'frontier'] as const
export type AssignmentAssistantMode = (typeof ASSIGNMENT_ASSISTANT_MODES)[number]
export const DEFAULT_ASSIGNMENT_ASSISTANT_MODE: AssignmentAssistantMode = 'standard'

// ── Persisted-conversation scoping ──────────────────────────────
// Maps the panel's (surface, kind, assignmentId) onto the athena_conversations
// columns a saved Studio thread is scoped by. Both the route (what gets
// WRITTEN) and the panel (what scope the resume dropdown LISTS) need this exact
// mapping — kept here, in the client-safe schema file, as the one
// implementation, since two independent copies would eventually drift.
export interface StudioConversationScope {
  studioSurface: 'authoring' | 'grade' | 'general'
  studioKind: string | null
  assignmentId: string | null
  quizId: string | null
  projectId: string | null
}

export function resolveStudioConversationScope(params: {
  surface: AssignmentAssistantSurface
  kind: string | undefined
  assignmentId: string | undefined
}): StudioConversationScope {
  // 'grade' surface is always the grader (never a kind); no kind at all means
  // no editor is registered (a list page) — the no-host general brainstorm.
  const studioSurface: StudioConversationScope['studioSurface'] =
    params.surface === 'grade' ? 'grade' : params.kind ? 'authoring' : 'general'
  const isQuizItem = params.kind === 'quiz'
  // Projects pass their own id through the assignmentId slot, the same overload the
  // Quiz Studio already uses. This has to be checked for BOTH authoring and grading:
  // 'grade' used to imply "the item is an assignment", which stopped being true the
  // moment a project team could be graded. Writing a project id into assignment_id
  // would fail that column's assignments(id) foreign key and 500 the first turn.
  const isProjectItem = params.kind === 'project'
  return {
    studioSurface,
    studioKind: params.kind ?? null,
    // Every item-bearing kind except quiz and project scopes by assignment_id;
    // About and the no-host general chat have no item at all.
    assignmentId:
      studioSurface !== 'general' &&
      params.kind !== 'about' &&
      !isQuizItem &&
      !isProjectItem &&
      params.assignmentId
        ? params.assignmentId
        : null,
    quizId: isQuizItem && params.assignmentId ? params.assignmentId : null,
    projectId: isProjectItem && params.assignmentId ? params.assignmentId : null,
  }
}

/** The one verification mode a Frontier rubric is built around. */
export const FRONTIER_VERIFICATION_MODES = [
  'reconciliation',
  'provenance',
  'raw_vs_processed',
  'delta',
  'physical_evidence',
] as const

/** The properties a Frontier assignment must satisfy (or explicitly waive). */
export const FRONTIER_PROPERTIES = [
  'spine_and_shell',
  'delegate_then_verify',
  'evidence_of_process',
  'self_verifying',
  'individuation',
  'anticlimax_tolerance',
  'delight_and_scope',
  'safety_gate',
] as const

// ── frontier: set_design_notes ───────────────────────────────────
// The professor-private record behind a Frontier assignment: why it is built this way,
// what makes a copy visibly wrong, and what will go stale when. It persists to
// assignment_designs and NEVER to a student-facing field — the individuation axis and
// the reference invariants are exactly what make the assignment hard to copy, so
// leaking them would defeat the whole point.
//
// SHAPE RULES (Gemini function calling, same constraint the template registry
// documents): flat objects with plain fields; arrays of flat objects are fine; NO
// discriminated unions and NO .nullable() anywhere, or the model silently emits a
// malformed call. `.optional()` is safe.
export const designNotesSchema = z.object({
  spine: z
    .string()
    .min(1)
    .max(400)
    .describe('The durable disciplinary concept, in ONE sentence — what will still be taught in fifteen years.'),
  shell: z
    .string()
    .min(1)
    .max(400)
    .describe(
      'The current real-world vehicle, in ONE sentence — the tool, dataset, guideline, archive, public event or physical object the assignment is built around.',
    ),
  shellCheck: z
    .string()
    .max(600)
    .optional()
    .describe(
      'What your grounded search actually established about the shell — that it is live, free to use, and workable on ordinary student hardware — and the source that showed it. Omit ONLY if the shell needed no checking; never invent a check you did not run.',
    ),
  individuationAxis: z
    .string()
    .min(1)
    .max(600)
    .describe(
      'What makes every submission differ BY CONSTRUCTION, and why a copied submission would be visibly WRONG rather than merely suspicious.',
    ),
  verificationMode: z
    .enum(FRONTIER_VERIFICATION_MODES)
    .describe('The one verification mode the rubric is built around.'),
  failureModes: z
    .array(
      z.object({
        failure: z
          .string()
          .min(1)
          .max(300)
          .describe('A likely real-world failure — a dead link, an exhausted quota, refused consent, weather, a failed experiment.'),
        acceptanceClause: z
          .string()
          .min(1)
          .max(400)
          .describe('Exactly what the student submits instead, written so their grade is unaffected.'),
      }),
    )
    .min(2)
    .max(4)
    .describe('The likeliest ways the world fails to cooperate, each with its acceptance clause.'),
  rotNotes: z
    .string()
    .min(1)
    .max(1500)
    .describe(
      'What in this assignment will go stale, on what timescale, and exactly what to re-verify before running it again. This is what a future freshness pass reads — be specific enough to act on.',
    ),
  referenceInvariants: z
    .array(z.string().min(1).max(300))
    .max(10)
    .describe(
      'Things that must be true of any correct submission — the answer-key invariants a grader can check against. Professor-only, never shown to students.',
    ),
  criterionTags: z
    .array(
      z.object({
        question: z.string().min(1).max(120).describe('The rubric question label this criterion sits under.'),
        criterion: z.string().min(1).max(500).describe('The criterion description, as written in the rubric.'),
        tag: z
          .enum(['auto', 'judgment'])
          .describe('auto = a grader can check it without judgment; judgment = it needs reading and a decision.'),
      }),
    )
    .max(60)
    .optional()
    .describe(
      'Per-criterion auto-vs-judgment tagging for the rubric you saved. Lives here rather than on the rubric itself, so the saved rubric stays exactly the shape the grading screen parses.',
    ),
  gateReport: z
    .array(
      z.object({
        property: z.enum(FRONTIER_PROPERTIES),
        justification: z
          .string()
          .min(1)
          .max(400)
          .describe('ONE sentence on how this draft actually satisfies the property.'),
      }),
    )
    .max(8)
    .describe(
      "Your OWN per-property justification, shown to the professor as your reasoning rather than as verification. Be honest and specific: a property you did not satisfy belongs in `waivers`, not here behind a hollow sentence.",
    ),
  waivers: z
    .array(
      z.object({
        property: z.enum(FRONTIER_PROPERTIES),
        reason: z.string().min(1).max(300).describe("Why it could not be satisfied, in the professor's actual constraints."),
      }),
    )
    .max(8)
    .optional()
    .describe('Properties you deliberately did not satisfy. Recording a waiver is correct behaviour; pretending is not.'),
})
export type DesignNotes = z.infer<typeof designNotesSchema>

// ── frontier: set_rubric ─────────────────────────────────────────
// Writes assignments.settings.rubric through the existing saveAssignmentRubric action, so
// `questions` reuses rubricQuestionSchema VERBATIM — no drift from the shape the grading
// screen already parses, where criterion ORDER is load-bearing for saved grades.
//
// The auto-vs-judgment tagging deliberately lives on set_design_notes, NOT here: it belongs
// in the private record, and putting it here would need the design row to already exist at
// rubric time (it doesn't — notes are written last), which is an ordering trap for no gain.
export const frontierRubricSchema = z.object({
  questions: z
    .array(rubricQuestionSchema)
    .min(1)
    .max(30)
    .describe(
      "The rubric rows. Question points must not exceed the assignment total, and each question's criteria must not exceed that question's points — an over-budget rubric is rejected.",
    ),
})
export type FrontierRubric = z.infer<typeof frontierRubricSchema>

// ── per-turn screen context (client → route) ─────────────────────
// A small snapshot of what's on screen so Athena edits surgically and knows what's
// already there. Deliberately bounded; long content is truncated by the editor's
// getState. Untrusted context only — it authorizes nothing (the route re-verifies).

/** One editor component (notebook/verbal cell, or a document section) for the model
 *  to reference by id when editing. `content` is the near-full text (budgeted). */
export const componentSnapshotSchema = z.object({
  id: z.string().max(80),
  type: z.string().max(40),
  content: z.string().max(4000),
})
export type ComponentSnapshot = z.infer<typeof componentSnapshotSchema>

/** The generic authoring state: which template kind, its top-level meta fields, and
 *  its ordered components. Every authoring editor serializes to this one shape. */
export const authoringStateSchema = z.object({
  kind: z.enum(AUTHORING_KINDS),
  meta: z
    .record(
      z.string().max(60),
      z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(40)).max(20)]),
    )
    .optional(),
  components: z.array(componentSnapshotSchema).max(300).optional(),
})
export type AuthoringState = z.infer<typeof authoringStateSchema>

/** grade surface context (unchanged). */
export const gradeScreenSchema = z.object({
  submissionId: z.string().uuid().optional(),
  studentName: z.string().max(200).optional(),
  points: z.number().optional(),
  hasRubric: z.boolean().optional(),
  currentScore: z.string().max(20).optional(),
  currentFeedback: z.string().max(2000).optional(),
})
export type GradeScreen = z.infer<typeof gradeScreenSchema>

/** The per-turn screen payload — exactly one of the two is set for the active mode. */
export const assignmentScreenSchema = z.object({
  authoring: authoringStateSchema.optional(),
  grade: gradeScreenSchema.optional(),
})
export type AssignmentScreen = z.infer<typeof assignmentScreenSchema>
