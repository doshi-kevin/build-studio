/**
 * Approval server actions for the professor AI assistant.
 *
 * These are the ONLY place an assistant draft turns into real data. Each takes
 * the (professor-edited) draft from a card and orchestrates the EXISTING vetted
 * server actions — so all the original auth/authorization/logEvent/revalidate
 * guarantees apply unchanged. Everything is created as a DRAFT / UNPUBLISHED;
 * the professor still publishes through the normal UI.
 *
 * We re-authenticate at the top (defense in depth) AND each delegated action
 * authenticates again. Drafts are re-validated against the loose draft schemas
 * before translation; the delegated actions re-validate against the strict
 * server schemas.
 */

'use server'

import type { UIMessage } from 'ai'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess, canWriteAsStaff } from '@/lib/auth/section-access'
import { logger } from '@/lib/logger'
import { normalizeAthenaTitle } from '@/lib/validations/athena-conversation'
import { signAthenaAttachments } from '@/lib/ai/athena-attachments-server'
import { getAthenaUsageStatus } from '@/lib/ai/professor-assistant/rate-limit'
import type { AthenaUsageStatus } from '@/lib/ai/professor-assistant/models'
import {
  announcementDraftSchema,
  replyDraftSchema,
  moduleDraftSchema,
  discussionDraftSchema,
  projectDraftSchema,
  assignmentDraftSchema,
  challengeDraftSchema,
  rubricDraftSchema,
  feedbackDraftSchema,
  differentiatedDraftSchema,
} from '@/lib/ai/professor-assistant/schemas'
import {
  toChallengeInput,
  toAssignmentInput,
  rubricToMarkdown,
  feedbackToMessage,
} from '@/lib/ai/professor-assistant/translate'
import { createAnnouncement } from '@/app/(dashboard)/professor/courses/[sectionId]/announcements/actions'
import { createModule, createModuleItem } from '@/app/(dashboard)/professor/courses/[sectionId]/modules/actions'
import { sendDiscussionMessage } from '@/app/(dashboard)/professor/courses/[sectionId]/discussions/actions'
import { createProject, updateProject } from '@/app/(dashboard)/professor/courses/[sectionId]/projects/actions'
import { createChallenge } from '@/app/(dashboard)/professor/courses/[sectionId]/challenges/actions'
import { createAssignment } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'

/** Shared top-level guard. Returns an error string, or null if allowed. */
async function guardStaff(sectionId: string): Promise<string | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return 'Not authenticated'
  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok || !canWriteAsStaff(access.role)) return 'You do not have access to this course'
  return null
}

/**
 * Like guardStaff, but also returns the caller's id + admin client — the chat
 * CRUD actions below need `userId` to scope every query to the OWNER (the IDOR
 * check: these run via the service role, which bypasses RLS, so the user_id
 * filter here IS the real authorization — RLS is only the backstop).
 */
async function resolveStaff(
  sectionId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ ok: false; error: string } | { ok: true; userId: string; adminDb: any }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok || !canWriteAsStaff(access.role))
    return { ok: false, error: 'You do not have access to this course' }
  return { ok: true, userId: user.id, adminDb: access.adminDb }
}

/**
 * Read the caller's per-model Athena usage for the rate-limit UI (nearing /
 * exhausted / resets_at) in the CONSOLE pool. Read-only — does NOT increment the
 * counter. Server is the source of truth; the client uses this only to render
 * usage state. The scope is hardcoded rather than a parameter: this action serves
 * the sidebar console, and the side panels read their own pools through
 * getPanelAthenaUsage, which derives the scope the same way their route does.
 */
export async function getAthenaUsage(
  sectionId: string,
): Promise<{ error: string } | { status: AthenaUsageStatus }> {
  const staff = await resolveStaff(sectionId)
  if (!staff.ok) return { error: staff.error }

  const { data: section } = await staff.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section?.institution_id) return { error: 'Course not found' }

  const status = await getAthenaUsageStatus(staff.adminDb, {
    institutionId: section.institution_id,
    userId: staff.userId,
    scope: 'console',
  })
  return { status }
}

export interface ApproveResult {
  success?: boolean
  error?: string
  /** Where to send the professor to finish the work. */
  href?: string
  /** Human-readable note (e.g. "8 of 10 questions added"). */
  note?: string
}

export async function approveAnnouncementDraft(sectionId: string, draft: unknown): Promise<ApproveResult> {
  const denied = await guardStaff(sectionId)
  if (denied) return { error: denied }

  const parsed = announcementDraftSchema.safeParse(draft)
  if (!parsed.success) return { error: 'This announcement draft is incomplete.' }

  try {
    const res = await createAnnouncement(sectionId, {
      title: parsed.data.title,
      content: parsed.data.content,
      status: 'draft',
      is_pinned: false,
      is_important: false,
      requires_acknowledgement: false,
      visibility: 'all',
      allow_reactions: true,
      allow_comments: true,
    })
    if (res.error) return { error: res.error }
    return {
      success: true,
      href: `/professor/courses/${sectionId}/announcements`,
      note: 'Saved as a draft announcement.',
    }
  } catch (error) {
    logger.error('approveAnnouncementDraft: failed', error, { sectionId })
    return { error: 'Could not save the announcement. Please try again.' }
  }
}

export async function approveReplyDraft(
  sectionId: string,
  channelId: string,
  draft: unknown,
): Promise<ApproveResult> {
  const denied = await guardStaff(sectionId)
  if (denied) return { error: denied }
  if (!channelId) return { error: 'Pick a channel to post the reply to.' }

  const parsed = replyDraftSchema.safeParse(draft)
  if (!parsed.success) return { error: 'This reply draft is empty.' }

  try {
    const res = await sendDiscussionMessage(channelId, sectionId, { content: parsed.data.reply })
    if (res.error) return { error: res.error }
    return {
      success: true,
      href: `/professor/courses/${sectionId}/discussions`,
      note: 'Reply posted to the discussion.',
    }
  } catch (error) {
    logger.error('approveReplyDraft: failed', error, { sectionId })
    return { error: 'Could not post the reply. Please try again.' }
  }
}

export async function approveDiscussionDraft(
  sectionId: string,
  channelId: string,
  draft: unknown,
): Promise<ApproveResult> {
  const denied = await guardStaff(sectionId)
  if (denied) return { error: denied }
  if (!channelId) return { error: 'Pick a discussion channel to post to.' }

  const parsed = discussionDraftSchema.safeParse(draft)
  if (!parsed.success) return { error: 'This discussion draft is incomplete.' }

  // Format the prompts as one discussion message (numbered open questions).
  const body = [
    `**${parsed.data.title}**`,
    parsed.data.prompt?.trim() || '',
    parsed.data.questions.map((q, i) => `${i + 1}. ${q}`).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')

  try {
    const res = await sendDiscussionMessage(channelId, sectionId, { content: body })
    if (res.error) return { error: res.error }
    return {
      success: true,
      href: `/professor/courses/${sectionId}/discussions`,
      note: 'Discussion posted to the channel.',
    }
  } catch (error) {
    logger.error('approveDiscussionDraft: failed', error, { sectionId })
    return { error: 'Could not post the discussion. Please try again.' }
  }
}

export async function approveModuleDraft(sectionId: string, draft: unknown): Promise<ApproveResult> {
  const denied = await guardStaff(sectionId)
  if (denied) return { error: denied }

  const parsed = moduleDraftSchema.safeParse(draft)
  if (!parsed.success) return { error: 'This module draft is incomplete.' }

  try {
    const modRes = await createModule(sectionId, {
      title: parsed.data.title,
      description: parsed.data.description,
      week_number: parsed.data.weekNumber,
      is_published: false,
    })
    if (modRes.error || !modRes.moduleId) return { error: modRes.error || 'Failed to create the module' }
    const moduleId = modRes.moduleId

    let created = 0
    for (const item of parsed.data.items) {
      const res = await createModuleItem(moduleId, sectionId, {
        item_type: 'note',
        title: item.title,
        description: item.description,
        content: {},
        is_visible: false,
      })
      if (res.success) created += 1
    }

    return {
      success: true,
      href: `/professor/courses/${sectionId}/modules`,
      note: `Created an unpublished module with ${created} outline item${created === 1 ? '' : 's'}.`,
    }
  } catch (error) {
    logger.error('approveModuleDraft: failed', error, { sectionId })
    return { error: 'Could not create the module. Please try again.' }
  }
}

export async function approveProjectDraft(
  sectionId: string,
  draft: unknown,
  // Professor-controlled toggle from the draft-review card. Athena never sets
  // this (it's absent from the model-facing projectDraftSchema); the professor
  // decides during review. Defaults to on to match the create-project default.
  allowTeamWorkspace: boolean = true,
): Promise<ApproveResult> {
  const denied = await guardStaff(sectionId)
  if (denied) return { error: denied }

  const parsed = projectDraftSchema.safeParse(draft)
  if (!parsed.success) return { error: 'This project draft is incomplete.' }

  try {
    const res = await createProject(sectionId, {
      title: parsed.data.title,
      description: parsed.data.description ?? '',
      guidelines: parsed.data.guidelines ?? '',
      status: 'active',
      visibility: 'course',
      max_team_size: parsed.data.maxTeamSize ?? 5,
      due_date: parsed.data.dueDate || null,
      allow_team_workspace: allowTeamWorkspace,
    })
    if (res.error || !res.data) return { error: res.error || 'Failed to create the project' }
    return {
      success: true,
      href: `/professor/courses/${sectionId}/projects`,
      note: 'Created an active course project.',
    }
  } catch (error) {
    logger.error('approveProjectDraft: failed', error, { sectionId })
    return { error: 'Could not create the project. Please try again.' }
  }
}

/**
 * Create an UNPUBLISHED assignment from an assignment draft. Delegates to the
 * EXISTING createAssignment action with publish=false — no new write path; that
 * action re-authenticates, validates against the strict createAssignmentSchema,
 * sets institution_id, logs, and revalidates. The professor publishes from the UI.
 */
export async function approveAssignmentDraft(sectionId: string, draft: unknown): Promise<ApproveResult> {
  const denied = await guardStaff(sectionId)
  if (denied) return { error: denied }

  const parsed = assignmentDraftSchema.safeParse(draft)
  if (!parsed.success) return { error: 'This assignment draft is incomplete.' }

  try {
    const res = await createAssignment(sectionId, toAssignmentInput(parsed.data), false)
    if ('error' in res) return { error: res.error }
    return {
      success: true,
      href: `/professor/courses/${sectionId}/assignments/${res.assignmentId}`,
      note: 'Created an unpublished assignment.',
    }
  } catch (error) {
    logger.error('approveAssignmentDraft: failed', error, { sectionId })
    return { error: 'Could not create the assignment. Please try again.' }
  }
}

export async function approveChallengeDraft(sectionId: string, draft: unknown): Promise<ApproveResult> {
  const denied = await guardStaff(sectionId)
  if (denied) return { error: denied }

  const parsed = challengeDraftSchema.safeParse(draft)
  if (!parsed.success) return { error: 'This challenge draft is incomplete.' }

  try {
    const res = await createChallenge(sectionId, toChallengeInput(parsed.data))
    if (res.error) return { error: res.error }
    return {
      success: true,
      href: `/professor/courses/${sectionId}/challenges`,
      note: 'Created a draft challenge.',
    }
  } catch (error) {
    logger.error('approveChallengeDraft: failed', error, { sectionId })
    return { error: 'Could not create the challenge. Please try again.' }
  }
}

/**
 * Append the rubric to a professor-chosen PROJECT (a rubric has no standalone
 * home). Projects are the home because their `guidelines` field has room (10k)
 * for a full rubric — a quiz description is capped far too low. Quiz-specific
 * rubrics are instead authored in the Quiz Studio (criteria in each question's
 * explanation). We read the project's current guidelines and APPEND the rubric
 * markdown via the existing update action — never overwriting what's there.
 */
export async function approveRubricDraft(
  sectionId: string,
  projectId: string,
  draft: unknown,
): Promise<ApproveResult> {
  const ctx = await resolveStaff(sectionId)
  if (!ctx.ok) return { error: ctx.error }
  if (!projectId) return { error: 'Pick a project to attach the rubric to.' }

  const parsed = rubricDraftSchema.safeParse(draft)
  if (!parsed.success) return { error: 'This rubric draft is incomplete.' }

  const markdown = rubricToMarkdown(parsed.data)

  try {
    const { data: project } = await ctx.adminDb
      .from('projects')
      .select('guidelines')
      .eq('id', projectId)
      .eq('section_id', sectionId)
      .maybeSingle()
    if (!project) return { error: 'That project no longer exists.' }
    const guidelines = [project.guidelines?.trim(), markdown].filter(Boolean).join('\n\n')
    const res = await updateProject(projectId, sectionId, { guidelines })
    if (res.error) return { error: res.error }
    return { success: true, href: `/professor/courses/${sectionId}/projects/${projectId}`, note: 'Rubric added to the project.' }
  } catch (error) {
    logger.error('approveRubricDraft: failed', error, { sectionId })
    return { error: 'Could not attach the rubric. Please try again.' }
  }
}

export async function approveFeedbackDraft(
  sectionId: string,
  channelId: string,
  draft: unknown,
): Promise<ApproveResult> {
  const denied = await guardStaff(sectionId)
  if (denied) return { error: denied }
  if (!channelId) return { error: 'Pick a channel to post the feedback to.' }

  const parsed = feedbackDraftSchema.safeParse(draft)
  if (!parsed.success) return { error: 'This feedback draft is empty.' }

  try {
    const res = await sendDiscussionMessage(channelId, sectionId, { content: feedbackToMessage(parsed.data) })
    if (res.error) return { error: res.error }
    return {
      success: true,
      href: `/professor/courses/${sectionId}/discussions`,
      note: 'Feedback posted to the discussion.',
    }
  } catch (error) {
    logger.error('approveFeedbackDraft: failed', error, { sectionId })
    return { error: 'Could not post the feedback. Please try again.' }
  }
}

export async function approveDifferentiatedDraft(sectionId: string, draft: unknown): Promise<ApproveResult> {
  const denied = await guardStaff(sectionId)
  if (denied) return { error: denied }

  const parsed = differentiatedDraftSchema.safeParse(draft)
  if (!parsed.success) return { error: 'This draft is incomplete.' }

  try {
    const res = await createAnnouncement(sectionId, {
      title: parsed.data.title,
      content: parsed.data.content,
      status: 'draft',
      is_pinned: false,
      is_important: false,
      requires_acknowledgement: false,
      visibility: 'all',
      allow_reactions: true,
      allow_comments: true,
    })
    if (res.error) return { error: res.error }
    return {
      success: true,
      href: `/professor/courses/${sectionId}/announcements`,
      note: 'Saved the alternate version as a draft announcement.',
    }
  } catch (error) {
    logger.error('approveDifferentiatedDraft: failed', error, { sectionId })
    return { error: 'Could not save the version. Please try again.' }
  }
}

/** Read-only: list this section's projects for the rubric target picker (a rubric
 *  attaches to a project's guidelines — see approveRubricDraft for why not quizzes). */
export async function getAssistantRubricTargets(
  sectionId: string,
): Promise<{ data: { id: string; title: string }[]; error?: string }> {
  const ctx = await resolveStaff(sectionId)
  if (!ctx.ok) return { data: [], error: ctx.error }

  try {
    const { data: projects } = await ctx.adminDb
      .from('projects')
      .select('id, title')
      .eq('section_id', sectionId)
      .in('status', ['active', 'completed'])
      .order('created_at', { ascending: false })
    return { data: (projects || []).map((p: { id: string; title: string }) => ({ id: p.id, title: p.title })) }
  } catch (error) {
    logger.error('getAssistantRubricTargets: failed', error, { sectionId })
    return { data: [] }
  }
}

/** Read-only: list course discussion channels for the reply-draft channel picker. */
export async function getAssistantChannels(
  sectionId: string,
): Promise<{ data: { id: string; name: string }[]; error?: string }> {
  const denied = await guardStaff(sectionId)
  if (denied) return { data: [], error: denied }

  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { data: [], error: 'Not authenticated' }
    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { data: [], error: 'No access' }

    const { data, error } = await access.adminDb
      .from('discussion_channels')
      .select('id, name')
      .eq('section_id', sectionId)
      .eq('scope', 'course')
      .order('created_at', { ascending: true })

    if (error) {
      logger.error('getAssistantChannels: failed', error, { sectionId })
      return { data: [] }
    }
    return { data: (data || []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })) }
  } catch (error) {
    logger.error('getAssistantChannels: exception', error, { sectionId })
    return { data: [] }
  }
}

// ── Saved chats (multi-conversation) ───────────────────────────────────
// CRUD for Athena's saved conversations. Conversation CREATION + message
// persistence happen server-side in /api/professor-assistant (the route owns
// the write path so it stays in sync with the stream); these actions cover the
// list/load/rename/archive the console calls directly. All scope by user_id —
// each staff member's chats are private to them. Rename/archive are personal
// UI-state on the caller's own chats (not tenant audit events), so they skip
// logEvent; the substantive content is already audited by the route's
// professor_assistant.message event.

export interface ConversationSummary {
  id: string
  title: string | null
  updatedAt: string
}

/** This caller's non-archived chats in the section, most-recent activity first. */
export async function listConversations(
  sectionId: string,
): Promise<{ data: ConversationSummary[]; error?: string }> {
  const ctx = await resolveStaff(sectionId)
  if (!ctx.ok) return { data: [], error: ctx.error }

  const { data, error } = await ctx.adminDb
    .from('athena_conversations')
    .select('id, title, updated_at')
    .eq('section_id', sectionId)
    .eq('user_id', ctx.userId)
    // The console owns ONLY its own surface. Studio and student threads live in
    // this same table (migrations 20260806022237 / 20260831023338), and a
    // professor who is also enrolled somewhere would otherwise see their student
    // chats — and now their per-assignment Studio chats — in this sidebar.
    .eq('surface', 'professor')
    .eq('is_archived', false)
    .order('updated_at', { ascending: false })
    // Bound the read (data-access.md). A long-lived section can accumulate far
    // more threads than a sidebar can show; the rail renders newest-first anyway.
    .limit(50)

  if (error) {
    logger.error('listConversations: failed', error, { sectionId })
    return { data: [] }
  }
  return {
    data: (data || []).map((c: { id: string; title: string | null; updated_at: string }) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updated_at,
    })),
  }
}

/** Full message history for one chat, ordered, for hydrating useChat on switch. */
export async function loadConversation(
  sectionId: string,
  conversationId: string,
): Promise<{ messages: UIMessage[]; error?: string }> {
  const ctx = await resolveStaff(sectionId)
  if (!ctx.ok) return { messages: [], error: ctx.error }

  // IDOR: confirm the chat belongs to this caller before reading its messages.
  const { data: conv } = await ctx.adminDb
    .from('athena_conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', ctx.userId)
    .eq('section_id', sectionId)
    .maybeSingle()
  if (!conv) return { messages: [], error: 'Conversation not found' }

  const { data, error } = await ctx.adminDb
    .from('athena_messages')
    .select('id, role, parts')
    .eq('conversation_id', conversationId)
    .order('order_index', { ascending: true })

  if (error) {
    logger.error('loadConversation: failed', error, { sectionId, conversationId })
    return { messages: [] }
  }
  // Stored parts are SDK-produced UIMessage parts and the render path guards
  // every part.type, so we return them as-is rather than re-validating (which,
  // without our tool input schemas, could strip the very draft parts we persist).
  const messages = (data || []).map(
    (m: { id: string; role: string; parts: unknown }) =>
      ({ id: m.id, role: m.role, parts: m.parts }) as UIMessage,
  )

  // Attachments persist as storage PATHS in file parts. Mint fresh signed URLs
  // so the client can render the chips (and link to them) on reload, and keep
  // the path in providerMetadata so a re-sent turn still resolves to bytes.
  const filePaths: string[] = []
  for (const m of messages) {
    for (const part of m.parts as Array<{ type?: unknown; url?: unknown }>) {
      if (part?.type === 'file' && typeof part.url === 'string') filePaths.push(part.url)
    }
  }
  if (filePaths.length > 0) {
    const signed = await signAthenaAttachments(ctx.adminDb, filePaths)
    for (const m of messages) {
      m.parts = (
        m.parts as Array<{ type?: unknown; url?: unknown; providerMetadata?: Record<string, unknown> }>
      ).map((part) => {
        if (part?.type !== 'file' || typeof part.url !== 'string') return part
        const path = part.url
        return {
          ...part,
          url: signed.get(path) ?? path,
          providerMetadata: { ...(part.providerMetadata ?? {}), athena: { path } },
        }
      }) as UIMessage['parts']
    }
  }
  return { messages }
}

/** Rename a chat and lock it so auto-titling never overwrites the manual name. */
export async function renameConversation(
  sectionId: string,
  conversationId: string,
  title: string,
): Promise<{ success?: boolean; error?: string }> {
  const ctx = await resolveStaff(sectionId)
  if (!ctx.ok) return { error: ctx.error }

  const clean = normalizeAthenaTitle(title)
  if (!clean) return { error: 'Title cannot be empty.' }

  const { error } = await ctx.adminDb
    .from('athena_conversations')
    .update({ title: clean, title_locked: true })
    .eq('id', conversationId)
    .eq('user_id', ctx.userId)
    .eq('section_id', sectionId)

  if (error) {
    logger.error('renameConversation: failed', error, { sectionId, conversationId })
    return { error: 'Could not rename the chat. Please try again.' }
  }
  return { success: true }
}

/** Soft-delete (archive) a chat — hidden from the list, history retained. */
export async function archiveConversation(
  sectionId: string,
  conversationId: string,
): Promise<{ success?: boolean; error?: string }> {
  const ctx = await resolveStaff(sectionId)
  if (!ctx.ok) return { error: ctx.error }

  const { error } = await ctx.adminDb
    .from('athena_conversations')
    .update({ is_archived: true })
    .eq('id', conversationId)
    .eq('user_id', ctx.userId)
    .eq('section_id', sectionId)

  if (error) {
    logger.error('archiveConversation: failed', error, { sectionId, conversationId })
    return { error: 'Could not delete the chat. Please try again.' }
  }
  return { success: true }
}

/** Restore an archived chat (backs the "Undo" on delete). */
export async function unarchiveConversation(
  sectionId: string,
  conversationId: string,
): Promise<{ success?: boolean; error?: string }> {
  const ctx = await resolveStaff(sectionId)
  if (!ctx.ok) return { error: ctx.error }

  const { error } = await ctx.adminDb
    .from('athena_conversations')
    .update({ is_archived: false })
    .eq('id', conversationId)
    .eq('user_id', ctx.userId)
    .eq('section_id', sectionId)

  if (error) {
    logger.error('unarchiveConversation: failed', error, { sectionId, conversationId })
    return { error: 'Could not restore the chat.' }
  }
  return { success: true }
}
