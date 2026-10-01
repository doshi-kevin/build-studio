// The student Athena endpoint.
//
// This file is the GATE and the wiring, and deliberately little else: it
// authenticates the caller, verifies their enrollment and the section's feature
// toggle, refuses outright while a graded attempt is live (G8), reserves a slot
// against the daily cap, and then hands the turn to athena-core.
//
// The machinery it used to hold now lives where a second surface can reuse it
// (docs/designs/athena-students.md §2): the streaming loop and the run channel in
// `athena-core/stream.ts`, the metered + persisted model call in
// `athena-core/turn.ts`, prompt assembly and its retrieval/state lanes in
// `student-tutor/context.ts`. What stays here is what is genuinely
// route-shaped — the checks that must answer with an HTTP status BEFORE any
// stream opens, because once the body is open the only channel left is the body.

import { createClient } from '@/lib/supabase/server'
import { checkEntitlement } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { convertToModelMessages, type UIMessage } from 'ai'
import { ATHENA_NOTICE_PREFIX } from '@/lib/ai/config'
import { type StoredAttachment } from '@/lib/ai/conversation-utils'
import { resolveJoin } from '@/lib/supabase/resolve-join'
import { studentToolsFor } from '@/lib/ai/student-tutor/tools'
import { athenaAttachmentPrefix, STUDENT_ATTACHMENTS } from '@/lib/ai/athena-attachments'
import {
  asFilePart,
  athenaPathOf,
  filePartName,
  materializeFileParts,
  pathInScope,
} from '@/lib/ai/athena-attachments-server'
import { buildStudentTools, createDirectiveChannel } from '@/lib/ai/student-tutor/contract'
import { buildStudentTurnContext } from '@/lib/ai/student-tutor/context'
import { findLiveQuizAttempt } from '@/lib/quiz/active-attempt'
import { buildNodeDirective, buildProposeDirective } from '@/lib/ai/athena-directive'
import { reserveStudentSlot } from '@/lib/ai/athena-core/rate-limit'
import { studentModelDef } from '@/lib/ai/athena-core/models'
import { createRunChannel, streamAthenaResponse } from '@/lib/ai/athena-core/stream'
import { streamAthenaAnswer } from '@/lib/ai/athena-core/turn'
import { findStudentConversation, recordUserTurn } from '@/lib/ai/athena-core/persistence'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'

export const maxDuration = 60

// Bounded tool loop: one step to call a read-only lookup tool, one to answer
// from it (+ headroom). Read-only tools can't run away, but cap it anyway.
const MAX_TUTOR_STEPS = 4

// How many attached files are inlined into the prompt, newest first. An
// attachment is re-sent on EVERY later turn of a thread, so a student who
// attaches their limit early would otherwise pay for those bytes on every
// message for the rest of the conversation. Two turns' worth of files stays
// loaded; older ones are stood down with a note the model can act on.
const MAX_INLINED_ATTACHMENTS = STUDENT_ATTACHMENTS.maxFiles * 2

// ── Helpers ──────────────────────────────────────────────────────

async function verifyStudentEnrollment(
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

/** Extract text content from a UIMessage's parts array. */
function getUIMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/**
 * The attachments on a message that genuinely belong to this caller, as the
 * compact records we persist on `athena_messages.metadata`. Anything whose storage
 * path falls outside the caller's own prefix is dropped here and never reaches
 * storage or the model — see pathInScope for why that guard exists.
 */
function inScopeAttachments(message: UIMessage, allowedPrefix: string): StoredAttachment[] {
  return message.parts.flatMap((p) => {
    const fp = asFilePart(p)
    if (!fp) return []
    const path = athenaPathOf(fp)
    if (!pathInScope(path, allowedPrefix)) return []
    return [{
      path,
      filename: filePartName(fp),
      mediaType: typeof fp.mediaType === 'string' ? fp.mediaType : 'application/octet-stream',
    }]
  })
}

// ── Route Handler ────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const { messages, sectionId, conversationId, driveMode: rawDriveMode } = await req.json()
    /* Athena's one autonomy axis, chosen by the student in the dock. Gates
       which tools this turn exposes (copilot may leave artifacts / drive the
       app); an absent or tampered value falls back to the default. */
    const driveMode: 'copilot' | 'chat' = rawDriveMode === 'chat' ? 'chat' : 'copilot'

    if (!sectionId || typeof sectionId !== 'string') {
      return new Response('Missing sectionId', { status: 400 })
    }

    // Authenticate
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return new Response('Unauthorized', { status: 401 })
    }
    /* Captured non-null so the narrowing above survives into the closures below,
       which TypeScript cannot know still hold by the time they run. */
    const authedUser = user

    // Verify enrollment
    const { enrolled, adminDb } = await verifyStudentEnrollment(sectionId, user.id)
    if (!enrolled) {
      return new Response('Not enrolled in this section', { status: 403 })
    }

    // ── Quiz lockdown (G8) ───────────────────────────────────────
    // Before anything else is fetched or built: no retrieval, no tools, no model
    // call while a graded attempt is live. Deliberately a gate and not a prompt
    // instruction — prose is persuasion-resistant only by wording, and the model
    // answers a course question from its own knowledge even on an empty context.
    // The check spans every course (see findLiveQuizAttempt): scoping it to this
    // section would make a second enrolled course a one-tab bypass.
    let liveAttempt
    try {
      liveAttempt = await findLiveQuizAttempt(adminDb, user.id)
    } catch (err) {
      // Fail CLOSED. A guardrail that opens when its own read fails isn't one.
      logger.error('POST /api/chat: quiz-lock check failed — refusing', err, {
        source: 'api.chat.POST',
        sectionId,
        userId: user.id,
      })
      return new Response(
        `${ATHENA_NOTICE_PREFIX}Athena can't start right now. Please try again in a moment.`,
        { status: 503 },
      )
    }
    if (liveAttempt) {
      logger.info('POST /api/chat: locked — quiz attempt in progress', {
        source: 'api.chat.POST',
        sectionId,
        userId: user.id,
      })
      return new Response(
        `${ATHENA_NOTICE_PREFIX}Athena is paused while your quiz "${liveAttempt.quizTitle}" is in progress. Submit it and I'll be right here.`,
        { status: 423 },
      )
    }

    // Section metadata (incl. institution_id, needed to derive the vector namespace).
    const { data: section } = await adminDb
      .from('course_sections')
      .select('institution_id, section_code, settings, course:courses(code, title)')
      .eq('id', sectionId)
      .single()
    if (!section) {
      return new Response('Course section not found', { status: 404 })
    }

    // Server-side feature gate. Athena is ambient (⌘J on every course page), so
    // the client-side `enabled` prop on the dock is not the only reach: a
    // professor who turns the tutor off for their section must have it off here
    // too, not just hidden in the UI. `enabledFeatures` is what students may
    // reach — the section master switch a professor turns off.
    const enabledFeatures = (section.settings as { enabledFeatures?: unknown } | null)?.enabledFeatures
    if (!Array.isArray(enabledFeatures) || !enabledFeatures.includes('athena')) {
      return new Response('Athena is turned off for this course', { status: 403 })
    }

    // Institution/platform AI kill switch — checked before any slot is reserved
    // or token spent. Fail-closed: a policy-read error refuses too.
    const aiVerdict = await checkAiFeature(adminDb, section.institution_id, 'athena-student')
    if (!aiVerdict.allowed) {
      return new Response(aiRefusalMessage(aiVerdict.lockedBy), { status: 403 })
    }

    /* Entitlement is a SEPARATE question from the kill switch above, and both
       must pass. The kill switch answers "is AI safe to run right now"; this
       answers "did this school buy Athena at all". They fail in opposite
       directions on a read error by design, so they are checked separately and
       never share a code path. */
    const entitlement = await checkEntitlement(adminDb, section.institution_id, 'athena')
    if (!entitlement.allowed) {
      return new Response(entitlementRefusalMessage('athena'), { status: 403 })
    }

    /* Per-student daily cap (F1, §10). Its own pool in the shared counter table
       at the STUDENT cap (100/day, athena-core/models.ts) — draws down no other
       surface, and no longer borrows the professor's 150. No failover: the
       fallback is Pro, dearer and ~6x slower, and spending it on an over-cap
       student is the exact cost tail this bounds. Fails OPEN on an
       infrastructure error, so a counter glitch can't take Athena down
       mid-term. */
    const slot = await reserveStudentSlot(adminDb, {
      institutionId: section.institution_id,
      userId: user.id,
    })
    if (!slot.accepted) {
      /* Tagged as a notice, like the quiz lock above: ErrorRow then shows this
         sentence with no Retry. A hit cap is not a crash, and retrying cannot
         succeed until the window rolls. */
      return new Response(
        `${ATHENA_NOTICE_PREFIX}You've reached today's limit for Athena. It resets automatically — and your professor can always help in the meantime.`,
        { status: 429 },
      )
    }

    const course = resolveJoin(section.course)
    const header = {
      courseTitle: course?.title || 'Unknown Course',
      courseCode: course?.code || '',
      sectionCode: section.section_code || '',
    }

    // Attachment paths must live under this exact prefix — set at upload time
    // from the verified section + THIS student. Rebuilt here so a path forged by
    // the client (another tenant's, another student's) is never downloaded with
    // the admin client or written to the thread.
    const attachmentPrefix = athenaAttachmentPrefix({
      institutionId: section.institution_id,
      sectionId,
      scopeId: user.id,
    })

    // Retrieval query = the latest user message.
    const lastUser = Array.isArray(messages)
      ? [...messages].reverse().find((m: UIMessage) => m.role === 'user')
      : undefined
    const queryText = lastUser ? getUIMessageText(lastUser as UIMessage) : ''
    const attachments = lastUser ? inScopeAttachments(lastUser as UIMessage, attachmentPrefix) : []
    const hasAttachments = attachments.length > 0
    // Only a turn the student just sent is persisted — if the client's last
    // message isn't theirs, this request is a replay of an answered turn and
    // writing it again would duplicate the row.
    const isNewUserTurn =
      Array.isArray(messages) && messages[messages.length - 1]?.role === 'user'

    // Ownership is settled HERE, while a status code is still possible.
    // Section-scoped too: this id flows into the tool context and is persisted on
    // athena_artifacts.conversation_id, so a thread from another course must not
    // be attachable to this section's turn.
    if (conversationId) {
      const convo = await findStudentConversation(adminDb, {
        conversationId,
        userId: user.id,
        sectionId,
      })
      if (!convo) {
        return new Response('Conversation not found', { status: 403 })
      }
    }

    // The app-driving channel (§13.3) and the run channel, both hoisted above the
    // tools that write into them and the stream that reads them.
    const directives = createDirectiveChannel()
    const run = createRunChannel()
    const model = studentModelDef()

    return streamAthenaResponse({
      run,
      source: 'api.chat.POST',
      context: { sectionId },
      // Runs INSIDE the response stream, so each lookup's row appears the moment
      // it starts rather than arriving pre-ticked.
      prepare: async () => {
        const { systemPrompt, citablePages } = await buildStudentTurnContext({
          adminDb,
          institutionId: section.institution_id,
          sectionId,
          userId: authedUser.id,
          header,
          query: queryText,
          hasAttachments,
          canLeaveArtifacts: driveMode === 'copilot',
          run,
        })

        // Persist the student's own turn. A file with no question is a real turn
        // ("what's wrong with this?"), so attachments alone are enough.
        if (conversationId && isNewUserTurn && (queryText || hasAttachments)) {
          await recordUserTurn(adminDb, {
            conversationId,
            institutionId: section.institution_id,
            sectionId,
            userId: authedUser.id,
            content: queryText,
            // Storage paths, never the signed URLs — those expire in an hour.
            ...(hasAttachments ? { metadata: { attachments } } : {}),
            fallbackTitle: attachments[0]?.filename,
          })
        }

        // Attachment bytes are inlined first — downloaded server-side with the
        // admin client from paths bound to this student, never fetched from the
        // URL the client sent.
        const modelMessages = await convertToModelMessages(
          await materializeFileParts(adminDb, messages as UIMessage[], attachmentPrefix, MAX_INLINED_ATTACHMENTS),
        )

        return streamAthenaAnswer({
          model: model.model,
          system: systemPrompt,
          messages: modelMessages,
          // Read-only lookup tools (the student's own quiz performance, etc.),
          // all scoped server-side to this student; the model calls them only
          // when a question needs the numbers.
          tools: buildStudentTools(
            {
              adminDb,
              sectionId,
              userId: authedUser.id,
              institutionId: section.institution_id,
              conversationId: conversationId ?? null,
              citablePages,
              emit: directives.emit,
            },
            studentToolsFor(driveMode),
            (event) => run.record(event),
          ),
          maxSteps: MAX_TUTOR_STEPS,
          temperature: 0.7,
          maxOutputTokens: 4096,
          meter: { sectionId, userId: authedUser.id },
          persist: {
            adminDb,
            conversationId: conversationId ?? null,
            institutionId: section.institution_id,
            sectionId,
            userId: authedUser.id,
            run: () => run.log,
          },
        })
      },
      /* The directive is appended AFTER the answer, so it is never part of what
         the model wrote or of what gets persisted — reopening a thread must not
         re-navigate. Everything in it is chosen server-side from the typed route
         registry; see athena-directive.ts. */
      tail: () => {
        const directive = directives.resolve()
        if (directive?.type === 'goto_node') return buildNodeDirective(directive.nodeKey)
        if (directive?.type === 'goto_page') {
          return buildProposeDirective({
            route: directive.route,
            label: directive.label,
            said: directive.said,
            ...(directive.prefill ? { prefill: directive.prefill } : {}),
          })
        }
        return ''
      },
    })
  } catch (err) {
    logger.error('POST /api/chat: Exception', err)
    return new Response('Internal server error', { status: 500 })
  }
}
