// Server actions for the AI Tutor chatbot. Handles conversation CRUD,
// message persistence, and course content gathering for LLM context.

'use server'

import { generateText } from 'ai'
import { google } from '@ai-sdk/google'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { AI_TUTOR_MODEL } from '@/lib/ai/config'
import { recordAiUsage } from '@/lib/ai/usage'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { findLiveQuizAttempt } from '@/lib/quiz/active-attempt'
import { openModuleFilter } from '@/lib/modules/unlock'
import {
  messageAttachments,
  truncateTitle,
  type DbMessage,
} from '@/lib/ai/conversation-utils'
import { signAthenaAttachments } from '@/lib/ai/athena-attachments-server'
import {
  createStudentConversation,
  deleteStudentConversation,
  findStudentConversation,
  firstStudentUserMessage,
  listStudentConversations,
  listStudentMessages,
  setStudentConversationTitle,
  type StudentConversation,
} from '@/lib/ai/athena-core/persistence'

// ── Helpers ──────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

async function verifyEnrollment(
  sectionId: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ enrolled: boolean; adminDb: any }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', userId)
    .in('status', ['enrolled', 'completed', 'active'])
    .single()

  if (!enrollment) return { enrolled: false, adminDb }
  return { enrolled: true, adminDb }
}

// ── Conversation CRUD ───────────────────────────────────────────

/** Create a new conversation thread for a student in a section. */
export async function createConversation(
  sectionId: string,
  title?: string,
): Promise<{ data: StudentConversation | null; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { data: null, error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { data: null, error: 'Not enrolled in this section' }

    // The thread carries its tenant. Read it from the SECTION the enrollment
    // check just passed — never from the client, and never inferred from the
    // caller's profile (a student's own institution and the section's must be
    // the same row for the enrollment to exist, but only one of them is the
    // tenant this thread belongs to).
    const { data: section } = await adminDb
      .from('course_sections')
      .select('institution_id')
      .eq('id', sectionId)
      .single()
    if (!section) return { data: null, error: 'Course section not found' }

    const conversation = await createStudentConversation(adminDb, {
      institutionId: section.institution_id,
      sectionId,
      userId: user.id,
      title,
    })
    if (!conversation) return { data: null, error: 'Failed to create conversation' }

    return { data: conversation }
  } catch (err) {
    logger.error('createConversation: Exception', err, { sectionId })
    return { data: null, error: 'An unexpected error occurred' }
  }
}

/** Get the tail of a conversation — the turns a reopened thread shows. */
export async function getMessages(
  conversationId: string,
  limit = 50,
): Promise<{ data: DbMessage[]; hasMore: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { data: [], hasMore: false, error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const conversation = await findStudentConversation(adminDb, {
      conversationId,
      userId: user.id,
    })
    if (!conversation) {
      return { data: [], hasMore: false, error: 'Conversation not found' }
    }

    const { messages, hasMore } = await listStudentMessages(adminDb, { conversationId, limit })

    // Attachments persist as storage PATHS. Mint fresh signed URLs (1h) in one
    // batch so a reopened thread can still show — and link to — the files the
    // student attached; the path stays on the part so a follow-up question can
    // re-send it.
    const paths = messages.flatMap((m) => messageAttachments(m).map((a) => a.path))
    if (paths.length > 0) {
      const signed = await signAthenaAttachments(adminDb, paths)
      for (const m of messages) {
        const attachments = messageAttachments(m)
        if (attachments.length === 0) continue
        m.metadata = {
          ...m.metadata,
          attachments: attachments.map((a) => ({ ...a, signedUrl: signed.get(a.path) })),
        }
      }
    }

    return { data: messages, hasMore }
  } catch (err) {
    logger.error('getMessages: Exception', err, { conversationId })
    return { data: [], hasMore: false, error: 'An unexpected error occurred' }
  }
}

/** Delete a conversation and all its messages (cascade). */
export async function deleteConversation(
  conversationId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { success: false, error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const conversation = await findStudentConversation(adminDb, {
      conversationId,
      userId: user.id,
    })
    if (!conversation) {
      return { success: false, error: 'Conversation not found' }
    }

    if (!(await deleteStudentConversation(adminDb, { conversationId, userId: user.id }))) {
      return { success: false, error: 'Failed to delete conversation' }
    }

    return { success: true }
  } catch (err) {
    logger.error('deleteConversation: Exception', err, { conversationId })
    return { success: false, error: 'An unexpected error occurred' }
  }
}

/** Clean an LLM-produced title: strip wrapping quotes, collapse whitespace,
 *  drop a trailing period, and hard-cap the length. */
function sanitizeAiTitle(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '') // wrapping quotes
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '') // trailing period/space
    .trim()
  return truncateTitle(cleaned, 48)
}

/**
 * Generate a concise (≤6 word) title for a conversation from its first user
 * message, using Gemini Flash. Called by the client after the first exchange.
 * Falls back to the shortened first message on any failure, so it never blocks.
 */
export async function generateConversationTitle(
  conversationId: string,
): Promise<{ title: string | null; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { title: null, error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const conversation = await findStudentConversation(adminDb, {
      conversationId,
      userId: user.id,
    })
    if (!conversation) return { title: null, error: 'Conversation not found' }

    // Earliest user message is what we summarize.
    const firstMessage = await firstStudentUserMessage(adminDb, conversationId)

    const question = (firstMessage?.content || '').trim()
    /* A file with no question has nothing to summarize — the route already titled the
       thread with the filename, which beats anything a model would invent from it.
       Returning null here was correct about the MODEL and wrong about the CLIENT (#660
       part 2): the rail only patches when it gets a title back, so a file-only first turn
       sat as "New Chat" until a reload even though the stored value was already right.
       Hand back the title that exists instead of nothing. */
    if (!question) {
      return firstMessage && messageAttachments(firstMessage).length > 0
        ? { title: conversation.title ?? null }
        : { title: null, error: 'No message to summarize' }
    }

    // Deterministic fallback if the model call fails.
    let title = truncateTitle(question, 48)

    // Institution/platform AI kill switch — keep the deterministic truncated
    // title (the thread still gets named), just skip the model call.
    const aiVerdict = await checkAiFeatureBySection(adminDb, conversation.section_id, 'athena-student')
    if (!aiVerdict.allowed) {
      const { error } = await adminDb.from('ai_conversations').update({ title }).eq('id', conversationId)
      if (error) {
        logger.error('generateConversationTitle: Update failed', error, { conversationId })
        return { title: null, error: 'Failed to update title' }
      }
      return { title }
    }

    try {
      const { text, usage } = await generateText({
        model: google(AI_TUTOR_MODEL),
        temperature: 0.3,
        prompt:
          'Summarize the following student question as a short chat title of AT MOST 6 words. ' +
          'Use title case. Do not use quotes. Do not add a trailing period. ' +
          'Return ONLY the title.\n\nQuestion: ' +
          question,
      })
      void recordAiUsage({
        feature: 'conversation_title',
        model: AI_TUTOR_MODEL,
        sectionId: conversation.section_id,
        userId: user.id,
        usage,
      })
      const aiTitle = sanitizeAiTitle(text)
      if (aiTitle) title = aiTitle
    } catch (err) {
      logger.warn('generateConversationTitle: model call failed, using fallback', {
        conversationId,
        err: String(err),
      })
    }

    if (!(await setStudentConversationTitle(adminDb, { conversationId, userId: user.id, title }))) {
      return { title: null, error: 'Failed to update title' }
    }

    return { title }
  } catch (err) {
    logger.error('generateConversationTitle: Exception', err, { conversationId })
    return { title: null, error: 'An unexpected error occurred' }
  }
}

// ── Athena Shell bootstrap ──────────────────────────────────────

export interface AthenaContext {
  conversations: StudentConversation[]
  /** Published, previewable items for mapping [Title, page N] citations. */
  documents: { id: string; title: string; fileType: string }[]
}

/**
 * Everything the Athena shell needs on first open, in one round trip: the
 * student's threads (for the history picker — opening Athena always starts
 * at the greeting, prototype-style) and the citable document list. Loaded
 * lazily (orb click), never on page render.
 */
/**
 * Is this student sitting a graded quiz right now — in ANY of their courses?
 *
 * The shell's half of the quiz lock: it takes Athena off the screen rather than
 * leaving a button that leads to a refusal. Same rule as the send path (both go
 * through `findLiveQuizAttempt`), so the two can't disagree. Called on mount and
 * when a tab regains focus; the focus check is what releases a lock whose quiz
 * tab was closed or crashed.
 *
 * `sectionId` authorizes the caller (enrolled students only), it does NOT scope
 * the check — a section-scoped lock would leave Athena open in the student's
 * other courses while they sit the quiz.
 */
export async function hasActiveQuizAttempt(sectionId: string): Promise<boolean> {
  try {
    const user = await getAuthUser()
    if (!user) return false

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return false

    return !!(await findLiveQuizAttempt(adminDb, user.id))
  } catch (err) {
    logger.error('hasActiveQuizAttempt: Exception', err, { sectionId })
    // Fail OPEN here, and only here: this call decides whether a BUTTON renders.
    // The send path fails closed, so a failed read can't leak an answer — while
    // failing closed here would hide Athena for the rest of the term.
    return false
  }
}

export async function getAthenaContext(
  sectionId: string,
): Promise<{ data: AthenaContext | null; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { data: null, error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { data: null, error: 'Not enrolled in this section' }

    const [conversations, { data: pubModules }] = await Promise.all([
      listStudentConversations(adminDb, { sectionId, userId: user.id }),
      adminDb
        .from('modules')
        .select('id')
        .eq('section_id', sectionId)
        .eq('is_published', true)
        /* Published AND already open (main's unlock gate, ported into this
           replacement for getCourseContentForChat): the ids below ship to the
           browser and are exactly what /api/extraction/page renders from, so a
           locked week listed here would hand out the key to its slides. */
        .or(openModuleFilter()),
    ])

    const moduleIds = ((pubModules || []) as { id: string }[]).map((m) => m.id)
    const itemsRes =
      moduleIds.length > 0
        ? await adminDb
            .from('module_items')
            .select('id, title, content')
            .in('module_id', moduleIds)
            .eq('is_visible', true)
        : { data: [] }

    const documents = ((itemsRes.data || []) as {
      id: string
      title: string | null
      content: { fileType?: string } | null
    }[])
      .map((it) => ({ id: it.id, title: it.title || 'Untitled', fileType: it.content?.fileType || '' }))
      // The page-render endpoint previews PDFs directly and converts PPTX/PPT.
      .filter((d) => d.fileType === 'pdf' || d.fileType === 'pptx' || d.fileType === 'ppt')

    return { data: { conversations, documents } }
  } catch (err) {
    logger.error('getAthenaContext: Exception', err, { sectionId })
    return { data: null, error: 'An unexpected error occurred' }
  }
}

/**
 * What the professor actually SAID on a cited slide (N1).
 *
 * A "said in class" citation — `[Deck (spoken), slide N]` — is evidence from the
 * lecture transcript, not from the deck, so the preview panel leads with the
 * words and keeps the slide underneath. The chip only knows the module item and
 * the slide number, which is what this resolves.
 *
 * Visibility is re-derived here rather than trusted from the citation, mirroring
 * `hydrateTranscriptMatches` in lib/pinecone/search.ts — the room must belong to
 * this section, must have ENDED, and the professor must have left "Catch me up"
 * on (null predates the toggle and means on). A toggle flipped off after the
 * answer streamed takes the passage away on the next click, which is the point
 * of gating at read time.
 *
 * Returns `{ text: null }` for "nothing to show" — a deck never presented live,
 * a slide nobody spoke over, a professor who turned the recap off. The panel
 * falls back to the slide alone, which is what it showed before this existed.
 */
export async function getSpokenPassage(
  sectionId: string,
  /** 1-based, as the citation prints it; `lc_transcriptions` is 0-based. */
  slide: number,
  /** How the citation named the source. `title` is the deck title the answer
   *  printed; `itemId` is the material its chip resolved to, which is only the
   *  same object when the deck was promoted into the modules — most decks carry
   *  no `module_item_id` at all, so the title is the load-bearing key here. */
  ref: { title?: string; itemId?: string },
): Promise<{ text: string | null; room?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { text: null }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { text: null }
    if (!Number.isInteger(slide) || slide < 1) return { text: null }
    const wanted = (ref.title ?? '').trim().toLowerCase()
    if (!wanted && !ref.itemId) return { text: null }

    /* Scoped to this section's ended rooms at ONE page number, so the row set is
       a handful even in a term-long course — the deck match then happens in JS
       because it has three shapes (see below) and PostgREST can't express that
       as one filter. */
    const { data: rows, error } = await adminDb
      .from('lc_transcriptions')
      .select(
        'text, lc_rooms!inner(name, status, lecture_summary_enabled, section_id, ended_at), lc_decks!inner(title, module_item_id)',
      )
      .eq('page_number', slide - 1)
      .eq('lc_rooms.section_id', sectionId)
      .eq('lc_rooms.status', 'ended')
      .limit(50)

    if (error) {
      logger.error('getSpokenPassage: transcript read failed', error, { sectionId, slide })
      return { text: null }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const single = (v: any) => (Array.isArray(v) ? v[0] : v)
    const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()
    const usable = ((rows || []) as unknown[])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any) => ({ text: (r.text as string) ?? '', room: single(r.lc_rooms), deck: single(r.lc_decks) }))
      .filter((r) => r.text.trim() && r.room && r.deck)
      // Null predates the toggle and means ON — the same default the retrieval
      // side applies, so the panel can't show what search would have hidden.
      .filter((r) => r.room.lecture_summary_enabled !== false)
      .filter(
        (r) =>
          // Every way the citation can name this deck, in the order search.ts
          // builds the title (`deck.title || room.name || 'Live class'`): the
          // deck's own title, the room's name when the deck had none, that last
          // literal when BOTH are blank, or the material the deck was promoted
          // from. Miss one and the chip opens a slide with no words under it.
          (!!wanted && norm(r.deck.title) === wanted) ||
          (!!wanted && norm(r.room.name) === wanted) ||
          (wanted === 'live class' && !norm(r.deck.title) && !norm(r.room.name)) ||
          (!!ref.itemId && r.deck.module_item_id === ref.itemId),
      )
      /* A deck presented in more than one session (a re-run, a make-up class)
         has a passage per room; the most recent one is the class the student
         was actually in. `ended_at` is set for every room this query keeps. */
      .sort((a, b) => String(b.room.ended_at ?? '').localeCompare(String(a.room.ended_at ?? '')))

    const best = usable[0]
    if (!best) return { text: null }
    return { text: best.text.trim(), room: (best.room.name as string | null)?.trim() || undefined }
  } catch (err) {
    logger.error('getSpokenPassage: Exception', err, { sectionId, slide })
    return { text: null }
  }
}
