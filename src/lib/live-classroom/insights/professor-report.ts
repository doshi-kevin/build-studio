// Shared internals for building the professor's Class Insights report.
// Plain server-side module (NOT 'use server') so both the lazy-on-view action
// (report/actions.ts) and the end-of-class generation orchestrator
// (insights/generate.ts) reuse the exact same fetch + compute + narrate logic.
// Callers handle their own auth and storage; nothing here trusts a session.

import 'server-only'

import { buildLectureContext } from '@/lib/live-classroom/lecture-context'
import { generateSessionReportNarrative } from '@/lib/ai/llm-client'
import { computeSessionStats, type SessionReport, type SessionReportInput } from '@/lib/live-classroom/report/compute'
import type { AiAttribution } from '@/lib/ai/usage'

export interface ReportRoom {
  id: string
  section_id: string
  created_at: string
  /** When the class actually started (see compute.ts — the late-join baseline).
   *  Null for rooms that ran before the column existed. */
  started_at: string | null
  ended_at: string | null
}

type SessionDeck = SessionReportInput['decks'][number]

function deckLabel(deck: SessionDeck): string {
  return deck.title?.trim() || `Deck ${deck.position}`
}

/**
 * Fetch every deck in the room with its own transcript, ordered by position.
 * Per-deck transcripts keep page numbering coherent (each deck is 0-indexed)
 * and let the report group content by file.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchDecksWithTranscripts(adminDb: any, roomId: string): Promise<SessionDeck[]> {
  const { data: deckRows } = await adminDb
    .from('lc_decks')
    .select('id, title, position, page_count, max_slide')
    .eq('room_id', roomId)
    .order('position', { ascending: true })
  const decks = (deckRows ?? []) as Array<{
    id: string
    title: string | null
    position: number
    page_count: number | null
    max_slide: number | null
  }>
  if (decks.length === 0) return []

  const { data: txRows } = await adminDb
    .from('lc_transcriptions')
    .select('deck_id, page_number, text')
    .in('deck_id', decks.map((d) => d.id))
    .order('page_number', { ascending: true })
  const txByDeck = new Map<string, Array<{ page_number: number; text: string }>>()
  for (const t of (txRows ?? []) as Array<{ deck_id: string; page_number: number; text: string }>) {
    const list = txByDeck.get(t.deck_id) ?? []
    list.push({ page_number: t.page_number, text: t.text })
    txByDeck.set(t.deck_id, list)
  }

  return decks.map((d) => ({
    id: d.id,
    title: d.title,
    position: d.position,
    pageCount: d.page_count,
    /* How far the professor actually got, as a 0-indexed high-water mark kept by a
       trigger on every slide change. `page_count` is the file's length, which is a
       different fact: a 20-slide deck stopped at slide 8 has page_count 20 and
       max_slide 7. Until now only the roadmap read this column. */
    maxSlideShown: d.max_slide,
    transcriptions: txByDeck.get(d.id) ?? [],
  }))
}

/**
 * Fetch everything a session report (and the student blob) needs: decks +
 * transcripts, interactions, responses, the enrolled roster with names, and
 * attendance. The single source of truth for "the raw session", shared by
 * the lazy action and the orchestrator.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchSessionInputs(adminDb: any, room: ReportRoom): Promise<SessionReportInput> {
  const [decks, intRes, enrollRes, attRes] = await Promise.all([
    fetchDecksWithTranscripts(adminDb, room.id),
    adminDb
      .from('lc_interactions')
      .select('id, kind, payload, status, created_by')
      .eq('room_id', room.id)
      .order('created_at', { ascending: true }),
    adminDb
      .from('enrollments')
      .select('student_id')
      .eq('section_id', room.section_id)
      .in('status', ['enrolled', 'completed']),
    adminDb
      .from('lc_attendance')
      .select('student_id, joined_at, last_seen_at')
      .eq('room_id', room.id),
  ])

  const interactions = (intRes.data ?? []) as SessionReportInput['interactions']
  const enrolledIds: string[] = ((enrollRes.data ?? []) as Array<{ student_id: string }>).map(
    (e) => e.student_id,
  )
  const attendance = (attRes.data ?? []) as SessionReportInput['attendance']

  const interactionIds = interactions.map((i) => i.id)
  const { data: responseRows } = interactionIds.length
    ? await adminDb
        .from('lc_responses')
        .select('interaction_id, student_id, response')
        .in('interaction_id', interactionIds)
    : { data: [] }
  const responses = (responseRows ?? []) as SessionReportInput['responses']

  const nameById = new Map<string, string>()
  if (enrolledIds.length > 0) {
    const { data: profiles } = await adminDb
      .from('profiles')
      .select('id, name, email')
      .in('id', enrolledIds)
    for (const p of (profiles ?? []) as Array<{ id: string; name?: string; email?: string }>) {
      nameById.set(p.id, p.name || p.email || 'Student')
    }
  }
  const enrolledStudents = enrolledIds.map((id) => ({ id, name: nameById.get(id) ?? 'Student' }))

  return {
    room: { createdAt: room.created_at, startedAt: room.started_at, endedAt: room.ended_at },
    decks,
    interactions,
    responses,
    enrolledStudents,
    attendance,
  }
}

/**
 * Strip student names before anything reaches the LLM — the narrative
 * interprets numbers and content, never identities.
 */
function redactedStatsForNarrative(report: SessionReport): string {
  return JSON.stringify({
    durationMinutes: report.meta.durationMinutes,
    slidesWithTranscript: report.meta.slidesWithTranscript,
    decks: report.decks.map((d) => ({
      title: d.title ?? `Deck ${d.position}`,
      slides: d.pageCount,
      slidesWithTranscript: d.slidesWithTranscript,
    })),
    attendance: report.attendance.tracked
      ? {
          enrolledCount: report.attendance.enrolledCount,
          attendedCount: report.attendance.attendedCount,
          ratePercent: report.attendance.rate,
          lateJoins: report.attendance.attendees.filter((a) => a.lateJoin).length,
        }
      : 'not tracked',
    activeParticipation: {
      activeCount: report.participation.activeCount,
      enrolledCount: report.participation.enrolledCount,
      ratePercent: report.participation.rate,
    },
    quizzes: report.quizzes.map((q) => ({
      title: q.title,
      submissions: q.submissions,
      accuracyPercent: q.accuracy,
      concepts: q.concepts,
    })),
    polls: report.polls.map((p) => ({
      question: p.question,
      totalResponses: p.total,
      choices: p.choices.map((c) => ({ text: c.text, count: c.count })),
    })),
    qa: {
      totalQuestions: report.qa.total,
      answered: report.qa.answeredCount,
      unansweredQuestions: report.qa.unanswered.map((q) => q.text),
    },
    struggleConcepts: report.struggleConcepts,
  })
}

export async function generateNarrative(
  report: SessionReport,
  decks: SessionDeck[],
  attribution?: AiAttribution,
): Promise<{ narrative: string | null; failed: boolean }> {
  // Label each deck's transcript so the narrative can organize "what was
  // taught" by file when a session spans more than one deck.
  const transcription = decks
    .filter((d) => d.transcriptions.some((t) => t.text.trim().length > 0))
    .map((d) => {
      const { transcriptionContent } = buildLectureContext(null, d.transcriptions)
      return `\n\n===== ${deckLabel(d)} =====${transcriptionContent}`
    })
    .join('')

  const result = await generateSessionReportNarrative(
    {
      transcription,
      statsJson: redactedStatsForNarrative(report),
    },
    attribution,
  )
  if (result.error || !result.narrative) {
    return { narrative: null, failed: true }
  }
  return { narrative: result.narrative, failed: false }
}

/**
 * Compute the deterministic professor report from pre-fetched inputs, then
 * layer the best-effort AI narrative on top. Pure of storage — the caller
 * persists the returned report.
 */
export async function buildProfessorReport(
  input: SessionReportInput,
  attribution?: AiAttribution,
): Promise<SessionReport> {
  const report = computeSessionStats(input)
  const hasTranscript = input.decks.some((d) => d.transcriptions.some((t) => t.text.trim().length > 0))
  if (!report.empty && hasTranscript) {
    const { narrative, failed } = await generateNarrative(report, input.decks, attribution)
    report.aiNarrative = narrative
    report.narrativeFailed = failed
  }
  return report
}
