/**
 * athena-core — chat persistence for the STUDENT Athena surface.
 *
 * Server-only. Every function takes the admin client and is called from code
 * that has ALREADY authenticated the caller and verified their enrollment —
 * these functions do no authorization of their own except the ownership filter
 * baked into each query's WHERE clause (`user_id`, and `section_id` where the
 * caller knows it). That filter is not decoration: it is what makes a forged
 * conversation id from another student return nothing instead of a thread.
 *
 * Storage is `athena_conversations` / `athena_messages` with
 * `surface = 'student'` (§7 of docs/designs/athena-students.md). RLS on both
 * tables is owner-only (`user_id = auth.uid()`) and carries no INSERT/UPDATE/
 * DELETE policy — writes are service-role, exactly as the professor surface
 * does it, so student rows are isolated by policies that already existed.
 *
 * Message shape: the professor surface stores whole UIMessage `parts`; this
 * surface stores a turn's plain TEXT (plus attachment paths and run rows in
 * `metadata`), because that is what its client renders and what its citation
 * parser re-reads. Both live in the same table — `parts` holds one text part
 * here, so a future converged reader needs no special case.
 */

import 'server-only'
import { logger } from '@/lib/logger'
import { truncateTitle, type DbMessage } from '@/lib/ai/conversation-utils'

// The admin Supabase client is intentionally loosely typed across the codebase
// (section-access.ts does the same) — the generated types don't cover our RPCs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

/** The student surface's discriminator on `athena_conversations`. */
export const STUDENT_SURFACE = 'student'

/** A student's chat thread, as the picker and the shell need it. */
export interface StudentConversation {
  id: string
  section_id: string
  title: string
  created_at: string
  updated_at: string
}

const CONVERSATION_COLS = 'id, section_id, title, created_at, updated_at'

/** Wrap a turn's text as the single text part `athena_messages.parts` expects. */
function textParts(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

/** Read a turn's text back out of `parts`, tolerating a row with none. */
function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((p): p is { type: string; text?: string } => !!p && typeof p === 'object')
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}

/**
 * The student's threads in a section, newest activity first.
 *
 * `surface` is filtered here and nowhere else that matters: RLS already scopes
 * the row to its owner, so this filter is about not showing a professor their
 * own console threads inside the student dock (which can only happen to someone
 * enrolled in a section they also teach) — a listing concern, not an authz one.
 */
export async function listStudentConversations(
  db: AdminDb,
  params: { sectionId: string; userId: string; limit?: number },
): Promise<StudentConversation[]> {
  const { data, error } = await db
    .from('athena_conversations')
    .select(CONVERSATION_COLS)
    .eq('user_id', params.userId)
    .eq('section_id', params.sectionId)
    .eq('surface', STUDENT_SURFACE)
    .eq('is_archived', false)
    .order('updated_at', { ascending: false })
    .limit(params.limit ?? 50)

  if (error) {
    logger.error('listStudentConversations: query failed', error, {
      source: 'athenaCore.listStudentConversations',
      sectionId: params.sectionId,
    })
    return []
  }
  return (data ?? []) as StudentConversation[]
}

/** Create a thread. The id is generated HERE, server-side — the client never
 *  names a row it is about to be given ownership of. */
export async function createStudentConversation(
  db: AdminDb,
  params: { institutionId: string; sectionId: string; userId: string; title?: string },
): Promise<StudentConversation | null> {
  const { data, error } = await db
    .from('athena_conversations')
    .insert({
      id: crypto.randomUUID(),
      institution_id: params.institutionId,
      section_id: params.sectionId,
      user_id: params.userId,
      surface: STUDENT_SURFACE,
      title: params.title || 'New Chat',
    })
    .select(CONVERSATION_COLS)
    .single()

  if (error) {
    logger.error('createStudentConversation: insert failed', error, {
      source: 'athenaCore.createStudentConversation',
      sectionId: params.sectionId,
    })
    return null
  }
  return data as StudentConversation
}

/**
 * The thread, if this student owns it on this surface — otherwise null.
 *
 * `sectionId` is optional but should be passed by any caller that knows it: the
 * conversation id flows into tool context and onto `athena_artifacts`, so a
 * thread from the student's OTHER course must not be attachable to this
 * section's turn.
 */
export async function findStudentConversation(
  db: AdminDb,
  params: { conversationId: string; userId: string; sectionId?: string },
): Promise<StudentConversation | null> {
  let query = db
    .from('athena_conversations')
    .select(CONVERSATION_COLS)
    .eq('id', params.conversationId)
    .eq('user_id', params.userId)
    .eq('surface', STUDENT_SURFACE)
  if (params.sectionId) query = query.eq('section_id', params.sectionId)

  const { data } = await query.maybeSingle()
  return (data as StudentConversation | null) ?? null
}

/** A thread's turns, oldest first — the order the transcript is read in. */
export async function listStudentMessages(
  db: AdminDb,
  params: { conversationId: string; limit?: number },
): Promise<{ messages: DbMessage[]; hasMore: boolean }> {
  const limit = params.limit ?? 50
  // Newest-first + limit+1 reads the TAIL of a long thread (the part a reopened
  // chat shows) and tells us whether anything is above it; the rows are then
  // flipped back into reading order.
  const { data, error } = await db
    .from('athena_messages')
    .select('id, conversation_id, role, parts, metadata, created_at')
    .eq('conversation_id', params.conversationId)
    .order('order_index', { ascending: false })
    .limit(limit + 1)

  if (error) {
    logger.error('listStudentMessages: query failed', error, {
      source: 'athenaCore.listStudentMessages',
      conversationId: params.conversationId,
    })
    return { messages: [], hasMore: false }
  }

  const rows = (data ?? []) as Array<{
    id: string
    conversation_id: string
    role: DbMessage['role']
    parts: unknown
    metadata: DbMessage['metadata'] | null
    created_at: string
  }>
  const hasMore = rows.length > limit
  if (hasMore) rows.pop()
  rows.reverse()

  return {
    messages: rows.map((r) => ({
      id: r.id,
      conversation_id: r.conversation_id,
      role: r.role,
      content: partsText(r.parts),
      metadata: r.metadata ?? {},
      created_at: r.created_at,
    })),
    hasMore,
  }
}

/**
 * Append one turn with an atomic, gap-free `order_index` (the RPC takes a
 * per-conversation advisory lock, with the UNIQUE constraint as the backstop —
 * two sends in two tabs can't claim the same index).
 *
 * `metadata` is DATA, never markers: an app-driving directive stored in message
 * text would be re-parsed every time the thread is reopened and would drive the
 * app again on each visit. Run rows go here so they can be rendered but never
 * re-fired.
 */
export async function appendStudentMessage(
  db: AdminDb,
  params: {
    conversationId: string
    institutionId: string
    sectionId: string
    userId: string
    role: 'user' | 'assistant'
    content: string
    metadata?: Record<string, unknown>
  },
): Promise<{ orderIndex: number } | null> {
  const { data, error } = await db.rpc('athena_append_message', {
    p_conversation_id: params.conversationId,
    p_institution_id: params.institutionId,
    p_section_id: params.sectionId,
    p_user_id: params.userId,
    p_role: params.role,
    p_parts: textParts(params.content),
    p_metadata: params.metadata ?? {},
  })

  if (error) {
    logger.error('appendStudentMessage: rpc failed', error, {
      source: 'athenaCore.appendStudentMessage',
      conversationId: params.conversationId,
      role: params.role,
    })
    return null
  }
  // The RPC returns the order_index it claimed; 1 means this was the first turn.
  const orderIndex = typeof data === 'number' ? data : Number(data)
  return { orderIndex: Number.isFinite(orderIndex) ? orderIndex : 0 }
}

/**
 * Write the student's own turn: append it, re-sort the thread, and name the
 * thread if this was its first message.
 *
 * The three steps belong together — the route used to open-code them, and the
 * title step is the subtle one: "is this the first message?" is answered by the
 * order_index the append RPC just claimed, not by a follow-up COUNT that a
 * concurrent second send could race.
 *
 * Never throws. A thread that fails to record the question still has to answer
 * it; the failure is logged, not surfaced.
 */
export async function recordUserTurn(
  db: AdminDb,
  params: {
    conversationId: string
    institutionId: string
    sectionId: string
    userId: string
    content: string
    metadata?: Record<string, unknown>
    /** Used to name a thread whose first turn carried no text (a file alone). */
    fallbackTitle?: string
  },
): Promise<void> {
  try {
    const appended = await appendStudentMessage(db, {
      conversationId: params.conversationId,
      institutionId: params.institutionId,
      sectionId: params.sectionId,
      userId: params.userId,
      role: 'user',
      content: params.content,
      ...(params.metadata ? { metadata: params.metadata } : {}),
    })

    await touchStudentConversation(db, {
      conversationId: params.conversationId,
      userId: params.userId,
    })

    if (appended?.orderIndex === 1) {
      await setStudentConversationTitle(db, {
        conversationId: params.conversationId,
        userId: params.userId,
        title: truncateTitle(params.content || params.fallbackTitle || ''),
      })
    }
  } catch (err) {
    logger.error('recordUserTurn: failed to save the user message', err, {
      source: 'athenaCore.recordUserTurn',
      conversationId: params.conversationId,
    })
  }
}

/*
 * The three mutating helpers below all carry `userId` in their own WHERE clause,
 * even though every current caller has already proved ownership with
 * findStudentConversation. That lookup is a check the NEXT caller can forget;
 * the filter here is one the statement cannot execute without. Same shape the
 * roadmap-artifact actions use — ownership in the UPDATE/DELETE itself.
 */

/** Bump the thread so it re-sorts to the top of the picker. */
export async function touchStudentConversation(
  db: AdminDb,
  params: { conversationId: string; userId: string },
): Promise<void> {
  await db
    .from('athena_conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', params.conversationId)
    .eq('user_id', params.userId)
}

/**
 * Name a thread. Skips a thread the student renamed themselves — `title_locked`
 * is checked in the WHERE clause, so a manual rename that raced in is never
 * clobbered by an auto-title arriving late.
 */
export async function setStudentConversationTitle(
  db: AdminDb,
  params: { conversationId: string; userId: string; title: string },
): Promise<boolean> {
  const { error } = await db
    .from('athena_conversations')
    .update({ title: params.title })
    .eq('id', params.conversationId)
    .eq('user_id', params.userId)
    .eq('title_locked', false)

  if (error) {
    logger.error('setStudentConversationTitle: update failed', error, {
      source: 'athenaCore.setStudentConversationTitle',
      conversationId: params.conversationId,
    })
    return false
  }
  return true
}

/**
 * Delete a thread and its messages (FK cascade). The sharpest of the three: one
 * wrong id takes every message in someone else's thread with it, which is why
 * the owner is in the WHERE rather than only in the caller's preceding check.
 */
export async function deleteStudentConversation(
  db: AdminDb,
  params: { conversationId: string; userId: string },
): Promise<boolean> {
  const { error } = await db
    .from('athena_conversations')
    .delete()
    .eq('id', params.conversationId)
    .eq('user_id', params.userId)

  if (error) {
    logger.error('deleteStudentConversation: delete failed', error, {
      source: 'athenaCore.deleteStudentConversation',
      conversationId: params.conversationId,
    })
    return false
  }
  return true
}

/** The thread's first user turn — what the auto-title summarizes. */
export async function firstStudentUserMessage(
  db: AdminDb,
  conversationId: string,
): Promise<DbMessage | null> {
  const { data } = await db
    .from('athena_messages')
    .select('id, conversation_id, role, parts, metadata, created_at')
    .eq('conversation_id', conversationId)
    .eq('role', 'user')
    .order('order_index', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!data) return null
  const row = data as { id: string; conversation_id: string; parts: unknown; metadata: DbMessage['metadata'] | null; created_at: string }
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: 'user',
    content: partsText(row.parts),
    metadata: row.metadata ?? {},
    created_at: row.created_at,
  }
}
