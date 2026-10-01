/**
 * Streaming AI quiz-question generation.
 *
 * The quiz studio POSTs a generation request here and reads an NDJSON stream:
 * one `{type:'batch', questions}` line per chunk as it completes, then a final
 * `{type:'done', metadata, total}` (or `{type:'error'}`). This lets the studio
 * surface questions batch-by-batch — the professor edits the first batch while
 * the rest generate — and, because the studio owns the request, closing the
 * generate modal mid-flight doesn't stop it. On completion a `quiz_ai_ready`
 * notification lands in the author's bell.
 *
 * Auth mirrors generateQuestionsFromModules: getUser → verifySectionAccess →
 * canWriteAsStaff, and additionalFilePaths are re-scoped to the section's
 * storage prefix (IDOR guard). The heavy lifting is shared with that action via
 * @/lib/quiz/ai-generation.
 */
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess, canWriteAsStaff } from '@/lib/auth/section-access'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { isSafeStoragePath } from '@/lib/supabase/storage'
import { logEvent } from '@/lib/supabase/event-logger'
import { emitEvent } from '@/lib/events/emit'
import { logger } from '@/lib/logger'
import { generateQuizQuestions, type GeneratedQuestion } from '@/lib/ai/llm-client'
import {
  buildQuizGenerationContext,
  resolveCitationsForBatch,
  materializeVisualsForBatch,
  persistGeneratedBatch,
  nextAssignmentPosition,
} from '@/lib/quiz/ai-generation'

// Chunks now generate sequentially (so a big quiz stays diverse instead of
// collapsing to one chunk's worth), so a large request takes longer end-to-end
// — give it real headroom. The client streams each batch as it lands, so the
// professor sees progress well before this ceiling.
export const maxDuration = 300

/** Thrown from onBatch when the target quiz has been deleted mid-run, to bail
 *  the generator (no more AI calls) instead of pouring questions into nothing. */
const QUIZ_DELETED = 'QUIZ_DELETED'

/** Does the quiz still exist in this section? Used to stop a generation whose
 *  quiz was deleted mid-run — so we quit calling the AI API and don't fire a
 *  "questions ready" notification for a quiz that's gone. */
async function quizStillExists(
  adminDb: Awaited<ReturnType<typeof verifySectionAccess>>['adminDb'],
  sectionId: string,
  quizId: string,
): Promise<boolean> {
  if (!adminDb) return false
  const { data } = await adminDb
    .from('quizzes')
    .select('id')
    .eq('id', quizId)
    .eq('section_id', sectionId)
    .maybeSingle()
  return !!data
}

/** Stems of the questions already assigned to a quiz — fed to the generator's
 *  avoid-list so a follow-up (beyond-document) run doesn't recreate them. */
async function existingQuestionStems(
  adminDb: Awaited<ReturnType<typeof verifySectionAccess>>['adminDb'],
  quizId: string | null,
): Promise<string[]> {
  if (!quizId || !adminDb) return []
  const { data: assigns } = await adminDb
    .from('quiz_question_assignments')
    .select('question_id')
    .eq('quiz_id', quizId)
  const ids = (assigns ?? []).map((a: { question_id: string }) => a.question_id)
  if (ids.length === 0) return []
  const { data: rows } = await adminDb
    .from('quiz_questions')
    .select('question_text')
    .in('id', ids)
  return (rows ?? []).map((r: { question_text: string }) => r.question_text).filter(Boolean)
}

export async function POST(req: Request) {
  let body: {
    sectionId?: string
    moduleItemIds?: unknown
    additionalFilePaths?: unknown
    questionCount?: unknown
    customPrompt?: unknown
    includeMetadata?: unknown
    questionTypes?: unknown
    quizId?: unknown
    beyondDocument?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid request body', { status: 400 })
  }

  const sectionId = typeof body.sectionId === 'string' ? body.sectionId : ''
  if (!sectionId) return new Response('Missing sectionId', { status: 400 })

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return new Response('Unauthorized', { status: 401 })

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok || !canWriteAsStaff(access.role)) return new Response('Forbidden', { status: 403 })
  const adminDb = access.adminDb

  // Institution/platform AI kill switch — before any generation token is spent.
  const aiVerdict = await checkAiFeatureBySection(adminDb, sectionId, 'quiz-ai')
  if (!aiVerdict.allowed) {
    return new Response(aiRefusalMessage(aiVerdict.lockedBy), { status: 403 })
  }

  // Normalize + validate input (the client is untrusted).
  const moduleItemIds = Array.isArray(body.moduleItemIds)
    ? body.moduleItemIds.filter((v): v is string => typeof v === 'string')
    : []
  const safeAdditionalPaths = (Array.isArray(body.additionalFilePaths) ? body.additionalFilePaths : [])
    .filter((p): p is string => typeof p === 'string' && isSafeStoragePath(p, `${sectionId}/`))
    .slice(0, 10)
  const questionCount = typeof body.questionCount === 'number' ? Math.floor(body.questionCount) : NaN
  const customPrompt = typeof body.customPrompt === 'string' && body.customPrompt.trim() ? body.customPrompt : undefined
  const includeMetadata = body.includeMetadata === true
  const questionTypes = Array.isArray(body.questionTypes)
    ? body.questionTypes.filter((v): v is string => typeof v === 'string')
    : undefined
  const quizId = typeof body.quizId === 'string' ? body.quizId : undefined
  // Opt-in: allow on-topic questions from the model's own knowledge to fill any
  // shortfall the source material can't cover (tagged ai_extended downstream).
  const beyondDocument = body.beyondDocument === true

  if (moduleItemIds.length === 0 && safeAdditionalPaths.length === 0 && !customPrompt) {
    return new Response('Select source materials or provide custom instructions', { status: 400 })
  }
  if (isNaN(questionCount) || questionCount < 1 || questionCount > 100) {
    return new Response('Question count must be between 1 and 100', { status: 400 })
  }

  // With a quizId, every batch is persisted to that quiz AS IT IS GENERATED —
  // the browser is a live viewer, not the owner: reloads/navigation/crashes
  // mid-run lose nothing. The quiz must belong to the verified section
  // (IDOR guard: quizId is client-supplied).
  let persistToQuiz: string | null = null
  if (quizId) {
    const { data: quiz } = await adminDb
      .from('quizzes')
      .select('id')
      .eq('id', quizId)
      .eq('section_id', sectionId)
      .single()
    if (!quiz) return new Response('Quiz not found in this section', { status: 404 })
    persistToQuiz = quizId
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      // Set if the quiz is found deleted mid-run — turns the resulting throw
      // into a quiet, expected stop (no error to the client, no notification).
      let quizDeleted = false
      const send = (obj: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
        } catch {
          closed = true // client disconnected — stop enqueuing
        }
      }

      try {
        // Wall-clock for the whole run — surfaced in the done message and the
        // shortfall notice ("supported N of M (in 2m 10s)").
        const runStartedMs = Date.now()
        // Mark the draft "generating" up front (before the ~20-30s extraction
        // phase during which it has 0 questions) so "Create quiz" reuse won't
        // hand this busy draft back as a new quiz. Also stamp the target total
        // (questions already on the quiz + requested) so a studio reattaching to
        // this run can show a determinate "N of M ready" counter. Both cleared
        // in finally.
        let position = persistToQuiz ? await nextAssignmentPosition(adminDb, persistToQuiz) : 0
        if (persistToQuiz) {
          await adminDb
            .from('quizzes')
            .update({
              generation_started_at: new Date().toISOString(),
              generation_total: position + questionCount,
            })
            .eq('id', persistToQuiz)
            .eq('section_id', sectionId)
        }

        // First pipeline stage — text extraction is the long silent stretch
        // (~20-30s) before any AI call, so name it rather than going quiet.
        send({ type: 'status', message: 'Extracting text from your materials…' })
        const { content, sources, assetRegistry, concepts } = await buildQuizGenerationContext(
          adminDb,
          sectionId,
          moduleItemIds,
          safeAdditionalPaths,
        )

        let total = 0
        let persisted = 0
        // Beyond-document fills run on a quiz that already has questions — seed
        // the generator's avoid-list with the existing stems so it doesn't
        // recreate them (the "fill the rest" path is exactly this case).
        const priorStems = beyondDocument
          ? await existingQuestionStems(adminDb, persistToQuiz)
          : undefined
        // Live token meter for the banner — usage metadata rides every model
        // response anyway (already recorded to the ai_usage ledger), so this
        // costs nothing extra. Reasoning tokens count: they bill as output.
        let tokensUsed = 0
        const result = await generateQuizQuestions({
          content,
          questionCount,
          customPrompt,
          includeMetadata,
          questionTypes,
          beyondDocument,
          priorStems,
          // Upload-time concepts (design §11a) — skips the whole-document
          // extraction call when every selected source has them.
          concepts: concepts ?? undefined,
          onUsage: (usage) => {
            tokensUsed += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0)
            send({ type: 'usage', tokens: tokensUsed })
          },
          attribution: { sectionId },
          // Resolve citations + materialize visuals, PERSIST to the quiz, then
          // stream the batch (with db ids so the studio treats them as saved).
          onBatch: async (batch: GeneratedQuestion[]) => {
            // If the quiz was deleted mid-run, bail NOW: throwing here unwinds
            // the generator so no further AI calls are made, and we skip the
            // completion notification for a quiz that no longer exists.
            if (persistToQuiz && !(await quizStillExists(adminDb, sectionId, persistToQuiz))) {
              quizDeleted = true
              throw new Error(QUIZ_DELETED)
            }
            resolveCitationsForBatch(batch, sources)
            await materializeVisualsForBatch(adminDb, sectionId, batch, assetRegistry)
            let ids: (string | null)[] = batch.map(() => null)
            if (persistToQuiz) {
              const res = await persistGeneratedBatch(adminDb, sectionId, persistToQuiz, batch, position)
              ids = res.ids
              position = res.nextPosition
              persisted += ids.filter(Boolean).length
            }
            total += batch.length
            send({ type: 'batch', questions: batch.map((q, i) => ({ ...q, dbId: ids[i] })) })
          },
          // Surface non-happy-path moments (retries, salvage, exhaustion) so
          // the studio can explain a pause instead of going quiet.
          onStatus: (message: string) => send({ type: 'status', message }),
        })

        if (total === 0) {
          send({ type: 'error', error: result.error || 'No questions were generated. Try different sources or a smaller count.' })
          return
        }

        // The quiz may have been deleted after the last batch (a window onBatch
        // can't catch) — don't log/notify a completion for a quiz that's gone.
        if (persistToQuiz && !(await quizStillExists(adminDb, sectionId, persistToQuiz))) {
          logger.info('generate-stream: quiz deleted before completion — skipping notification', { sectionId, quizId })
          return
        }

        const extendedCount = result.extendedCount ?? 0
        // Everything user-facing counts what actually LANDED ON THE QUIZ, not
        // what the model streamed: persistence re-validates strictly and can
        // drop questions (they vanish on reload), so `total` overstates — the
        // notice then offers "remaining 10" when the true gap is 12. `persisted`
        // is the DB truth and keeps banner, deficit, and page in lock-step.
        const delivered = persistToQuiz ? persisted : total
        const shortfall = delivered < questionCount
        const durationMs = Date.now() - runStartedMs

        await logEvent({
          userId: user.id,
          eventType: 'quiz_ai_generation',
          sectionId,
          metadata: {
            moduleItemIds,
            additionalFileCount: safeAdditionalPaths.length,
            questionCount,
            generatedCount: total,
            persistedCount: persisted,
            extendedCount,
            beyondDocument,
            exhausted: !!result.exhausted,
            rateLimited: !!result.rateLimited,
            includeMetadata,
            questionTypes: questionTypes?.length ? questionTypes : 'ai_decided',
            streamed: true,
          },
        })

        // Persist / clear the shortfall notice on the quiz so it survives
        // reload + navigation: it's the "fill the rest with topic-based
        // questions" opt-in the professor can act on later. Written only when
        // the SOURCE ran dry and they haven't opted in yet; cleared once they
        // opt in (beyondDocument) or the full count is met. A rate-limited
        // shortfall is left untouched (its fix is "retry", not this notice).
        const noticePayload = {
          requested: questionCount,
          delivered,
          durationMs,
          request: {
            moduleItemIds,
            additionalFilePaths: safeAdditionalPaths,
            questionCount,
            customPrompt,
            includeMetadata,
            questionTypes: questionTypes?.length ? questionTypes : undefined,
          },
          createdAt: new Date().toISOString(),
        }
        const willShowNotice = !beyondDocument && shortfall && !result.rateLimited && !!persistToQuiz
        if (persistToQuiz) {
          if (willShowNotice) {
            await adminDb.from('quizzes').update({ generation_notice: noticePayload }).eq('id', persistToQuiz).eq('section_id', sectionId)
          } else if (beyondDocument || !shortfall) {
            await adminDb.from('quizzes').update({ generation_notice: null }).eq('id', persistToQuiz).eq('section_id', sectionId)
          }
        }

        // Notify the author it's done — persists in the bell + toasts live, so a
        // professor who closed the modal (or looked away) still learns it finished.
        // An honest shortfall is explained, not left a mystery.
        await emitEvent({
          type: 'quiz_ai_ready',
          sectionId,
          actorId: null, // system notice — don't let the actor-filter drop the author
          audience: [user.id],
          entity: quizId ? { type: 'quiz', id: quizId } : undefined,
          title: `${delivered} AI question${delivered === 1 ? '' : 's'} ready`,
          body: result.rateLimited
            ? `The AI hit its limit, so only ${delivered} of the ${questionCount} requested were generated — wait a minute and generate again for the rest.`
            : extendedCount > 0
              ? `${delivered} AI question${delivered === 1 ? '' : 's'} ready — ${extendedCount} generated beyond your material on the same topics (tagged for you to review).`
              : result.exhausted
                ? `Your materials supported ${delivered} distinct question${delivered === 1 ? '' : 's'} of the ${questionCount} requested. Open the quiz to generate the rest beyond the document.`
                : 'Your AI-generated questions are in the quiz studio for review.',
          linkUrl: quizId
            ? `/professor/courses/${sectionId}/quizzes/${quizId}`
            : `/professor/courses/${sectionId}/quizzes`,
        })

        send({
          type: 'done',
          metadata: result.metadata ?? null,
          total: delivered,
          requested: questionCount,
          durationMs,
          exhausted: !!result.exhausted,
          rateLimited: !!result.rateLimited,
          extendedCount,
          // Mirror the persisted notice so the studio can show the banner
          // immediately (before any reload re-reads it from the quiz row).
          notice: willShowNotice ? noticePayload : null,
        })
      } catch (err) {
        if (quizDeleted || (err instanceof Error && err.message === QUIZ_DELETED)) {
          // Expected stop: the professor deleted the quiz mid-generation. Quit
          // quietly — no client error, no notification, no error log.
          logger.info('generate-stream: quiz deleted mid-generation — stopped', { sectionId, quizId })
        } else {
          logger.error('generate-stream: exception', err, { sectionId })
          send({ type: 'error', error: 'An unexpected error occurred during generation' })
        }
      } finally {
        // Always clear the "generating" stamp (and its target total) so the
        // draft can be reused/edited normally again — on success, error, or
        // early return alike.
        if (persistToQuiz) {
          try {
            await adminDb
              .from('quizzes')
              .update({ generation_started_at: null, generation_total: null })
              .eq('id', persistToQuiz)
              .eq('section_id', sectionId)
          } catch {
            // best-effort; the 15-min reuse cutoff covers a missed clear
          }
        }
        closed = true
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
    },
  })
}
