/**
 * Professor AI assistant — streaming chat endpoint.
 *
 * Mirrors /api/chat (the student tutor) but: (1) authorizes as section STAFF
 * (professor/TA) not as an enrolled student, (2) streams a UI MESSAGE stream
 * (toUIMessageStreamResponse) so tool calls arrive on the client as typed parts
 * that render as draft cards, (3) exposes the draft + insight tools.
 *
 * Security: assume this is called unauthenticated by an attacker. We
 * getAuthUser → verifySectionAccess → canWriteAsStaff before streaming. The
 * DRAFT tools never mutate; mutation happens only when the professor approves a
 * card, which calls the existing (independently authorized) server actions.
 */

import { streamText, convertToModelMessages, stepCountIs, smoothStream, type UIMessage } from 'ai'
import { checkEntitlement } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { after } from 'next/server'
import { google } from '@ai-sdk/google'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess, canWriteAsStaff } from '@/lib/auth/section-access'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { resolveAthenaModelDef } from '@/lib/ai/professor-assistant/models'
import { reserveAthenaSlot } from '@/lib/ai/professor-assistant/rate-limit'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { athenaAttachmentPrefix } from '@/lib/ai/athena-attachments'
import {
  materializeFileParts,
  filePartsToPaths,
} from '@/lib/ai/athena-attachments-server'
import { recordAiUsage } from '@/lib/ai/usage'
import { recordExternalUsage } from '@/lib/costs/external-usage'
import { countGroundingQueries } from '@/lib/ai/grounding'
import { loadAssistantContext } from '@/lib/ai/professor-assistant/context'
import { buildProfessorAssistantSystemPrompt } from '@/lib/ai/professor-assistant/prompts'
import { buildAssistantTools } from '@/lib/ai/professor-assistant/tools'
import {
  persistUserMessage,
  persistAssistantMessage,
  maybeAutoTitle,
  type ChatPersistCtx,
} from '@/lib/ai/professor-assistant/persistence'

export const maxDuration = 60

// Bound per-turn input cost (Stage 2a): only the most recent slice of the thread
// is sent to the model. Gemini's 1M window + static-first prompt caching cover
// the rest; this stops a long chat from growing input tokens without limit.
// Whole messages only — a tool call and its result live in one message, so this
// never orphans a call from its result; prepareMessagesForModel still re-injects
// the most recent unresolved draft (which is always inside this window).
const MAX_HISTORY_MESSAGES = 40

// Agent loop budget. Each step is one model turn that can call tools and get
// results fed back. >1 lets Athena ITERATE — e.g. run a web search, see the
// results are thin, and search again with a refined query before drafting, or
// chain an insights lookup into a draft. Bounded to keep cost/latency in check;
// draft tools have no execute so they pause the loop and can't run it away.
const MAX_AGENT_STEPS = 6

/** Concatenated text of a message's text parts (for auto-titling). */
function messageText(message: UIMessage | undefined): string {
  if (!message) return ''
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/**
 * Prepare history for the model.
 *
 * A tool call with no matching result makes the provider reject the request
 * (AI_MissingToolResultsError), so UNRESOLVED draft tool calls (a draft the
 * professor neither approved nor discarded, then sent a follow-up) cannot be
 * sent as-is. Earlier we dropped them entirely — but that meant a "change just
 * question 3" request lost the very draft it was editing, forcing the model to
 * regenerate the whole quiz from scratch (dropping good questions, switching
 * styles, even re-introducing banned content). Real professors hated this.
 *
 * Instead we PRESERVE the most recent unresolved draft as a TEXT note so the
 * model can see exactly what it proposed and edit surgically. Older unresolved
 * drafts (superseded by re-rolls) are dropped to avoid confusion/bloat.
 * Resolved tool calls (output-available/error) pass through unchanged so the
 * normal approve→acknowledge flow still works.
 */
/* Tools this console once exposed and no longer does. A stored part naming one
   must never be re-injected: the instruction it produces tells the model to
   "CALL the X tool again" for a tool that isn't in the declared set, which is a
   standing push toward substituting a different write-capable draft tool. Names
   are matched WITHOUT the `tool-` prefix, as they appear in the re-injected text. */
const RETIRED_TOOLS = new Set(['draft_quiz'])

function prepareMessagesForModel(messages: UIMessage[]): UIMessage[] {
  const isRetired = (p: { type?: unknown }) =>
    typeof p.type === 'string' && RETIRED_TOOLS.has(p.type.replace(/^tool-/, ''))

  const isUnresolved = (p: { type?: unknown; state?: string }) =>
    typeof p.type === 'string' &&
    p.type.startsWith('tool-') &&
    !isRetired(p) &&
    p.state !== 'output-available' &&
    p.state !== 'output-error'

  // Find the toolCallId of the LAST unresolved draft — only it is worth keeping.
  let keepId: string | undefined
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const p of m.parts as Array<{ type?: unknown; state?: string; toolCallId?: string }>) {
      if (isUnresolved(p)) keepId = p.toolCallId
    }
  }

  return messages
    .map((m) => {
      if (m.role !== 'assistant') return m
      const parts = m.parts.flatMap((p) => {
        const pp = p as { type?: unknown; state?: string; toolCallId?: string; input?: unknown }
        // A retired tool's part carries no meaning for the model — drop it.
        if (isRetired(pp)) return []
        if (!isUnresolved(pp)) return [p]
        // Re-inject only the most recent unresolved draft, as text the model can edit.
        if (pp.toolCallId === keepId) {
          const toolName = typeof pp.type === 'string' ? pp.type.replace(/^tool-/, '') : 'draft'
          return [
            {
              type: 'text',
              text: `[CONTEXT FOR YOU ONLY — do NOT repeat any of this in your reply. The professor is editing a draft you already proposed via the "${toolName}" tool. The JSON below is the current draft, for your reference. To revise it, CALL the "${toolName}" tool again with the COMPLETE updated draft — every item the professor did not ask to change reproduced byte-for-byte. NEVER write the draft as chat text or inside a code block; it must go through the tool call.\nCurrent draft (reference only): ${JSON.stringify(pp.input)}]`,
            } as UIMessage['parts'][number],
          ]
        }
        return []
      })
      return { ...m, parts }
    })
    .filter((m) => m.role !== 'assistant' || m.parts.length > 0)
}

// ── File attachments ────────────────────────────────────────────────
// The wire format, the IDOR guard and model-time materialization are shared with
// the student dock — see athena-attachments-server.ts. Only persistence differs
// (this route stores whole UIMessage parts; the student route stores text + a
// metadata list), so only that helper lives here.


export async function POST(req: Request) {
  // DefaultChatTransport forwards the useChat `id` as `body.id` — that's our
  // conversation id (client-generated UUID, persisted server-side).
  let body: { messages?: UIMessage[]; sectionId?: string; id?: string; timeZone?: string; modelId?: string }
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid request body', { status: 400 })
  }

  const { messages, sectionId, id: conversationId, timeZone, modelId } = body
  if (!sectionId || !Array.isArray(messages)) {
    return new Response('Missing sectionId or messages', { status: 400 })
  }
  if (!conversationId || typeof conversationId !== 'string') {
    return new Response('Missing conversation id', { status: 400 })
  }

  // 1. Authenticate
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) return new Response('Unauthorized', { status: 401 })

  // 2. Authorize — must be section staff who can write (professor or TA)
  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return new Response('Forbidden', { status: 403 })
  }

  // 3. Load course context (read-only) + build system prompt
  const context = await loadAssistantContext(access.adminDb, sectionId, user.id)
  const system = buildProfessorAssistantSystemPrompt(context, typeof timeZone === 'string' ? timeZone : undefined)

  // 3b. Persist the new user message BEFORE streaming, and fail closed if it
  // doesn't land — never let the client stream optimistically against a DB that
  // didn't record the turn (that would fragment the history on reload).
  const persistCtx: ChatPersistCtx = {
    adminDb: access.adminDb,
    conversationId,
    sectionId,
    userId: user.id,
    institutionId: context.institutionId,
  }
  // Attachment paths must live under this exact prefix (set at upload time from
  // the verified section). Used to reject forged cross-tenant paths on persist + model.
  const attachmentPrefix = athenaAttachmentPrefix({
    institutionId: context.institutionId,
    sectionId,
    scopeId: conversationId,
  })

  // IDOR guard: verify the conversation belongs to THIS caller before we write to
  // it. verifySectionAccess only proves they can use this section — not that they
  // own this conversationId. Without this, a staffer could pass their own
  // sectionId + someone else's conversationId and inject a message into the
  // victim's history via the RLS-bypassing admin client (ensureConversation
  // no-ops on the id conflict, then the append still writes). A brand-new
  // conversation isn't in the DB yet — that's allowed (no row → no owner yet).
  // The upload route does the same check (upload/route.ts).
  const { data: existingConvo } = await access.adminDb
    .from('athena_conversations')
    .select('section_id, user_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (existingConvo && (existingConvo.section_id !== sectionId || existingConvo.user_id !== user.id)) {
    return new Response('Forbidden', { status: 403 })
  }

  // 3c. Enforce per-model daily rate limits BEFORE we persist or stream.
  // reserveAthenaSlot atomically claims one slot on the professor's preferred
  // model (resolveAthenaModelDef whitelists the untrusted id), failing over to
  // the next registry model with budget. If every model is exhausted, block with
  // a structured 429 (incl. resets_at) the client renders — never a silent 500.
  // Scope 'console': this sidebar surface has its own pool, independent of the
  // assignment / quiz / grade panels.
  // Institution/platform AI kill switch — before any slot is reserved or token
  // spent. Fail-closed; the client renders the message as a structured error.
  const aiVerdict = await checkAiFeature(access.adminDb, context.institutionId, 'athena-professor')
  if (!aiVerdict.allowed) {
    return Response.json(
      { error: 'ai_disabled', message: aiRefusalMessage(aiVerdict.lockedBy) },
      { status: 403 },
    )
  }

  /* Entitlement is a SEPARATE question from the kill switch above, and both
     must pass. The kill switch answers "is AI safe to run right now"; this
     answers "did this school buy Athena at all". They fail in opposite
     directions on a read error by design, so they are checked separately and
     never share a code path. */
  const entitlement = await checkEntitlement(access.adminDb, context.institutionId, 'athena')
  if (!entitlement.allowed) {
    return Response.json(
      { error: 'not_entitled', message: entitlementRefusalMessage('athena') },
      { status: 403 },
    )
  }

  const requestedModel = resolveAthenaModelDef(modelId)
  const reservation = await reserveAthenaSlot(access.adminDb, {
    institutionId: context.institutionId,
    userId: user.id,
    scope: 'console',
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
  // The model that actually has budget (may differ from the professor's pick after
  // failover). Drives the model client, the tools gate, and the cost ledger below.
  const modelDef = reservation.modelDef

  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role === 'user') {
    try {
      // Persist file parts by storage path (not the signed URL); drop forged paths.
      await persistUserMessage(persistCtx, filePartsToPaths(lastMessage, attachmentPrefix))
    } catch (err) {
      logger.error('professor-assistant: persist user message failed', err, { sectionId, conversationId })
      return new Response('Could not save your message', { status: 500 })
    }
  }
  // Map the validated provider to a model client. One case today; adding a
  // provider = a new case here (plus its SDK + key) and a registry entry.
  let model
  switch (modelDef.provider) {
    case 'google':
    default:
      model = google(modelDef.model)
      break
  }

  const tools = {
    ...buildAssistantTools({
      adminDb: access.adminDb,
      sectionId,
      userId: user.id,
      // Both come from the context already loaded above, so remembering a
      // preference costs no extra query.
      institutionId: context.institutionId,
      sectionEndDate: context.sectionEndDate,
      canRememberWorkflow: access.role === 'professor',
    }),
    // Native Gemini Google Search grounding (read-only, executed server-side by
    // Google). Lets Athena look real facts/citations/standards up instead of
    // guessing or leaving a [placeholder]. Officially supported alongside our
    // function tools on gemini-3 (we're on the preview model). Search results
    // are untrusted content — the system prompt instructs the model to cite,
    // not obey, them; the draft-only/no-write contract caps the blast radius.
    // Gemini-specific — only attached for Google models.
    ...(modelDef.provider === 'google' ? { google_search: google.tools.googleSearch({}) } : {}),
  }

  // Inline attachment bytes for the model (download via admin; never trust the
  // client URL). Bounded by the history window above.
  const windowed = prepareMessagesForModel(messages.slice(-MAX_HISTORY_MESSAGES))
  const modelMessages = await convertToModelMessages(
    await materializeFileParts(access.adminDb, windowed, attachmentPrefix),
  )

  const result = streamText({
    model,
    system,
    messages: modelMessages,
    tools,
    // Bounded agent loop — see MAX_AGENT_STEPS. Lets Athena reuse tools (re-search
    // on thin results, chain insights → draft) before finishing the turn.
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    temperature: 0.6,
    // Gemini 3 thinks at 'high' by default; those reasoning tokens are the
    // dominant, highly-variable latency in Athena's replies. Pin each model to
    // its lowest thinking level (Flash 'minimal', Pro 'low' — see the registry)
    // to keep responses fast. Google-specific; all Athena models are Google
    // today, so this rides the single provider case above.
    providerOptions: {
      google: {
        thinkingConfig: { thinkingLevel: modelDef.thinkingLevel },
      },
    },
    // Smooth jagged token bursts into a steady word-paced stream so live
    // markdown renders smoothly as it arrives.
    experimental_transform: smoothStream({ chunking: 'word' }),
    // totalUsage, not usage: `usage` is the final step alone, so a turn that
    // called tools would leave every earlier step off the ledger.
    onFinish: async ({ totalUsage: usage, providerMetadata, steps }) => {
      // Grounded search queries are billed per-query, separately from tokens.
      // The shared dual-shape reader also counts the server-tool shape this
      // route's old inline read missed (a QA-proven under-count on the
      // assignment route — same google_search tool is attached here).
      const groundingQueries = countGroundingQueries(providerMetadata, steps)
      logEvent({
        userId: user.id,
        eventType: 'professor_assistant.message',
        eventCategory: 'professor',
        metadata: {
          sectionId,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          groundingQueries,
        },
        sectionId,
      })
      // Per-call cost ledger for the super-admin Cost Analysis dashboard.
      // after(): a client abort mid-stream tears down the request before an
      // awaited write here completes — the ledger writes run to completion as
      // a post-response task instead.
      after(async () => {
        await recordAiUsage({
          feature: 'professor_assistant',
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
      logger.error('professor-assistant: stream error', err, { sectionId })
    },
  })

  // sendSources forwards Google Search grounding citations to the client so the
  // UI can show the sources Athena grounded a draft in.
  return result.toUIMessageStreamResponse({
    sendSources: true,
    // Persist the assistant's full response message (text/tool/draft/source
    // parts) once the stream completes. Skipped on abort — the professor hit
    // Stop, so there's no committed turn to save. onFinish is awaited by the
    // SDK, so the write completes before the stream closes.
    onFinish: async ({ responseMessage, isAborted }) => {
      if (isAborted) return
      try {
        await persistAssistantMessage(persistCtx, responseMessage)
        // First exchange → derive a title from the opening user message.
        await maybeAutoTitle(persistCtx, messageText(messages.find((m) => m.role === 'user')))
      } catch (err) {
        logger.error('professor-assistant: persist assistant message failed', err, {
          sectionId,
          conversationId,
        })
      }
    },
  })
}
