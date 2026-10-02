/**
 * Assignment-scoped Athena — streaming chat endpoint.
 *
 * A DISTINCT, leaner sibling of /api/professor-assistant: same hardened auth +
 * rate-limit + cost-ledger backbone, but its tools FILL the on-screen form (and
 * read class context) rather than proposing separate draft records. Two SURFACES —
 * 'authoring' (generic across every template kind, via the template registry) and
 * 'grade' — and it exposes only the tools that surface declares.
 *
 * The panel's paperclip is a CHAT attachment on every kind and both surfaces: the
 * file uploads through the console's hardened /api/professor-assistant/upload
 * route into a conversation-scoped prefix, and this route inlines its bytes for
 * the model behind the same IDOR guard the console and the student dock use.
 * Gemini reads PDFs and images natively, so nothing is extracted on our side.
 *
 * This used to be gated to the 'about' kind alone, and the paperclip on every
 * other kind uploaded a student-facing file the assistant could not read (#652).
 * Professors read a paperclip on an AI composer as "it will read this", so that
 * split was the source of the standing "Athena can't see what I uploaded" report.
 * Student-facing files now live only where they are discoverable as such, in the
 * builder's own "Add files & rubrics" step.
 *
 * Orthogonal to surface is MODE ('standard' | 'frontier'). Frontier is the
 * assignment-DESIGN arc; it applies only while authoring and only adds tools, never
 * removes them. Kept a separate axis on purpose — see the comment at activeMode.
 *
 * Persistence: every turn is saved to athena_conversations/athena_messages
 * (surface='studio') so the panel's resume dropdown can list and reload past
 * threads — see src/lib/ai/assignment-assistant/persistence.ts. A thread is
 * scoped by (studio_surface, studio_kind, assignment_id | quiz_id), mirroring the
 * client's in-memory panelKey exactly, so a chat about one assignment never
 * resurfaces under a different one.
 *
 * Security: assume this is called unauthenticated by an attacker with arbitrary
 * args. We getUser → verifySectionAccess → canWriteAsStaff before streaming. FILL
 * tools never mutate (the professor commits via the existing server actions);
 * summarize_submission re-verifies the selected submission belongs to THIS
 * verified section/tenant, fail-closed. institution_id/section context always
 * come from the verified server side, never from client input.
 */

import { streamText, convertToModelMessages, stepCountIs, smoothStream, type UIMessage } from 'ai'
import { checkEntitlement } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { after } from 'next/server'
import { google } from '@ai-sdk/google'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess, canWriteAsStaff, canWriteAsProfessor } from '@/lib/auth/section-access'
import { athenaAttachmentPrefix } from '@/lib/ai/athena-attachments'
import { asFilePart, materializeFileParts, filePartsToPaths } from '@/lib/ai/athena-attachments-server'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { resolveAthenaModelDef } from '@/lib/ai/professor-assistant/models'
import { reserveAthenaSlot } from '@/lib/ai/professor-assistant/rate-limit'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { recordAiUsage } from '@/lib/ai/usage'
import { recordExternalUsage } from '@/lib/costs/external-usage'
import { countGroundingQueries } from '@/lib/ai/grounding'
import { loadAssistantContext } from '@/lib/ai/professor-assistant/context'
import { buildAssignmentAssistantSystemPrompt } from '@/lib/ai/assignment-assistant/prompts'
import { buildAssignmentAssistantTools } from '@/lib/ai/assignment-assistant/tools'
import { IDEMPOTENT_CONTEXT_TOOL_NAMES } from '@/lib/ai/assignment-assistant/tool-names'
import { loadGradeContext, resolveAthenaLimitScope } from '@/lib/ai/assignment-assistant/context'
import {
  assignmentScreenSchema,
  ASSIGNMENT_ASSISTANT_SURFACES,
  ASSIGNMENT_ASSISTANT_MODES,
  DEFAULT_ASSIGNMENT_ASSISTANT_MODE,
  resolveStudioConversationScope,
  type AssignmentAssistantMode,
  type AssignmentAssistantSurface,
} from '@/lib/ai/assignment-assistant/schemas'
import {
  persistUserMessage,
  persistAssistantMessage,
  maybeAutoTitle,
  type StudioPersistCtx,
} from '@/lib/ai/assignment-assistant/persistence'

export const maxDuration = 60

// The conversation id (body.id) reaches both a storage path (the About
// attachment scopeId) and the athena_conversations primary key. Confine it to a
// UUID so no traversal/separator char can enter the storage prefix, and so it is
// always a well-formed id to persist.
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Concatenated text of a message's text parts (for the deterministic auto-title). */
function messageText(message: UIMessage | undefined): string {
  if (!message) return ''
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

// Only the most recent slice of the thread is sent to the model — caps per-turn
// input cost on a long chat. Whole messages only (a tool call + its result live
// in one message), so this never orphans a call from its result.
const MAX_HISTORY_MESSAGES = 30

// Agent loop budget: lets Athena chain a read (get_class_struggles /
// summarize_submission / google_search) into a fill before finishing. Fill tools
// have no execute so they pause the loop and can't run it away. 6 covers the
// longest real chain on the quiz surface — search, re-search on thin results,
// list_modules, generate_questions — matching the console's budget.
const MAX_AGENT_STEPS = 6

/**
 * Drop the idempotent context tools whose output already appears in this turn's history.
 *
 * "This turn" = since the last user message, so a professor's next question can re-read
 * genuinely fresh class data. Only the zero-argument, memoised reads qualify: a tool that
 * takes arguments can legitimately be called again with different ones.
 */
function withheldIdempotentContextTools<T extends Record<string, unknown>>(
  tools: T,
  history: UIMessage[],
): T {
  const lastUserIndex = history.map((m) => m.role).lastIndexOf('user')
  const thisTurn = lastUserIndex === -1 ? history : history.slice(lastUserIndex)

  const alreadyRead = new Set<string>()
  for (const message of thisTurn) {
    for (const part of message.parts ?? []) {
      const type = (part as { type?: unknown }).type
      const state = (part as { state?: unknown }).state
      if (typeof type !== 'string' || !type.startsWith('tool-')) continue
      if (state !== 'output-available') continue
      const name = type.slice('tool-'.length)
      if ((IDEMPOTENT_CONTEXT_TOOL_NAMES as readonly string[]).includes(name)) {
        alreadyRead.add(name)
      }
    }
  }
  if (alreadyRead.size === 0) return tools

  const next = { ...tools }
  for (const name of alreadyRead) delete next[name]
  logger.info('assignment-assistant: withholding already-read context tools', {
    withheld: [...alreadyRead],
  })
  return next
}

/**
 * Drop UNRESOLVED tool parts (a fill the client never resolved before the
 * professor sent a follow-up). An orphan tool call makes the provider reject the
 * request (AI_MissingToolResultsError). Fills normally resolve instantly on the
 * client (auto-apply → addToolResult), so this is a rare-edge safeguard; we
 * simply drop the orphan and any now-empty assistant message.
 */
function stripUnresolvedToolParts(messages: UIMessage[]): UIMessage[] {
  return messages
    .map((m) => {
      if (m.role !== 'assistant') return m
      const parts = m.parts.filter((p) => {
        const pp = p as { type?: unknown; state?: string }
        const isTool = typeof pp.type === 'string' && pp.type.startsWith('tool-')
        if (!isTool) return true
        return pp.state === 'output-available' || pp.state === 'output-error'
      })
      return { ...m, parts }
    })
    .filter((m) => m.role !== 'assistant' || m.parts.length > 0)
}

export async function POST(req: Request) {
  let body: {
    messages?: UIMessage[]
    sectionId?: string
    surface?: string
    screen?: unknown
    changes?: unknown
    assignmentId?: string
    timeZone?: string
    modelId?: string
    mode?: string
    /** The panel's STATIC transport body carries the template kind. The screen
     *  rides only the per-message body, so an auto-sent follow-up (fill →
     *  acknowledge) arrives with NO screen — without this fallback those turns
     *  lose the kind entirely: wrong prompt, wrong tool set, wrong rate-limit
     *  pool and a mislabeled ledger row (observed in QA: about turns charged to
     *  the assignment pool as assignment_assistant). */
    kind?: string
    /** DefaultChatTransport forwards the useChat id — the panel's per-mount
     *  conversation id. Doubles as the About kind's attachment path scopeId and,
     *  now, the athena_conversations primary key every turn persists under. */
    id?: string
  }
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid request body', { status: 400 })
  }

  const { messages, sectionId, surface, assignmentId, timeZone, modelId, mode, id: conversationId } = body
  if (!sectionId || !Array.isArray(messages)) {
    return new Response('Missing sectionId or messages', { status: 400 })
  }
  if (!conversationId || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    return new Response('Missing or invalid conversation id', { status: 400 })
  }
  if (!surface || !ASSIGNMENT_ASSISTANT_SURFACES.includes(surface as AssignmentAssistantSurface)) {
    return new Response('Missing or invalid surface', { status: 400 })
  }
  const activeSurface = surface as AssignmentAssistantSurface

  // 1. Authenticate
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) return new Response('Unauthorized', { status: 401 })

  // 2. Authorize — section staff who can write (professor or TA)
  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return new Response('Forbidden', { status: 403 })
  }

  // 3. Validate the untrusted screen payload (context only; authorizes nothing).
  const screenParsed = assignmentScreenSchema.safeParse(body.screen)
  const screen = screenParsed.success ? screenParsed.data : undefined
  // The compact change-list the client computed (professor's manual edits / Undo since
  // Athena last acted). Untrusted context only — bounded + string-only, shapes the prompt.
  const changes = Array.isArray(body.changes)
    ? body.changes.filter((c): c is string => typeof c === 'string').slice(0, 30).map((c) => c.slice(0, 200))
    : []
  const selectedSubmissionId = activeSurface === 'grade' ? screen?.grade?.submissionId : undefined

  // Authoring surface: which template the professor is editing (drives apply_edits' op
  // schema via the registry, and which tools the surface exposes). Client-supplied
  // context only — it shapes the tool schema/prompt, never authorizes anything (the
  // write path is the editor's own Save, independently authorized). The screen's
  // kind wins; the static body's kind covers auto-sent turns that carry no screen.
  const activeKind =
    activeSurface === 'authoring'
      ? (screen?.authoring?.kind ?? (typeof body.kind === 'string' ? body.kind : undefined))
      : undefined

  // The About page is instructor-owned: its editor is professor-only and its save
  // action (saveAboutContent) rejects everyone else, so the chat that drives it is
  // owner-only too — a TA has no page to apply fills to. The ONE capability this
  // actually gates server-side is get_course_data; the fills remain client-applied
  // and independently authorized on save. Attachments used to sit behind this gate
  // too, and no longer do: every kind carries them, and a TA already had them on
  // the console, so this gate is not what keeps them out of anything. A TA lying
  // about the kind gets the assignment tool set instead, which they already have.
  if (activeKind === 'about' && !canWriteAsProfessor(access.role)) {
    return new Response('Forbidden', { status: 403 })
  }

  // Frontier is an ORTHOGONAL switch over the authoring surface, not a third surface —
  // buildSurfaceBlock falls through to authoring while the tool factory falls through to
  // grade, so a third surface value would pair the authoring prompt with grading tools.
  //
  // Unlike `surface` (which 400s), an absent or unknown mode DEFAULTS SILENTLY to
  // 'standard': it is purely additive, and a client that predates it must keep working.
  // Untrusted client input is fine here — mode selects a prompt block and ADDS two fill
  // tools that write nothing themselves, so it grants no capability this surface doesn't
  // already have, and the server actions behind those fills re-authorize independently.
  //
  // Coerced rather than rejected so a stale client can never break a live chat. Frontier
  // means nothing while GRADING (there is no design work beside a submission), but it applies
  // to every authoring template including quizzes — a quiz just skips the rubric step, since
  // it has no settings.rubric and no assignment-level point budget.
  const requestedMode = ASSIGNMENT_ASSISTANT_MODES.includes(mode as AssignmentAssistantMode)
    ? (mode as AssignmentAssistantMode)
    : DEFAULT_ASSIGNMENT_ASSISTANT_MODE
  // The About kind is excluded: Frontier is the assignment-DESIGN arc, and on a
  // page with no assignmentId its two save tools are withheld anyway — the model
  // would then print the private notes as chat prose (the known bad state).
  const activeMode: AssignmentAssistantMode =
    requestedMode === 'frontier' && activeSurface === 'authoring' && activeKind !== 'about'
      ? 'frontier'
      : DEFAULT_ASSIGNMENT_ASSISTANT_MODE

  // 4. Load course context (read-only) + the small grade-surface assignment
  //    context (instructions + rubric dimensions), then build the system prompt.
  const context = await loadAssistantContext(access.adminDb, sectionId, user.id)
  const gradeContext =
    activeSurface === 'grade' && assignmentId
      ? (await loadGradeContext(access.adminDb, sectionId, assignmentId)) ?? undefined
      : undefined
  const system = buildAssignmentAssistantSystemPrompt({
    context,
    surface: activeSurface,
    mode: activeMode,
    screen,
    changes: activeSurface === 'authoring' ? changes : [],
    gradeContext,
    timeZone: typeof timeZone === 'string' ? timeZone : undefined,
  })

  // 4b. Persistence scope — the SAME resolveStudioConversationScope the panel
  // uses to compute what the resume dropdown lists, so a saved thread's scope
  // can never drift between what gets written and what gets listed.
  const studioScope = resolveStudioConversationScope({
    surface: activeSurface,
    kind: activeKind,
    assignmentId: typeof assignmentId === 'string' ? assignmentId : undefined,
  })

  const persistCtx: StudioPersistCtx = {
    adminDb: access.adminDb,
    conversationId,
    sectionId,
    userId: user.id,
    institutionId: context.institutionId,
    ...studioScope,
    mode: activeMode,
  }

  // IDOR guard: verify the conversation belongs to THIS caller before writing to
  // it — verifySectionAccess only proves they can use this SECTION, not that
  // they own this conversationId. Without this, a TA could pass their own
  // sectionId + someone else's conversationId and inject a message into the
  // victim's history via the RLS-bypassing admin client (ensureConversation
  // no-ops on the id conflict, then the append still writes). A brand-new
  // conversation isn't in the DB yet — that's allowed (no row → no owner yet).
  // Same pattern the professor console route uses for its own conversationId.
  const { data: existingConvo, error: existingConvoError } = await access.adminDb
    .from('athena_conversations')
    // `surface` is part of the check, not decoration. Now that three surfaces share this
    // table, a caller passing the id of their OWN console or student thread would otherwise
    // append Studio turns into it: ensureConversation no-ops on the id conflict, so the row
    // keeps its original surface while the messages land anyway, silently corrupting a
    // thread from another surface. Same owner and same section, so not a tenancy breach —
    // still a write this route must refuse.
    .select('section_id, user_id, surface')
    .eq('id', conversationId)
    .maybeSingle()
  // Fail CLOSED. On a query error `existingConvo` is null, which the check below would
  // otherwise read as "brand-new conversation, no owner yet" and wave through — the one
  // gate in this route that must refuse when it cannot tell.
  if (existingConvoError) {
    logger.error('assignment-assistant: conversation ownership lookup failed', existingConvoError, {
      sectionId,
      conversationId,
    })
    return new Response('Could not verify this conversation', { status: 500 })
  }
  if (
    existingConvo &&
    (existingConvo.section_id !== sectionId ||
      existingConvo.user_id !== user.id ||
      existingConvo.surface !== 'studio')
  ) {
    return new Response('Forbidden', { status: 403 })
  }

  // 5. Per-model daily rate limit (atomic reserve + failover). Blocks with a
  //    structured 429 the client renders, never a silent 500.
  //
  //    The pool is per SURFACE, so authoring an assignment, authoring a quiz and
  //    grading each have their own budget and none can starve the others (nor the
  //    sidebar console). The scope is resolved server-side against what the subject
  //    actually IS, never from the client's claimed `kind` — see resolveAthenaLimitScope.
  // Institution/platform AI kill switch — before any slot is reserved or token
  // spent. Fail-closed; the client renders the message as a structured error.
  const aiVerdict = await checkAiFeature(access.adminDb, context.institutionId, 'athena-professor')
  if (!aiVerdict.allowed) {
    return Response.json(
      { error: 'ai_disabled', message: aiRefusalMessage(aiVerdict.lockedBy) },
      { status: 403 },
    )
  }

  // Entitlement is a SEPARATE question from the kill switch above. That asks
  // whether AI may run; this asks whether the school bought Athena at all.
  // Opposite failure directions by design, so never one shared call.
  const entitlement = await checkEntitlement(access.adminDb, context.institutionId, 'athena')
  if (!entitlement.allowed) {
    return Response.json(
      { error: 'not_entitled', message: entitlementRefusalMessage('athena') },
      { status: 403 },
    )
  }

  const limitScope = await resolveAthenaLimitScope(access.adminDb, {
    sectionId,
    surface: activeSurface,
    kind: activeKind,
    assignmentId: typeof assignmentId === 'string' ? assignmentId : undefined,
  })
  const requestedModel = resolveAthenaModelDef(modelId)
  const reservation = await reserveAthenaSlot(access.adminDb, {
    institutionId: context.institutionId,
    userId: user.id,
    scope: limitScope,
    preferredModelId: requestedModel.id,
  })
  if (!reservation.accepted) {
    return Response.json(
      {
        error: 'athena_rate_limited',
        message: "You've reached today's Athena usage limit. It refreshes automatically.",
        resets_at: reservation.resetsAt,
      },
      { status: 429 },
    )
  }
  const modelDef = reservation.modelDef

  // Persist the incoming user turn now that we know it isn't rate-limited —
  // never record a turn we're about to refuse. Awaited and fail-closed: if it
  // doesn't land, the client must not stream optimistically against a DB that
  // never recorded it (that would fragment the history on reload/resume).
  //
  // The stored copy is SANITISED first. `lastMessage.parts` is untrusted client JSON,
  // and a file part's `url` is an arbitrary string. A stored path is a durable
  // capability: `loadStudioConversation` re-mints a signed URL for whatever path it
  // finds, using the RLS-bypassing admin client. Persisting a forged path would hand
  // any staff user a signed URL for another institution's attachment on resume —
  // every ownership check still passes, because they authorise the THREAD, not the
  // PATH. So the prefix is rebuilt here from the VERIFIED institution and section
  // plus this conversation, and `filePartsToPaths` drops anything outside it.
  const attachmentPrefix = athenaAttachmentPrefix({
    institutionId: context.institutionId,
    sectionId,
    scopeId: conversationId,
  })

  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role === 'user') {
    try {
      await persistUserMessage(persistCtx, filePartsToPaths(lastMessage, attachmentPrefix))
    } catch (err) {
      logger.error('assignment-assistant: persist user message failed', err, { sectionId, conversationId })
      return new Response('Could not save your message', { status: 500 })
    }
  }

  let model
  switch (modelDef.provider) {
    case 'google':
    default:
      model = google(modelDef.model)
      break
  }

  const tools = {
    ...buildAssignmentAssistantTools({
      adminDb: access.adminDb,
      sectionId,
      institutionId: context.institutionId,
      userId: user.id,
      surface: activeSurface,
      mode: activeMode,
      kind: activeKind,
      assignmentId: typeof assignmentId === 'string' ? assignmentId : undefined,
      selectedSubmissionId,
    }),
    // Native Gemini Google Search grounding (read-only, executed server-side by
    // Google) — the same tool the console Athena ships. Lets Athena ground a
    // draft in a real fact/citation/standard instead of guessing or leaving a
    // [placeholder], and lets the grading surface check a factual claim in a
    // submission. Search results are UNTRUSTED text: the system prompt tells the
    // model to cite, not obey, them, and the no-write contract (every edit lands
    // on a canvas the professor reviews and saves themselves) caps the blast
    // radius. Attached in the route, not the per-surface factory, because it's a
    // provider tool rather than one of ours — Gemini-specific, so it rides the
    // provider check above.
    ...(modelDef.provider === 'google' ? { google_search: google.tools.googleSearch({}) } : {}),
  }

  // Attachments: every kind and both surfaces carry model-readable file parts.
  // Their bytes are inlined via the same conversation-scoped IDOR guard the
  // console uses — the prefix binds the verified institution + section, so a
  // forged path outside it is never downloaded. The cap keeps only the newest
  // few; an attachment is re-sent on every later turn of a thread, so without one
  // a handful of files becomes a permanent tax on every message that follows.
  let history = stripUnresolvedToolParts(messages.slice(-MAX_HISTORY_MESSAGES))
  // conversationId becomes the scopeId segment of the storage prefix — already
  // validated against CONVERSATION_ID_PATTERN above, so no traversal/separator
  // char can ride into the prefix unchecked.
  if (attachmentPrefix) {
    history = await materializeFileParts(
      access.adminDb,
      history,
      attachmentPrefix,
      modelDef.attachments.maxFiles,
    )
  } else {
    // Unreachable while the prefix is built unconditionally, and kept as the
    // fail-closed fallback: an un-materialized file part would hand the provider
    // a client-supplied URL to fetch.
    history = history.map((m) => ({
      ...m,
      parts: m.parts.filter((p) => !asFilePart(p)) as UIMessage['parts'],
    }))
  }

  const modelMessages = await convertToModelMessages(history)

  /* Withhold the memoised zero-argument context reads once their result is already in this
     turn's history (#651). Those tools take no arguments and their result is memoised per
     request, so a second call cannot return anything new — it can only burn a step. The
     model did it 115 times in browser QA even though the tool description says "CALL IT AT
     MOST ONCE PER CONVERSATION TURN" in capitals, which is the evidence that asking is not
     a control. Removing the tool is: a tool it cannot see is a tool it cannot call.

     Scoped to the current turn by scanning back to the last user message, so a professor's
     NEXT question can legitimately re-read fresh class data. */
  const toolsForThisTurn = withheldIdempotentContextTools(tools, history)

  const result = streamText({
    model,
    system,
    messages: modelMessages,
    tools: toolsForThisTurn,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    temperature: 0.6,
    providerOptions: {
      google: { thinkingConfig: { thinkingLevel: modelDef.thinkingLevel } },
    },
    experimental_transform: smoothStream({ chunking: 'word' }),
    // totalUsage, not usage: `usage` is the final step alone, so a turn that
    // called tools would leave every earlier step off the ledger.
    onFinish: async ({ totalUsage: usage, providerMetadata, steps }) => {
      // Grounded search queries are billed per-query, separately from tokens —
      // counted by the shared dual-shape reader (see src/lib/ai/grounding.ts)
      // and priced into the external ledger below. See docs/reference/athena-cost-analysis.md.
      const groundingQueries = countGroundingQueries(providerMetadata, steps)
      logEvent({
        userId: user.id,
        eventType: 'assignment_assistant.message',
        eventCategory: 'professor',
        metadata: {
          sectionId,
          surface: activeSurface,
          mode: activeMode,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          groundingQueries,
        },
        sectionId,
      })
      // after(): a client abort mid-stream tears down the request before an
      // awaited write here completes — the ledger writes run to completion as
      // a post-response task instead.
      after(async () => {
        await recordAiUsage({
          // The quiz studio is its own Athena surface for cost purposes — keeping the two
          // apart is what lets docs/reference/athena-cost-analysis.md stay honest per surface. Frontier gets
          // its OWN label rather than folding into the authoring one: a design arc is several
          // turns plus grounded searches, so averaging it into ordinary authoring would hide
          // both numbers. One label for the whole arc, so it's measurable as one thing.
          feature:
            activeMode === 'frontier'
              ? 'athena_frontier'
              : activeKind === 'about'
                ? 'about_assistant'
                : activeKind === 'quiz'
                  ? 'quiz_assistant'
                  : activeKind === 'project'
                    ? 'project_assistant'
                    : 'assignment_assistant',
          model: modelDef.model,
          institutionId: context.institutionId,
          sectionId,
          userId: user.id,
          usage: {
            inputTokens: usage?.inputTokens,
            cachedInputTokens: usage?.cachedInputTokens,
            outputTokens: usage?.outputTokens,
            // The thinking share of outputTokens, kept for the ledger split.
            reasoningTokens: usage?.reasoningTokens,
          },
        })
        if (groundingQueries > 0) {
          await recordExternalUsage({
            provider: 'google',
            feature: 'search_grounding',
            quantity: groundingQueries,
            institutionId: context.institutionId,
            sectionId,
            userId: user.id,
          })
        }
      })
    },
    onError: (err) => {
      logger.error('assignment-assistant: stream error', err, { sectionId, surface: activeSurface })
    },
  })

  // sendSources forwards Google Search grounding citations to the client so the
  // panel can show the sources Athena grounded an edit in.
  return result.toUIMessageStreamResponse({
    sendSources: true,
    // Persist the assistant's full response (text/tool/fill/source parts) once
    // the stream completes. Skipped on abort — the professor hit Stop, so
    // there's no committed turn to save. Awaited by the SDK, so the write
    // completes before the stream closes.
    onFinish: async ({ responseMessage, isAborted }) => {
      if (isAborted) return
      try {
        await persistAssistantMessage(persistCtx, responseMessage)
        // First exchange → derive a title from the opening user message.
        await maybeAutoTitle(persistCtx, messageText(messages.find((m) => m.role === 'user')))
      } catch (err) {
        logger.error('assignment-assistant: persist assistant message failed', err, {
          sectionId,
          conversationId,
        })
      }
    },
  })
}
