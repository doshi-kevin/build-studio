/**
 * Streaming AI grade suggestion endpoint.
 *
 * POSTs a { sectionId, assignmentId } body and returns an NDJSON stream:
 *   {type:'status', message}         — progress during ingest / grading
 *   {type:'suggestion', submissionId, suggestion} — per student, after DB upsert
 *   {type:'done', count, durationMs} — final summary
 *   {type:'error', message}          — on failure (never throws to client)
 *
 * Auth mirrors suggestGradesForAssignment in actions.ts:
 *   getUser → verifySectionAccess + canWriteAsStaff → object-check assignment →
 *   resolve institution_id → createAdminClient → buildAndSaveSuggestionsForAssignment.
 */
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifySectionAccess, canWriteAsStaff } from '@/lib/auth/section-access'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { buildAndSaveSuggestionsForAssignment } from '@/lib/assignments/ai-grading/suggest'
import type { AiGradeSuggestion } from '@/lib/assignments/ai-grading/types'

export const maxDuration = 300

export async function POST(req: Request) {
  let body: { sectionId?: unknown; assignmentId?: unknown }
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid request body', { status: 400 })
  }

  const sectionId = typeof body.sectionId === 'string' ? body.sectionId.trim() : ''
  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId.trim() : ''
  if (!sectionId) return new Response('Missing sectionId', { status: 400 })
  if (!assignmentId) return new Response('Missing assignmentId', { status: 400 })

  // 1. Authenticate.
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) return new Response('Unauthorized', { status: 401 })

  // 2. Authorize: role check + section membership.
  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return new Response('Forbidden', { status: 403 })
  }

  // 3. Object-check: the assignment must belong to this section (IDOR guard).
  const { data: assignment } = await access.adminDb
    .from('assignments')
    .select('id, section_id, points, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) {
    return new Response('Assignment not found', { status: 404 })
  }

  // 4. Resolve institution_id from the section (never trust client).
  const { data: section } = await access.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section?.institution_id) {
    return new Response('Course section not found', { status: 404 })
  }
  const institutionId = section.institution_id

  // Institution/platform AI kill switch — before any grading token is spent.
  const aiVerdict = await checkAiFeature(access.adminDb, institutionId, 'assignment-ai')
  if (!aiVerdict.allowed) {
    return new Response(aiRefusalMessage(aiVerdict.lockedBy), { status: 403 })
  }

  // 5. Create admin client only after all authz checks pass.
  const adminDb = createAdminClient()

  const startMs = Date.now()
  const userId = user.id

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false

      const send = (obj: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
        } catch {
          closed = true
        }
      }

      try {
        send({ type: 'status', message: 'Reading submissions...' })

        let skippedCount = 0
        const result = await buildAndSaveSuggestionsForAssignment({
          adminDb,
          institutionId,
          sectionId,
          assignment: {
            id: assignment.id,
            points: Number(assignment.points),
            settings: assignment.settings,
          },
          userId,
          onSuggestion: async (
            submissionId: string,
            suggestion: AiGradeSuggestion,
            suggestionUpdatedAt: string,
          ) => {
            // suggestionUpdatedAt is the draft version — the client echoes it back on grade
            // save so correction capture can prove the professor reviewed this exact draft.
            send({ type: 'suggestion', submissionId, suggestion, suggestionUpdatedAt })
          },
          onSkipped: async (submissionId: string, reason: string) => {
            skippedCount++
            send({ type: 'skipped', submissionId, reason })
          },
        })

        if ('error' in result) {
          send({ type: 'error', message: result.error })
          return
        }

        const { count } = result
        const durationMs = Date.now() - startMs

        await logEvent({
          userId,
          eventType: 'assignment.grades_suggested_bulk',
          eventCategory: 'course',
          sectionId,
          metadata: { assignmentId, count, skipped: skippedCount },
        })

        send({ type: 'done', count, skipped: skippedCount, durationMs })
      } catch (err) {
        logger.error('ai-suggest-stream: unhandled exception', err, { sectionId, assignmentId })
        send({ type: 'error', message: 'An unexpected error occurred during grading.' })
      } finally {
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
