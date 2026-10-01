// Server actions for the unified Live Classroom interactions model.
// Each action verifies room ownership (prof) or enrollment (student),
// validates input via Zod, mutates lc_interactions / lc_responses, and
// relies on the migration-36 triggers to broadcast lifecycle + aggregate
// events on the room's authoritative topic.

'use server'

import { revalidatePath } from 'next/cache'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAuthUser, loadRoom, isEnrolled } from '@/lib/live-classroom/room-auth'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import {
  createInteractionSchema,
  openInteractionSchema,
  closeInteractionSchema,
  deleteInteractionSchema,
  listPreparedInteractionsSchema,
  listReusableInteractionsSchema,
  submitResponseSchema,
  askQuestionSchema,
  upvoteQuestionSchema,
  markAnsweredSchema,
  replyToQuestionSchema,
  type CreateInteractionInput,
  type OpenInteractionInput,
  type CloseInteractionInput,
  type DeleteInteractionInput,
  type ListPreparedInteractionsInput,
  type ListReusableInteractionsInput,
  type SubmitResponseInput,
  type AskQuestionInput,
  type UpvoteQuestionInput,
  type MarkAnsweredInput,
  type ReplyToQuestionInput,
} from '@/lib/validations/lc-interactions'

// ── Helpers ──────────────────────────────────────────────────────────
// getAuthUser / loadRoom / isEnrolled live in ../room-auth (shared with
// the attendance + lecture-summary actions).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadInteraction(adminDb: any, interactionId: string) {
  const { data, error } = await adminDb
    .from('lc_interactions')
    .select('id, room_id, kind, payload, status, created_by')
    .eq('id', interactionId)
    .single()
  return error
    ? null
    : data as {
        id: string
        room_id: string
        kind: 'poll' | 'quiz' | 'question'
        payload: Record<string, unknown>
        status: 'draft' | 'open' | 'closed'
        created_by: string
      }
}

// ── createInteraction (prof) ─────────────────────────────────────────

export async function createInteraction(
  input: CreateInteractionInput,
): Promise<{ interactionId?: string; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createInteractionSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const room = await loadRoom(adminDb, parsed.data.roomId)
    if (!room) return { error: 'Room not found' }
    if (room.prof_id !== user.id) return { error: 'Only the room professor can create interactions' }
    if (room.status !== 'live') return { error: 'Room has ended' }

    const { data: created, error } = await adminDb
      .from('lc_interactions')
      .insert({
        room_id: parsed.data.roomId,
        kind: parsed.data.kind,
        payload: parsed.data.payload,
        status: 'draft',
        created_by: user.id,
      })
      .select('id')
      .single()

    if (error || !created) {
      logger.error('createInteraction: insert failed', error, { roomId: parsed.data.roomId })
      return { error: 'Failed to create interaction' }
    }

    logEvent({
      userId: user.id,
      eventType: `lc_interaction.${parsed.data.kind}.created`,
      eventCategory: 'professor',
      metadata: { roomId: parsed.data.roomId, interactionId: created.id },
      sectionId: room.section_id,
    })

    revalidatePath(`/professor/courses/${room.section_id}/live-classroom`)
    return { interactionId: created.id }
  } catch (err) {
    logger.error('createInteraction: unexpected', err)
    return { error: 'An unexpected error occurred' }
  }
}

// ── openInteraction (prof) ───────────────────────────────────────────

export async function openInteraction(
  input: OpenInteractionInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = openInteractionSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const interaction = await loadInteraction(adminDb, parsed.data.interactionId)
    if (!interaction) return { error: 'Interaction not found' }

    const room = await loadRoom(adminDb, interaction.room_id)
    if (!room || room.prof_id !== user.id) return { error: 'Forbidden' }
    if (interaction.status !== 'draft' && interaction.status !== 'closed') {
      return { error: 'Interaction is already open' }
    }

    const { error } = await adminDb
      .from('lc_interactions')
      .update({ status: 'open', opened_at: new Date().toISOString(), closed_at: null })
      .eq('id', parsed.data.interactionId)

    if (error) {
      logger.error('openInteraction: update failed', error, { interactionId: parsed.data.interactionId })
      return { error: 'Failed to open interaction' }
    }

    return { success: true }
  } catch (err) {
    logger.error('openInteraction: unexpected', err)
    return { error: 'An unexpected error occurred' }
  }
}

// ── closeInteraction (prof) ──────────────────────────────────────────

export async function closeInteraction(
  input: CloseInteractionInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = closeInteractionSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const interaction = await loadInteraction(adminDb, parsed.data.interactionId)
    if (!interaction) return { error: 'Interaction not found' }

    const room = await loadRoom(adminDb, interaction.room_id)
    if (!room || room.prof_id !== user.id) return { error: 'Forbidden' }
    if (interaction.status !== 'open') return { error: 'Interaction is not open' }

    const { error } = await adminDb
      .from('lc_interactions')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', parsed.data.interactionId)

    if (error) {
      logger.error('closeInteraction: update failed', error, { interactionId: parsed.data.interactionId })
      return { error: 'Failed to close interaction' }
    }

    // Final aggregate broadcast — the trigger debounces, this final emit
    // ensures the UI sees the absolute final count even if the last
    // submission landed inside the 500ms debounce window.
    await adminDb.rpc('lc_send_event', {
      p_room_id: interaction.room_id,
      p_event_type: 'aggregate_updated',
      p_data: { interactionId: parsed.data.interactionId, final: true },
      p_persist: true,
    }).then(() => undefined).catch(() => undefined)

    return { success: true }
  } catch (err) {
    logger.error('closeInteraction: unexpected', err)
    return { error: 'An unexpected error occurred' }
  }
}

// ── deleteInteraction (prof) ─────────────────────────────────────────
// Draft-only: a prof prepping polls/quizzes (pre-class or mid-class) can
// discard one they haven't launched. Open/closed interactions are never
// deletable here — they carry student responses and session history; the
// prof closes those instead.

export async function deleteInteraction(
  input: DeleteInteractionInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = deleteInteractionSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const interaction = await loadInteraction(adminDb, parsed.data.interactionId)
    if (!interaction) return { error: 'Interaction not found' }

    const room = await loadRoom(adminDb, interaction.room_id)
    if (!room || room.prof_id !== user.id) return { error: 'Forbidden' }
    if (interaction.status !== 'draft') {
      return { error: 'Only unlaunched interactions can be deleted' }
    }

    // Draft-only guard also in the WHERE so a concurrent open+delete can't
    // race a launched interaction out from under its responses.
    const { error, count } = await adminDb
      .from('lc_interactions')
      .delete({ count: 'exact' })
      .eq('id', parsed.data.interactionId)
      .eq('status', 'draft')

    if (error) {
      logger.error('deleteInteraction: delete failed', error, { interactionId: parsed.data.interactionId })
      return { error: 'Failed to delete interaction' }
    }
    if (count === 0) {
      // Someone opened it between our read and delete — leave it alone.
      return { error: 'This interaction is already live' }
    }

    logEvent({
      userId: user.id,
      eventType: `lc_interaction.${interaction.kind}.deleted`,
      eventCategory: 'professor',
      metadata: { roomId: interaction.room_id, interactionId: parsed.data.interactionId },
      sectionId: room.section_id,
    })

    revalidatePath(`/professor/courses/${room.section_id}/live-classroom`)
    return { success: true }
  } catch (err) {
    logger.error('deleteInteraction: unexpected', err)
    return { error: 'An unexpected error occurred' }
  }
}

// ── listPreparedInteractions (prof) ──────────────────────────────────
// The draft polls/quizzes queued for a room — powers the pre-class prep
// list (and survives a mid-setup reload). Prof-only; students never read
// drafts. Read-only, so no logEvent.

export interface PreparedInteraction {
  id: string
  kind: 'poll' | 'quiz'
  payload: Record<string, unknown>
  created_at: string
}

export async function listPreparedInteractions(
  input: ListPreparedInteractionsInput,
): Promise<{ interactions?: PreparedInteraction[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = listPreparedInteractionsSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const room = await loadRoom(adminDb, parsed.data.roomId)
    if (!room || room.prof_id !== user.id) return { error: 'Forbidden' }

    const { data, error } = await adminDb
      .from('lc_interactions')
      .select('id, kind, payload, created_at')
      .eq('room_id', parsed.data.roomId)
      .eq('status', 'draft')
      .in('kind', ['poll', 'quiz'])
      .order('created_at', { ascending: true })

    if (error) {
      logger.error('listPreparedInteractions: query failed', error, { roomId: parsed.data.roomId })
      return { error: 'Failed to load prepared interactions' }
    }

    return { interactions: (data ?? []) as PreparedInteraction[] }
  } catch (err) {
    logger.error('listPreparedInteractions: unexpected', err)
    return { error: 'An unexpected error occurred' }
  }
}

// ── listReusableInteractions (prof) ──────────────────────────────────
// Polls/quizzes this section has ALREADY launched, newest first, reduced to
// exactly the fields the composer needs to prefill itself. Re-asking the same
// question (after discussion, or in a later class) is the whole point, so the
// list spans every room of the section — but only rooms this professor owns.
// Drafts are excluded: those are still queued, not "previously asked".
//
// Prof-only, because a quiz draft carries its answer key. Read-only, no logEvent.

/** A past poll/quiz reduced to composer-fillable fields. */
export interface ReusableInteraction {
  id: string
  kind: 'poll' | 'quiz'
  /** When it was launched — the list's secondary line. */
  createdAt: string
  question: string
  choices: string[]
  /** Index into `choices` of the correct answer. null for polls. */
  correctIndex: number | null
  explanation: string | null
  timeLimitSeconds: number | null
  revealAnswers: boolean | null
  skillIds: string[]
}

/** Max past interactions offered for reuse — one screen's worth, newest first. */
const REUSABLE_LIMIT = 30
/** The composer caps choices at 6; never hand it a form it can't render. */
const MAX_COMPOSER_CHOICES = 6

interface StoredQuizQuestion {
  prompt?: unknown
  choices?: Array<{ id?: unknown; text?: unknown }>
  correctChoiceId?: unknown
  explanation?: unknown
  skillIds?: unknown
}

/** Map a stored payload onto the composer's fields. Returns null when the
 *  composer cannot faithfully reproduce it (see the multi-question note). */
function toReusable(
  row: { id: string; kind: 'poll' | 'quiz'; payload: Record<string, unknown>; created_at: string },
): ReusableInteraction | null {
  const base = { id: row.id, kind: row.kind, createdAt: row.created_at }

  if (row.kind === 'poll') {
    const question = typeof row.payload.question === 'string' ? row.payload.question : ''
    const choices = (Array.isArray(row.payload.choices) ? row.payload.choices : [])
      .map((c) => String((c as { text?: unknown })?.text ?? ''))
      .filter((t) => t.length > 0)
      .slice(0, MAX_COMPOSER_CHOICES)
    if (!question || choices.length < 2) return null
    return {
      ...base,
      question,
      choices,
      correctIndex: null,
      explanation: null,
      timeLimitSeconds: null,
      revealAnswers: null,
      skillIds: [],
    }
  }

  const questions = (Array.isArray(row.payload.questions) ? row.payload.questions : []) as StoredQuizQuestion[]
  // The composer authors exactly ONE question, so a multi-question quiz (every
  // AI-generated one) can't be prefilled without silently dropping 2..N.
  // Leave those out of the list instead of half-reusing them.
  if (questions.length !== 1) return null
  const q = questions[0]
  const prompt = typeof q.prompt === 'string' ? q.prompt : ''
  const rawChoices = (Array.isArray(q.choices) ? q.choices : [])
    .filter((c) => String(c?.text ?? '').length > 0)
    .slice(0, MAX_COMPOSER_CHOICES)
  if (!prompt || rawChoices.length < 2) return null
  const correctIndex = rawChoices.findIndex((c) => c.id === q.correctChoiceId)
  return {
    ...base,
    question: prompt,
    choices: rawChoices.map((c) => String(c.text ?? '')),
    // A trimmed-away correct answer falls back to the first choice, which the
    // prof re-marks in the composer before creating.
    correctIndex: correctIndex >= 0 ? correctIndex : 0,
    explanation: typeof q.explanation === 'string' ? q.explanation : null,
    timeLimitSeconds: typeof row.payload.timeLimitSeconds === 'number' ? row.payload.timeLimitSeconds : null,
    revealAnswers: row.payload.revealAnswers === true,
    skillIds: (Array.isArray(q.skillIds) ? q.skillIds : []).filter((s): s is string => typeof s === 'string'),
  }
}

export async function listReusableInteractions(
  input: ListReusableInteractionsInput,
): Promise<{ interactions?: ReusableInteraction[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = listReusableInteractionsSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const room = await loadRoom(adminDb, parsed.data.roomId)
    if (!room || room.prof_id !== user.id) return { error: 'Forbidden' }

    const { data: rooms, error: roomsError } = await adminDb
      .from('lc_rooms')
      .select('id')
      .eq('section_id', room.section_id)
      .eq('prof_id', user.id)

    if (roomsError) {
      logger.error('listReusableInteractions: rooms query failed', roomsError, { roomId: parsed.data.roomId })
      return { error: 'Failed to load past polls and quizzes' }
    }

    const roomIds = ((rooms ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (roomIds.length === 0) return { interactions: [] }

    const { data, error } = await adminDb
      .from('lc_interactions')
      .select('id, kind, payload, created_at')
      .in('room_id', roomIds)
      .in('kind', ['poll', 'quiz'])
      .in('status', ['open', 'closed'])
      .order('created_at', { ascending: false })
      .limit(REUSABLE_LIMIT)

    if (error) {
      logger.error('listReusableInteractions: query failed', error, { roomId: parsed.data.roomId })
      return { error: 'Failed to load past polls and quizzes' }
    }

    const rows = (data ?? []) as Array<{
      id: string
      kind: 'poll' | 'quiz'
      payload: Record<string, unknown>
      created_at: string
    }>
    return {
      interactions: rows
        .map(toReusable)
        .filter((i): i is ReusableInteraction => i !== null),
    }
  } catch (err) {
    logger.error('listReusableInteractions: unexpected', err)
    return { error: 'An unexpected error occurred' }
  }
}

// ── submitResponse (student) ─────────────────────────────────────────

export async function submitResponse(
  input: SubmitResponseInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = submitResponseSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const interaction = await loadInteraction(adminDb, parsed.data.interactionId)
    if (!interaction) return { error: 'Interaction not found' }
    if (interaction.status !== 'open') return { error: 'Interaction is not open' }

    const room = await loadRoom(adminDb, interaction.room_id)
    if (!room) return { error: 'Room not found' }

    const enrolled = await isEnrolled(adminDb, room.section_id, user.id)
    if (!enrolled) return { error: 'You are not enrolled in this section' }

    // Ring 2: a poll response becomes live_quiz mastery evidence, so a revoked
    // institution must stop producing them. askQuestion below is deliberately
    // left open, being engagement rather than scored evidence.
    const entitlement = await checkEntitlementBySection(adminDb, room.section_id, 'live-classroom')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('live-classroom') }

    const { error } = await adminDb
      .from('lc_responses')
      .upsert(
        {
          interaction_id: parsed.data.interactionId,
          student_id: user.id,
          response: parsed.data.response,
        },
        { onConflict: 'interaction_id,student_id' },
      )

    if (error) {
      logger.error('submitResponse: upsert failed', error, { interactionId: parsed.data.interactionId })
      return { error: 'Failed to submit response' }
    }

    return { success: true }
  } catch (err) {
    logger.error('submitResponse: unexpected', err)
    return { error: 'An unexpected error occurred' }
  }
}

// ── askQuestion (student) ────────────────────────────────────────────

export async function askQuestion(
  input: AskQuestionInput,
): Promise<{ interactionId?: string; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = askQuestionSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const room = await loadRoom(adminDb, parsed.data.roomId)
    if (!room) return { error: 'Room not found' }

    const enrolled = await isEnrolled(adminDb, room.section_id, user.id)
    if (!enrolled) return { error: 'You are not enrolled in this section' }
    if (room.status !== 'live') return { error: 'Room has ended' }

    // Resolve a display name for non-anonymous questions so the UI can show
    // "asked by Jane Patel" without an extra round-trip per render. For
    // anonymous questions we deliberately store nothing — even leaking the
    // name into the JSONB payload would be a privacy regression.
    let authorName: string | null = null
    if (!parsed.data.anonymous) {
      const { data: profile } = await adminDb
        .from('profiles')
        .select('name, email')
        .eq('id', user.id)
        .maybeSingle()
      authorName = (profile?.name as string | undefined)
        || (profile?.email as string | undefined)
        || 'A student'
    }

    const { data: created, error } = await adminDb
      .from('lc_interactions')
      .insert({
        room_id: parsed.data.roomId,
        kind: 'question',
        status: 'open',
        opened_at: new Date().toISOString(),
        created_by: user.id,
        payload: {
          text: parsed.data.text,
          anonymous: parsed.data.anonymous,
          authorName, // null when anonymous
          upvotes: 0,
          upvotedBy: [],
          answered: false,
          answeredBy: null,
        },
      })
      .select('id')
      .single()

    if (error || !created) {
      logger.error('askQuestion: insert failed', error, { roomId: parsed.data.roomId })
      return { error: 'Failed to ask question' }
    }

    return { interactionId: created.id }
  } catch (err) {
    logger.error('askQuestion: unexpected', err)
    return { error: 'An unexpected error occurred' }
  }
}

// ── upvoteQuestion (student) ─────────────────────────────────────────

export async function upvoteQuestion(
  input: UpvoteQuestionInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = upvoteQuestionSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const interaction = await loadInteraction(adminDb, parsed.data.interactionId)
    if (!interaction) return { error: 'Interaction not found' }
    if (interaction.kind !== 'question') return { error: 'Only questions can be upvoted' }

    const room = await loadRoom(adminDb, interaction.room_id)
    if (!room) return { error: 'Room not found' }

    const enrolled = await isEnrolled(adminDb, room.section_id, user.id)
    if (!enrolled && room.prof_id !== user.id) {
      return { error: 'You are not enrolled in this section' }
    }

    /* Atomic RPC — FOR UPDATE serializes concurrent upvotes and the
       already-upvoted check happens inside the transaction, which is why two
       simultaneous upvotes land on exactly 2.

       Still calling lc_toggle_upvote, which is now a documented shim delegating to
       lc_add_upvote. The rename (#642) is real — the function never toggled and the
       UI never offered an un-vote — but supabase/types.ts is generated, so this call
       site moves to the new name once the migration is applied and types are
       regenerated. Switching it before then would not typecheck. */
    const { data: updatedPayload, error } = await adminDb.rpc('lc_toggle_upvote', {
      p_interaction_id: parsed.data.interactionId,
      p_user_id: user.id,
    })

    if (error) {
      logger.error('upvoteQuestion: rpc failed', error, { interactionId: parsed.data.interactionId })
      return { error: 'Failed to upvote' }
    }

    if (updatedPayload === null) {
      return { error: 'Interaction not found' }
    }

    return { success: true }
  } catch (err) {
    logger.error('upvoteQuestion: unexpected', err)
    return { error: 'An unexpected error occurred' }
  }
}

// ── markQuestionAnswered (prof) ──────────────────────────────────────

export async function markQuestionAnswered(
  input: MarkAnsweredInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = markAnsweredSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const interaction = await loadInteraction(adminDb, parsed.data.interactionId)
    if (!interaction) return { error: 'Interaction not found' }
    if (interaction.kind !== 'question') return { error: 'Not a question' }

    const room = await loadRoom(adminDb, interaction.room_id)
    if (!room || room.prof_id !== user.id) return { error: 'Forbidden' }

    const newPayload = {
      ...interaction.payload,
      answered: true,
      answeredBy: user.id,
    }

    const { error } = await adminDb
      .from('lc_interactions')
      .update({ payload: newPayload, status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', parsed.data.interactionId)

    if (error) {
      logger.error('markQuestionAnswered: update failed', error, { interactionId: parsed.data.interactionId })
      return { error: 'Failed to mark answered' }
    }

    return { success: true }
  } catch (err) {
    logger.error('markQuestionAnswered: unexpected', err)
    return { error: 'An unexpected error occurred' }
  }
}

// ── replyToQuestion (prof) ───────────────────────────────────────────
// A written answer to a student question — for the clarifications, links and
// values that aren't worth interrupting the lecture for. Stored on the
// question's own payload (one instructor answer per question; replying again
// overwrites it), which is what makes it reach students live: a payload-only
// UPDATE fires the trigger's `interaction_updated` branch, and that branch —
// unlike the status branch — carries the payload, so the Q&A hook merges the
// reply into every open client.
//
// A written answer also RESOLVES the question (`answered: true`), the same as
// answering it aloud and marking it — so it drops out of the open list and the
// session report counts it. Status is deliberately left alone: flipping it in
// the same UPDATE would take the status branch instead and the reply text
// would never be broadcast.

export async function replyToQuestion(
  input: ReplyToQuestionInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = replyToQuestionSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const interaction = await loadInteraction(adminDb, parsed.data.interactionId)
    if (!interaction) return { error: 'Interaction not found' }
    if (interaction.kind !== 'question') return { error: 'Not a question' }

    const room = await loadRoom(adminDb, interaction.room_id)
    if (!room || room.prof_id !== user.id) return { error: 'Forbidden' }

    // Students see who answered them. Resolved server-side (same as askQuestion)
    // so the name can't be spoofed by the caller.
    const { data: profile } = await adminDb
      .from('profiles')
      .select('name, email')
      .eq('id', user.id)
      .maybeSingle()
    const replyAuthorName = (profile?.name as string | undefined)
      || (profile?.email as string | undefined)
      || 'Instructor'

    const newPayload = {
      ...interaction.payload,
      reply: parsed.data.text,
      replyAuthorName,
      repliedAt: new Date().toISOString(),
      answered: true,
      answeredBy: user.id,
    }

    const { error } = await adminDb
      .from('lc_interactions')
      .update({ payload: newPayload })
      .eq('id', parsed.data.interactionId)

    if (error) {
      logger.error('replyToQuestion: update failed', error, { interactionId: parsed.data.interactionId })
      return { error: 'Failed to send reply' }
    }

    logEvent({
      userId: user.id,
      eventType: 'lc_interaction.question.replied',
      eventCategory: 'professor',
      metadata: { roomId: interaction.room_id, interactionId: parsed.data.interactionId },
      sectionId: room.section_id,
    })

    revalidatePath(`/professor/courses/${room.section_id}/live-classroom`)
    return { success: true }
  } catch (err) {
    logger.error('replyToQuestion: unexpected', err)
    return { error: 'An unexpected error occurred' }
  }
}
