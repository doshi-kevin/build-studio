/**
 * Chat persistence for Studio Athena (About page / Assignments / Quizzes /
 * Grading — the assistant docked on those three route subtrees). The third
 * Athena implementation to reuse `athena_conversations` / `athena_messages`,
 * alongside the professor Assistant Console ('professor') and the student dock
 * ('student'). See supabase/migrations/20260831023338_athena_studio_conversations.sql.
 *
 * Server-only. Called from /api/assignment-assistant (already authenticated +
 * section-access-verified) with the admin client — every id on a written row
 * comes from VERIFIED context, never the client.
 *
 * Titles use the same deterministic truncation the student surface uses
 * (`truncateTitle`), not a separate LLM call like the console's `maybeAutoTitle`
 * — a title-generation call per Studio turn would add a THIRD unmetered-feeling
 * cost line for marginal gain over "first few words of what the professor
 * typed", which is usually already a good title here (docs/reference/athena-cost-analysis.md).
 */

import 'server-only'
import type { UIMessage } from 'ai'
import { truncateTitle } from '@/lib/ai/conversation-utils'
import { ASSIGNMENT_FILL_TOOLS } from './schemas'
import { signAthenaAttachments, pathInScope } from '@/lib/ai/athena-attachments-server'
import { athenaAttachmentPrefix } from '@/lib/ai/athena-attachments'
import { logger } from '@/lib/logger'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export type StudioSurface = 'authoring' | 'grade' | 'general'

export interface StudioPersistCtx {
  adminDb: AdminDb
  conversationId: string
  sectionId: string
  userId: string
  institutionId: string
  studioSurface: StudioSurface
  studioKind: string | null
  assignmentId: string | null
  quizId: string | null
  projectId: string | null
  mode: 'standard' | 'frontier'
}

/** One past conversation, as the resume dropdown needs it. */
export interface StudioConversationSummary {
  id: string
  title: string
  mode: 'standard' | 'frontier'
  updatedAt: string
}

const CONVERSATION_COLS = 'id, title, mode, updated_at'

/** Lazily create the conversation row (idempotent — ON CONFLICT no-ops, so an
 *  existing row's original scope always wins over whatever the client claims
 *  on a later turn). Safe to call every turn. */
async function ensureConversation(c: StudioPersistCtx): Promise<void> {
  const { error } = await c.adminDb.from('athena_conversations').upsert(
    {
      id: c.conversationId,
      institution_id: c.institutionId,
      section_id: c.sectionId,
      user_id: c.userId,
      surface: 'studio',
      studio_surface: c.studioSurface,
      studio_kind: c.studioKind,
      assignment_id: c.assignmentId,
      quiz_id: c.quizId,
      project_id: c.projectId,
      mode: c.mode,
    },
    { onConflict: 'id', ignoreDuplicates: true },
  )
  if (error) throw new Error(`ensureConversation: ${error.message}`)
}

/** Append a message with an atomic, gap-free order_index (the shared RPC). */
async function appendMessage(c: StudioPersistCtx, role: 'user' | 'assistant', parts: unknown): Promise<void> {
  const { error } = await c.adminDb.rpc('athena_append_message', {
    p_conversation_id: c.conversationId,
    p_institution_id: c.institutionId,
    p_section_id: c.sectionId,
    p_user_id: c.userId,
    p_role: role,
    p_parts: parts,
  })
  if (error) throw new Error(`appendMessage(${role}): ${error.message}`)
}

/**
 * Persist the incoming user message. Called BEFORE streaming and AWAITED — if
 * it throws, the route returns 500 and never streams, so the client's
 * optimistic state can't drift from a DB that didn't record the turn.
 */
export async function persistUserMessage(c: StudioPersistCtx, message: UIMessage): Promise<void> {
  await ensureConversation(c)
  await appendMessage(c, 'user', message.parts)
}

/** Persist the assistant's full response message (all parts: text/tool/fill/source). */
export async function persistAssistantMessage(c: StudioPersistCtx, message: UIMessage): Promise<void> {
  await appendMessage(c, 'assistant', message.parts)
  // Bump updated_at so the resume dropdown re-sorts this thread to the top.
  await c.adminDb.from('athena_conversations').update({ updated_at: new Date().toISOString() }).eq('id', c.conversationId)
}

/**
 * One-shot title from the first user message — cheap deterministic truncation,
 * no model call. Atomic guard (`is('title', null)`) rather than a prior read:
 * an auto-sent follow-up turn can legitimately race right behind the user's
 * first message, and a read-then-write here would let both see "no title yet"
 * and both write (data-access.md's TOCTOU guidance). Also skips a chat the
 * professor already renamed (title_locked).
 */
export async function maybeAutoTitle(c: StudioPersistCtx, firstUserText: string): Promise<void> {
  try {
    const title = truncateTitle(firstUserText)
    const { error } = await c.adminDb
      .from('athena_conversations')
      .update({ title })
      .eq('id', c.conversationId)
      .eq('title_locked', false)
      .is('title', null)
    if (error) throw error
  } catch (err) {
    logger.warn('maybeAutoTitle: skipped', { conversationId: c.conversationId, err })
  }
}

/**
 * This caller's threads in the given Studio scope, newest activity first.
 * Scope = (surface, kind, item) exactly mirrors the client's in-memory
 * panelKey today — a chat about one assignment never surfaces alongside a
 * chat about a different one, or About, or a different quiz.
 */
export async function listStudioConversations(
  db: AdminDb,
  params: {
    sectionId: string
    userId: string
    studioSurface: StudioSurface
    studioKind: string | null
    assignmentId: string | null
    quizId: string | null
    projectId: string | null
    limit?: number
  },
): Promise<StudioConversationSummary[]> {
  let query = db
    .from('athena_conversations')
    .select(CONVERSATION_COLS)
    .eq('section_id', params.sectionId)
    .eq('user_id', params.userId)
    .eq('surface', 'studio')
    .eq('studio_surface', params.studioSurface)
    .eq('is_archived', false)

  // Normalise FIRST. These reach us through a server action whose argument is
  // client-supplied, so an absent key arrives as `undefined`, not `null` — and
  // `.eq(col, undefined)` does not mean "is null": it serialises as `col=eq.undefined`
  // and matches nothing, silently emptying the list for every item-less scope.
  const studioKind = params.studioKind ?? null
  const assignmentId = params.assignmentId ?? null
  const quizId = params.quizId ?? null
  const projectId = params.projectId ?? null

  query = studioKind === null ? query.is('studio_kind', null) : query.eq('studio_kind', studioKind)
  query = assignmentId === null ? query.is('assignment_id', null) : query.eq('assignment_id', assignmentId)
  query = quizId === null ? query.is('quiz_id', null) : query.eq('quiz_id', quizId)
  query = projectId === null ? query.is('project_id', null) : query.eq('project_id', projectId)

  const { data, error } = await query.order('updated_at', { ascending: false }).limit(params.limit ?? 50)

  if (error) {
    logger.error('listStudioConversations: query failed', error, {
      source: 'assignmentAssistant.listStudioConversations',
      sectionId: params.sectionId,
    })
    return []
  }
  // Every listed row has at least one real user turn (ensureConversation only
  // runs from persistUserMessage) — but the title can still be briefly null if
  // the professor closes the dock before the first reply lands and its
  // auto-title. Fall back the same way createStudentConversation's default does.
  return (data ?? []).map(
    (row: { id: string; title: string | null; mode: 'standard' | 'frontier'; updated_at: string }) => ({
      id: row.id,
      title: row.title ?? 'New Chat',
      mode: row.mode,
      updatedAt: row.updated_at,
    }),
  )
}



/**
 * Archive or restore one saved thread — the resume dropdown's delete, and its Undo.
 *
 * Soft, matching the professor console's convention rather than the student dock's
 * hard delete: a professor removing a thread from a list is tidying, not asking for
 * the transcript to be destroyed, and Undo has to have something to restore.
 *
 * The (user_id, section_id, surface) triple in the WHERE clause IS the authorization
 * — this runs through the service role, which bypasses RLS, so a missing filter here
 * would be the IDOR. Returns false rather than throwing when nothing matched, which
 * is also what a foreign id looks like.
 */
export async function setStudioConversationArchived(
  db: AdminDb,
  params: { conversationId: string; userId: string; sectionId: string; archived: boolean },
): Promise<boolean> {
  const { error, count } = await db
    .from('athena_conversations')
    .update({ is_archived: params.archived }, { count: 'exact' })
    .eq('id', params.conversationId)
    .eq('user_id', params.userId)
    .eq('section_id', params.sectionId)
    .eq('surface', 'studio')

  if (error) {
    logger.error('setStudioConversationArchived: update failed', error, {
      source: 'assignmentAssistant.setStudioConversationArchived',
      conversationId: params.conversationId,
    })
    return false
  }
  return (count ?? 0) > 0
}

/** Part types the browser resolves rather than the server — see tools.ts. */
const FILL_TOOL_PART_TYPES = new Set<string>(ASSIGNMENT_FILL_TOOLS.map((t) => `tool-${t}`))

/**
 * Settle restored fill-tool parts, so reopening a thread cannot re-run its edits.
 *
 * The fill tools have NO server-side `execute` (tools.ts:4) — the browser applies them
 * and posts the result back via `addToolResult`. The assistant message we persist in
 * `onFinish` is the SERVER's view, which never saw that result, so those parts are
 * stored as `input-available`. The panel's auto-apply effect fires on exactly that
 * state (AssignmentAthenaPanel: `if (part.state !== 'input-available') continue`).
 *
 * Hand a saved transcript back untouched and three things break, not one:
 *   1. every edit in the thread re-applies over whatever is on the canvas NOW,
 *      silently rewriting the professor's work — the reason this is a blocker;
 *   2. the chip renders "Applying…" forever, because the panel's `fills` map is
 *      empty after a remount and only a terminal state escapes that branch;
 *   3. a tool call carrying no result is invalid to the provider API, so the next
 *      turn in a resumed thread is rejected outright.
 *
 * Done on READ, never on write: the stored row stays a faithful record of what the
 * model actually emitted. `applied: true` is the right semantic even though the
 * original outcome is unknowable here — it stops the model re-issuing an edit that
 * already landed, which is the failure that would actually cost the professor work.
 */
function settleRestoredFills(messages: UIMessage[]): UIMessage[] {
  for (const m of messages) {
    m.parts = (m.parts as Array<{ type?: unknown; state?: unknown }>).map((part) => {
      if (typeof part?.type !== 'string' || !FILL_TOOL_PART_TYPES.has(part.type)) return part
      if (part.state !== 'input-available' && part.state !== 'input-streaming') return part
      return {
        ...part,
        state: 'output-available',
        output: { applied: true, summary: 'Applied while this chat was live.' },
      }
    }) as UIMessage['parts']
  }
  return messages
}

/** Full message history for one thread, ordered, for hydrating useChat on resume. */
export async function loadStudioConversation(
  db: AdminDb,
  params: { conversationId: string; userId: string; sectionId: string; institutionId: string },
): Promise<{ messages: UIMessage[]; mode: 'standard' | 'frontier'; error?: string }> {
  const { data: conv } = await db
    .from('athena_conversations')
    .select('id, mode')
    .eq('id', params.conversationId)
    .eq('user_id', params.userId)
    .eq('section_id', params.sectionId)
    .eq('surface', 'studio')
    .maybeSingle()
  if (!conv) return { messages: [], mode: 'standard', error: 'Conversation not found' }

  const { data, error } = await db
    .from('athena_messages')
    .select('id, role, parts')
    .eq('conversation_id', params.conversationId)
    .order('order_index', { ascending: true })

  if (error) {
    logger.error('loadStudioConversation: query failed', error, {
      source: 'assignmentAssistant.loadStudioConversation',
      conversationId: params.conversationId,
    })
    return { messages: [], mode: conv.mode }
  }

  const messages = (data ?? []).map(
    (m: { id: string; role: string; parts: unknown }) => ({ id: m.id, role: m.role, parts: m.parts }) as UIMessage,
  )

  // The About kind's syllabus-import files ride as file parts holding a storage
  // PATH (never a signed URL, which would go stale) — mint fresh signed URLs so
  // a reopened thread can still render and re-read them, exactly like the
  // console's loadConversation does for its own attachments.
  //
  // Belt and braces on top of the write-path guard in the route: only sign paths that
  // sit under THIS thread's verified prefix. Signing is an RLS-free capability run with
  // the admin client, so a path that somehow reached storage from another tenant must
  // not be minted into a working URL here either.
  const allowedPrefix = athenaAttachmentPrefix({
    institutionId: params.institutionId,
    sectionId: params.sectionId,
    scopeId: params.conversationId,
  })
  const filePaths: string[] = []
  for (const m of messages) {
    for (const part of m.parts as Array<{ type?: unknown; url?: unknown }>) {
      if (part?.type === 'file' && pathInScope(typeof part.url === 'string' ? part.url : undefined, allowedPrefix)) {
        filePaths.push(part.url as string)
      }
    }
  }
  if (filePaths.length > 0) {
    const signed = await signAthenaAttachments(db, filePaths)
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

  return { messages: settleRestoredFills(messages), mode: conv.mode }
}
