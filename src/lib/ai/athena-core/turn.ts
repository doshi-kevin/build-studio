/**
 * athena-core — one metered, persisted model call.
 *
 * The surface decides WHAT to say (prompt, tools, model); core owns what has to
 * happen around every answer regardless of surface: the cost ledger, and writing
 * the turn back to the thread with the directive scrub applied.
 *
 * Both of those used to live inline in `/api/chat`, which is how the scrub came
 * to be applied to the streamed copy but not the stored one — the client
 * re-parses message text on every reopen, so a directive the model was talked
 * into writing would drive the app again on every visit. Keeping the write here
 * means a second surface cannot reintroduce that hole by forgetting it.
 */

import 'server-only'
import { streamText, stepCountIs, type ModelMessage, type ToolSet } from 'ai'
import { google } from '@ai-sdk/google'
import { logger } from '@/lib/logger'
import { stripDirectives, type AthenaRunEvent } from '@/lib/ai/athena-directive'
import { appendStudentMessage } from './persistence'
import { recordStudentUsage } from './usage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export interface AthenaAnswerOptions {
  /** Provider model string (`studentModelDef().model`). */
  model: string
  system: string
  messages: ModelMessage[]
  tools: ToolSet
  /** Bounded tool loop — read-only tools can't run away, but cap it anyway. */
  maxSteps: number
  temperature?: number
  maxOutputTokens?: number
  /** Who to bill the call to. Metered even when no conversation is open. */
  meter: { sectionId: string; userId: string }
  /** Where the answer is written back. `conversationId: null` = unpersisted chat. */
  persist: {
    adminDb: AdminDb
    conversationId: string | null
    institutionId: string
    sectionId: string
    userId: string
    /** Read at finish, so tool rows reported mid-stream are included. */
    run: () => readonly AthenaRunEvent[]
  }
}

/** Start the model call. The returned result's `textStream` feeds `streamAthenaResponse`. */
export function streamAthenaAnswer(opts: AthenaAnswerOptions) {
  const { persist } = opts
  return streamText({
    model: google(opts.model),
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    stopWhen: stepCountIs(opts.maxSteps),
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
    onFinish: async (event) => {
      // Cost ledger first — every call is metered, even when the client didn't
      // open a persisted conversation.
      void recordStudentUsage({
        model: opts.model,
        sectionId: opts.meter.sectionId,
        userId: opts.meter.userId,
        usage: {
          inputTokens: event.usage?.inputTokens,
          cachedInputTokens: event.usage?.cachedInputTokens,
          outputTokens: event.usage?.outputTokens,
          reasoningTokens: event.usage?.reasoningTokens,
        },
      })
      if (!persist.conversationId || !event.text) return
      const runLog = persist.run()
      try {
        await appendStudentMessage(persist.adminDb, {
          conversationId: persist.conversationId,
          institutionId: persist.institutionId,
          sectionId: persist.sectionId,
          userId: persist.userId,
          role: 'assistant',
          // SCRUBBED, not raw — see this module's header for why the stored copy
          // is the one that matters.
          content: stripDirectives(event.text),
          metadata: {
            usage: {
              inputTokens: event.usage?.inputTokens,
              outputTokens: event.usage?.outputTokens,
            },
            // What she looked up and set up, so a reopened thread still shows
            // its cards. Data, not markers — see `messageRun`.
            ...(runLog.length > 0 ? { run: runLog } : {}),
          },
        })
      } catch (err) {
        logger.error('streamAthenaAnswer: failed to save the assistant message', err, {
          source: 'athenaCore.streamAthenaAnswer',
          conversationId: persist.conversationId,
        })
      }
    },
  })
}
