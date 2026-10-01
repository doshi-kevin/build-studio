/**
 * Server actions for the two HOST-INDEPENDENT Frontier fills.
 *
 * Every other studio fill lands in an editor's React state and is persisted by that
 * editor's own Save/autosave. These two have nowhere on the canvas to land — a rubric
 * isn't part of a notebook or document, and the design notes must NEVER touch a
 * student-facing field — so the panel persists them here instead.
 *
 * Each action is ITS OWN INVERSE: pass a payload to write it, pass null to remove it.
 * That is what makes the panel's Undo one call in either direction, with no separate
 * clear/restore actions to keep in sync.
 *
 * Security: assume both are called unauthenticated with arbitrary ids. Each one
 * authenticates, verifies section staff, re-verifies the SUBJECT belongs to that verified
 * section (IDOR), and takes institution_id from the verified course_sections row — never
 * from the client and never from the assignment row it was handed.
 */

'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess, canWriteAsStaff } from '@/lib/auth/section-access'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { designNotesSchema, frontierRubricSchema } from '@/lib/ai/assignment-assistant/schemas'
import { resolveAthenaLimitScope } from '@/lib/ai/assignment-assistant/context'
import { getAthenaUsageStatus } from '@/lib/ai/professor-assistant/rate-limit'
import type { AthenaUsageStatus } from '@/lib/ai/professor-assistant/models'
import { assignmentRubricSchema, rubricPointIssues, type AssignmentRubric } from '@/lib/validations/assignment'
import {
  listStudioConversations as listStudioConversationsDb,
  loadStudioConversation as loadStudioConversationDb,
  setStudioConversationArchived,
  type StudioConversationSummary,
  type StudioSurface,
} from '@/lib/ai/assignment-assistant/persistence'
import type { UIMessage } from 'ai'

/** The screen a design belongs to — the path we revalidate after a write. */
function designPath(sectionId: string, subjectId: string, subject: DesignSubject) {
  return subject === 'quiz'
    ? `/professor/courses/${sectionId}/quizzes/${subjectId}`
    : `/professor/courses/${sectionId}/assignments/${subjectId}`
}

/** Mirrors the studio's other action results: never throws, never leaks internals. */
type FrontierResult<T> = { error: string } | ({ success: true } & T)

/** Which kind of thing a design is attached to. A quiz lives in its own table, so the
 *  subject has to be resolved — and IDOR-checked — against the right one. */
export type DesignSubject = 'assignment' | 'quiz'

/**
 * Authenticate the caller as writing staff on this section and resolve the tenant
 * of record — the verified institution_id from the SECTION row. Split out of
 * resolveSubject so the usage read below can share it: that one has no subject to
 * IDOR-check, since it may run before anything has been saved.
 */
async function resolveSectionStaff(sectionId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, error: 'Not authenticated' }

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { ok: false as const, error: 'You do not have access to this course' }
  }

  // institution_id from the VERIFIED section, not from the assignment we were handed.
  const { data: section } = await access.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section?.institution_id) return { ok: false as const, error: 'Course not found' }

  return {
    ok: true as const,
    userId: user.id,
    adminDb: access.adminDb,
    institutionId: section.institution_id as string,
  }
}

/**
 * The caller's Athena usage for THIS panel's pool (nearing / exhausted / resets_at),
 * so the panel can warn before a send and block once the pool is spent. Read-only —
 * never increments. The scope is derived with the SAME resolver the route uses, so
 * the UI can never read a different pool than the one the turn will be charged to.
 */
export async function getPanelAthenaUsage(
  sectionId: string,
  surface: string,
  kind: string | undefined,
  assignmentId: string | undefined,
): Promise<{ error: string } | { status: AthenaUsageStatus }> {
  const staff = await resolveSectionStaff(sectionId)
  if (!staff.ok) return { error: staff.error }

  const scope = await resolveAthenaLimitScope(staff.adminDb, {
    sectionId,
    surface,
    kind,
    assignmentId,
  })
  const status = await getAthenaUsageStatus(staff.adminDb, {
    institutionId: staff.institutionId,
    userId: staff.userId,
    scope,
  })
  return { status }
}

/**
 * resolveSectionStaff PLUS confirmation that the SUBJECT lives in that section.
 * Also returns the assignment's settings and points where the subject is an
 * assignment (the rubric path needs both; a quiz has neither).
 */
async function resolveSubject(sectionId: string, subjectId: string, subject: DesignSubject = 'assignment') {
  const staff = await resolveSectionStaff(sectionId)
  if (!staff.ok) return staff
  const { userId, adminDb, institutionId } = staff

  // IDOR: the subject must live in THIS verified section. Identical message whichever way
  // it fails, so a cross-tenant id can't be used to probe for existence.
  if (subject === 'quiz') {
    const { data: quiz } = await adminDb
      .from('quizzes')
      .select('id, section_id')
      .eq('id', subjectId)
      .maybeSingle()
    if (!quiz || quiz.section_id !== sectionId) {
      return { ok: false as const, error: 'Quiz not found.' }
    }
    return {
      ok: true as const,
      userId,
      adminDb,
      institutionId,
      // A quiz has no assignment-level point budget and no settings.rubric — the rubric
      // path is not reachable for quizzes, so these are deliberately absent.
      points: 0,
      settings: {} as Record<string, unknown>,
    }
  }

  const { data: assignment } = await adminDb
    .from('assignments')
    .select('id, section_id, points, settings')
    .eq('id', subjectId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) {
    return { ok: false as const, error: 'Assignment not found.' }
  }

  return {
    ok: true as const,
    userId,
    adminDb,
    institutionId,
    points: Number(assignment.points),
    settings: (assignment.settings ?? {}) as Record<string, unknown>,
  }
}

/**
 * Write (or clear) assignments.settings.rubric for a Frontier design.
 *
 * `rubric: null` removes the key — that is the Undo direction when there was no rubric
 * before. Returns the PREVIOUS rubric so the panel can undo without a second read.
 *
 * The point budget is checked with the same shared rubricPointIssues the rubric editor and
 * saveAssignmentRubric use, BEFORE the write, so an over-budget rubric is refused with the
 * reason rather than half-applied. We write settings ourselves (spread-merged, never
 * clobbering settings.pdfs / accepts / studio) rather than delegating, because we need the
 * previous value back in the same round trip.
 */
export async function applyFrontierRubric(
  sectionId: string,
  assignmentId: string,
  rubric: unknown,
): Promise<FrontierResult<{ previous: AssignmentRubric | null; saved: AssignmentRubric | null }>> {
  const subject = await resolveSubject(sectionId, assignmentId)
  if (!subject.ok) return { error: subject.error }

  const clearing = rubric === null
  let questions: AssignmentRubric['questions'] = []
  if (!clearing) {
    const parsed = frontierRubricSchema.safeParse(rubric)
    if (!parsed.success) return { error: 'That rubric is incomplete.' }
    questions = parsed.data.questions
    const issues = rubricPointIssues(questions)
    if (issues.hasError) {
      // Say what to DO, not just what's wrong. A refused fill no longer re-arms the auto-send
      // (that unbounded chain was a real bug), so this chip is the professor's ONLY output —
      // and the model reads the same string, so it knows the two ways out if they ask again.
      const why = issues.perQuestion.find(Boolean) ?? 'Rubric points are over budget.'
      return {
        error: `${why} Lower the criteria points so each question stays within its own total.`,
      }
    }
  }

  // The rubric that was there before, for Undo. Invalid/absent reads back as null.
  const priorParsed = assignmentRubricSchema.safeParse(subject.settings.rubric)
  const previous = priorParsed.success && priorParsed.data.questions.length > 0 ? priorParsed.data : null

  // Splice the one key inside Postgres rather than rewriting the whole settings column.
  // The notebook studio autosaves settings.studio on a debounce while the professor types;
  // a read-modify-write here would lose whichever update landed second.
  const { error } = await subject.adminDb.rpc('assignment_settings_merge', {
    p_assignment_id: assignmentId,
    p_key: 'rubric',
    p_value: clearing ? null : { questions },
  })
  if (error) {
    logger.error('applyFrontierRubric: settings merge failed', error, { assignmentId })
    return { error: 'Could not save the rubric. Please try again.' }
  }

  await logEvent({
    userId: subject.userId,
    eventType: clearing ? 'assignment.rubric_cleared' : 'assignment.rubric_saved',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, questionCount: questions.length, source: 'athena_frontier' },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  // `saved` is the PARSED rubric, not the model's raw input. rubricQuestionSchema gives
  // `criteria` a default of [], so a question the model sent without that key is stored WITH
  // it — and the rubric editor does `q.criteria.reduce(...)`. Handing the host the raw input
  // would crash it on the very next render, right under a chip saying "Saved".
  return { success: true, previous, saved: clearing ? null : { questions } }
}

/**
 * Write (or clear) the private design record for an assignment.
 *
 * `notes: null` deletes the row — the Undo direction when there was no design before.
 * Returns the PREVIOUS record so the panel can undo without a second read.
 *
 * Upserted on assignment_id (a partial unique index enforces one design per subject), so
 * re-running the arc revises the record in place instead of accumulating duplicates.
 */
export async function saveAssignmentDesign(
  sectionId: string,
  subjectId: string,
  notes: unknown,
  subjectKind: DesignSubject = 'assignment',
): Promise<FrontierResult<{ previous: unknown | null }>> {
  const subject = await resolveSubject(sectionId, subjectId, subjectKind)
  if (!subject.ok) return { error: subject.error }
  // Exactly one subject column is set — the table's XOR CHECK enforces it, and the two
  // partial-free unique indexes give one design per subject either way.
  const subjectCol = subjectKind === 'quiz' ? 'quiz_id' : 'assignment_id'

  // Read the prior record first — it is the Undo payload.
  const { data: prior } = await subject.adminDb
    .from('assignment_designs')
    .select(
      'created_by, spine, shell, shell_check, individuation_axis, verification_mode, failure_modes, rot_notes, reference_invariants, criterion_tags, gate_report, waivers',
    )
    .eq(subjectCol, subjectId)
    .maybeSingle()
  const previous = prior
    ? {
        spine: prior.spine,
        shell: prior.shell,
        shellCheck: prior.shell_check ?? undefined,
        individuationAxis: prior.individuation_axis,
        verificationMode: prior.verification_mode,
        failureModes: prior.failure_modes,
        rotNotes: prior.rot_notes,
        referenceInvariants: prior.reference_invariants,
        criterionTags: prior.criterion_tags,
        gateReport: prior.gate_report,
        waivers: prior.waivers,
      }
    : null

  if (notes === null) {
    const { error } = await subject.adminDb.from('assignment_designs').delete().eq(subjectCol, subjectId)
    if (error) {
      logger.error('saveAssignmentDesign: delete failed', error, { subjectKind, subjectId })
      return { error: 'Could not remove the design notes. Please try again.' }
    }
    await logEvent({
      userId: subject.userId,
      eventType: 'assignment.design_cleared',
      eventCategory: 'course',
      sectionId,
      metadata: { subjectKind, subjectId },
    })
    revalidatePath(designPath(sectionId, subjectId, subjectKind))
    return { success: true, previous }
  }

  const parsed = designNotesSchema.safeParse(notes)
  if (!parsed.success) return { error: 'Those design notes are incomplete.' }
  const n = parsed.data

  const { error } = await subject.adminDb.from('assignment_designs').upsert(
    {
      assignment_id: subjectKind === 'quiz' ? null : subjectId,
      quiz_id: subjectKind === 'quiz' ? subjectId : null,
      institution_id: subject.institutionId,
      section_id: sectionId,
      // Keep the ORIGINAL creator on a re-run. The upsert writes every column it is given,
      // so passing the current user turned this into "last writer" — a TA revising the
      // professor's design silently became its author on a row holding answer-key material.
      created_by: (prior?.created_by as string | undefined) ?? subject.userId,
      spine: n.spine,
      shell: n.shell,
      shell_check: n.shellCheck ?? null,
      individuation_axis: n.individuationAxis,
      verification_mode: n.verificationMode,
      failure_modes: n.failureModes,
      rot_notes: n.rotNotes,
      reference_invariants: n.referenceInvariants,
      criterion_tags: n.criterionTags ?? [],
      gate_report: n.gateReport,
      waivers: n.waivers ?? [],
      updated_at: new Date().toISOString(),
    },
    { onConflict: subjectCol },
  )
  if (error) {
    logger.error('saveAssignmentDesign: upsert failed', error, { subjectKind, subjectId })
    return { error: 'Could not save the design notes. Please try again.' }
  }

  await logEvent({
    userId: subject.userId,
    eventType: 'assignment.design_saved',
    eventCategory: 'course',
    sectionId,
    metadata: { subjectKind, subjectId, verificationMode: n.verificationMode, waiverCount: n.waivers?.length ?? 0 },
  })
  revalidatePath(designPath(sectionId, subjectId, subjectKind))
  return { success: true, previous }
}

// ── Resume (saved Studio chats) ──────────────────────────────────────────
// List/load for the resume dropdown. Scoped to (studioSurface, studioKind,
// item) exactly like the panel's own in-memory panelKey — a chat about one
// assignment never surfaces in another's history. resolveSectionStaff's
// ownership check is the whole IDOR boundary: a TA can only ever see THEIR
// OWN threads, and (per the route) never has an 'about'-kind thread to begin
// with, since that kind is gated professor-only there.

/** This caller's saved Studio chats in the given scope, newest first. */
export async function listStudioConversations(
  sectionId: string,
  scope: {
    studioSurface: StudioSurface
    studioKind: string | null
    assignmentId: string | null
    quizId: string | null
    projectId: string | null
  },
): Promise<{ data: StudioConversationSummary[]; error?: string }> {
  const staff = await resolveSectionStaff(sectionId)
  // Distinguishable from "no chats": the caller renders a failure state instead of an
  // empty one, because "you have no chats" reads as data loss rather than as an error.
  if (!staff.ok) return { data: [], error: staff.error }

  const data = await listStudioConversationsDb(staff.adminDb, {
    sectionId,
    userId: staff.userId,
    ...scope,
  })
  return { data }
}

/** Full message history for one saved chat, for hydrating useChat on resume. */
export async function loadStudioConversation(
  sectionId: string,
  conversationId: string,
): Promise<{ messages: UIMessage[]; mode: 'standard' | 'frontier'; error?: string }> {
  const staff = await resolveSectionStaff(sectionId)
  if (!staff.ok) return { messages: [], mode: 'standard', error: staff.error }

  return loadStudioConversationDb(staff.adminDb, {
    conversationId,
    userId: staff.userId,
    sectionId,
    institutionId: staff.institutionId,
  })
}

/**
 * Remove a saved chat from the resume list, or put it back (the Undo on that toast).
 * Archive, not delete: the transcript survives, so Undo is a real restore rather than
 * a promise we cannot keep.
 */
export async function setStudioConversationArchivedAction(
  sectionId: string,
  conversationId: string,
  archived: boolean,
): Promise<{ success?: true; error?: string }> {
  const staff = await resolveSectionStaff(sectionId)
  if (!staff.ok) return { error: staff.error }

  const ok = await setStudioConversationArchived(staff.adminDb, {
    conversationId,
    userId: staff.userId,
    sectionId,
    archived,
  })
  if (!ok) return { error: archived ? 'Could not delete that chat.' : 'Could not restore that chat.' }

  await logEvent({
    userId: staff.userId,
    eventType: archived ? 'athena.studio_chat_archived' : 'athena.studio_chat_restored',
    eventCategory: 'course',
    sectionId,
    metadata: { conversationId },
  })
  return { success: true }
}
