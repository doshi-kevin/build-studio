/**
 * Chat persistence for Athena's saved conversations.
 *
 * Server-only. Called from the /api/professor-assistant route (which already
 * authenticated the caller + verified section access) with the admin client.
 * Writes go through the service role, so the user_id/section_id/institution_id
 * carried on every row come from VERIFIED context — never the client.
 *
 * See docs/designs/athena/athena-chat-persistence-design.md.
 */

import 'server-only'
import { google } from '@ai-sdk/google'
import { generateText, type UIMessage } from 'ai'
import { AI_TUTOR_MODEL } from '@/lib/ai/config'
import { logger } from '@/lib/logger'
import { recordAiUsage } from '@/lib/ai/usage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export interface ChatPersistCtx {
  adminDb: AdminDb
  conversationId: string
  sectionId: string
  userId: string
  institutionId: string
}

/** Lazily create the conversation row (idempotent) — safe to call every turn. */
async function ensureConversation(c: ChatPersistCtx): Promise<void> {
  const { error } = await c.adminDb.from('athena_conversations').upsert(
    {
      id: c.conversationId,
      institution_id: c.institutionId,
      section_id: c.sectionId,
      user_id: c.userId,
    },
    { onConflict: 'id', ignoreDuplicates: true },
  )
  if (error) throw new Error(`ensureConversation: ${error.message}`)
}

/** Append a message with an atomic, gap-free order_index (server-side RPC). */
async function appendMessage(c: ChatPersistCtx, role: 'user' | 'assistant', parts: unknown): Promise<void> {
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
export async function persistUserMessage(c: ChatPersistCtx, message: UIMessage): Promise<void> {
  await ensureConversation(c)
  await appendMessage(c, 'user', message.parts)
}

/** Persist the assistant's full response message (all parts: text/tool/sources). */
export async function persistAssistantMessage(c: ChatPersistCtx, message: UIMessage): Promise<void> {
  await appendMessage(c, 'assistant', message.parts)
  // bump updated_at so the sidebar re-sorts this chat to the top
  await c.adminDb.from('athena_conversations').update({ updated_at: new Date().toISOString() }).eq('id', c.conversationId)
}

/**
 * One-shot auto-title from the first user message — cheap Flash call, runs after
 * the first exchange. No-ops if the chat already has a title or was manually
 * renamed (title_locked), and the final UPDATE re-checks title_locked so a
 * manual rename that raced in is never clobbered.
 */
export async function maybeAutoTitle(c: ChatPersistCtx, firstUserText: string): Promise<void> {
  try {
    if (!firstUserText.trim()) return
    const { data: conv } = await c.adminDb
      .from('athena_conversations')
      .select('title, title_locked')
      .eq('id', c.conversationId)
      .maybeSingle()
    if (!conv || conv.title || conv.title_locked) return

    const { text, usage } = await generateText({
      model: google(AI_TUTOR_MODEL),
      prompt: `Write a 3–6 word title in Title Case for a chat between a professor and a teaching assistant that begins with this request. No quotes, no trailing punctuation, no preamble — just the title.\n\nRequest: "${firstUserText.slice(0, 500)}"`,
      temperature: 0.3,
    })
    void recordAiUsage({
      feature: 'conversation_title',
      model: AI_TUTOR_MODEL,
      institutionId: c.institutionId,
      sectionId: c.sectionId,
      userId: c.userId,
      usage,
    })
    const title = text.trim().replace(/^["']|["']$/g, '').slice(0, 80)
    if (!title) return

    await c.adminDb
      .from('athena_conversations')
      .update({ title })
      .eq('id', c.conversationId)
      .eq('title_locked', false)
  } catch (err) {
    logger.warn('maybeAutoTitle: skipped', { conversationId: c.conversationId, err })
  }
}
