// Pure computation of the post-session report from raw session rows.
// Every number in the report comes from here (plain code, unit-tested);
// the AI narrative is layered on top by the server action and never
// contributes data. See docs/designs/live-classroom/live-classroom-session-report.md.

import { computePollAggregate, type PollChoice } from '@/lib/live-classroom/interactions/aggregates'
import type { QuizReport } from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'

/**
 * Joining this long after the class actually started counts as a late join.
 * 10 minutes is a product default, not a measured one — it's the usual grace a
 * lecture gives for the walk between buildings.
 */
/** lc_attendance shipped in migration 20260612044754 (2026-06-12). Rooms older than this
 *  ran without capture, so an empty attendance list there means "unknown", not "nobody". */
const ATTENDANCE_CAPTURE_SHIPPED_MS = Date.parse('2026-06-12T00:00:00Z')

const LATE_JOIN_MS = 10 * 60 * 1000

/** Concepts below this accuracy across the session's quizzes are "struggle" areas. */
const STRUGGLE_THRESHOLD = 60

// ── Input rows (plain data, fetched by the server action) ────────────

export interface SessionReportInput {
  room: {
    createdAt: string
    /**
     * When the professor actually started the class (pre-class setup committed,
     * deck activated, students notified) — the baseline for "late join".
     * `createdAt` is when the room shell was opened, often many minutes earlier
     * while a deck uploaded, so it marks on-time students late. Null/absent for
     * rooms that ran before `lc_rooms.started_at` existed; those fall back to
     * `createdAt` (unchanged behaviour).
     */
    startedAt?: string | null
    endedAt: string | null
  }
  /** Every deck presented in the session, each with its own transcript.
   *  Transcript/slide counts are grouped per deck (a session can span files). */
  decks: Array<{
    id: string
    title: string | null
    position: number
    pageCount: number | null
    /** 0-indexed high-water mark of the furthest slide reached. See ReportDeck.slidesShown. */
    maxSlideShown: number | null
    transcriptions: Array<{ page_number: number; text: string }>
  }>
  interactions: Array<{
    id: string
    kind: 'poll' | 'quiz' | 'question'
    payload: Record<string, unknown>
    status: 'draft' | 'open' | 'closed'
    created_by: string
  }>
  responses: Array<{
    interaction_id: string
    student_id: string
    response: Record<string, unknown>
  }>
  /** All enrolled students of the section, with display names. */
  enrolledStudents: Array<{ id: string; name: string }>
  attendance: Array<{ student_id: string; joined_at: string; last_seen_at: string }>
}

// ── Report shape (stored as lc_session_reports.report) ───────────────

export interface ReportConceptStat {
  concept: string
  correctCount: number
  totalCount: number
  correctRate: number
}

export interface ReportQuiz {
  interactionId: string
  title: string
  submissions: number
  /** Overall % of answers correct, 0-100. */
  accuracy: number
  concepts: ReportConceptStat[]
  nonResponderCount: number
}

export interface ReportPoll {
  interactionId: string
  question: string
  total: number
  choices: Array<{ id: string; text: string; count: number }>
}

export interface ReportQuestion {
  text: string
  upvotes: number
  answered: boolean
}

export interface ReportDeck {
  id: string
  title: string | null
  position: number
  /** The file's length. NOT how far the class got — see slidesShown. */
  pageCount: number | null
  slidesWithTranscript: number
  /**
   * How many slides were actually put on screen, or null when we can't tell.
   *
   * Derived from `lc_decks.max_slide`, which is 0-indexed and defaults to 0. So 0
   * is ambiguous — it means "never presented" AND "only the first slide was
   * shown", and nothing distinguishes them. Rather than claim "1 slide shown" for
   * a deck that was never opened, this stays null at the mark's floor and only
   * reports a count once the professor has advanced at least once.
   */
  slidesShown: number | null
}

/** One enrolled student's at-a-glance performance. Professor-only (carries
 *  the student's name); never exposed on the student side. */
export interface ReportStudent {
  id: string
  name: string
  attended: boolean
  lateJoin: boolean
  /** Approximate minutes in class; 0 if absent. */
  minutes: number
  /** Distinct quizzes the student answered. */
  quizzesAnswered: number
  /** % of the student's quiz answers that were correct; null if they answered none. */
  quizAccuracy: number | null
  /** Non-anonymous questions the student asked. */
  questionsAsked: number
  /** Flagged for follow-up: absent, silent through every quiz, or scoring low. */
  atRisk: boolean
}

export interface SessionReport {
  version: 1
  /** True when the session produced nothing to report (no transcript, no interactions). */
  empty: boolean
  meta: {
    startedAt: string
    endedAt: string | null
    durationMinutes: number
    /** Total slides across all decks. */
    slideCount: number | null
    /** Total slides with transcript across all decks. */
    slidesWithTranscript: number
    /** How many decks the session spanned. */
    deckCount: number
    /** Slides actually shown, summed across decks. Null when no deck reports a mark. */
    slidesShown: number | null
  }
  /** Per-deck transcript coverage (a session can span multiple files). */
  decks: ReportDeck[]
  attendance: {
    /** False for rooms that ended before attendance capture shipped. */
    tracked: boolean
    enrolledCount: number
    attendedCount: number
    /** 0-100, against enrolled. */
    rate: number
    attendees: Array<{
      id: string
      name: string
      joinedAt: string
      /** Approximate minutes in class (last seen − joined). */
      minutes: number
      lateJoin: boolean
    }>
    absent: Array<{ id: string; name: string }>
  }
  participation: {
    /** Students who answered a quiz/poll or asked a non-anonymous question. */
    activeCount: number
    enrolledCount: number
    /** 0-100, against enrolled. */
    rate: number
  }
  quizzes: ReportQuiz[]
  polls: ReportPoll[]
  /** Per-student performance, sorted at-risk-first then by name. Professor-only. */
  students: ReportStudent[]
  qa: {
    total: number
    answeredCount: number
    unanswered: ReportQuestion[]
    /**
     * EVERY answered question, by upvotes. The report is presented as the full
     * Q&A log, so the answered panel must not be a sample: it used to render
     * `top.filter(answered)`, which truncated to 5 BEFORE filtering — so a
     * session with 6 answered questions could display 2 of them while the stat
     * card said "6 answered".
     *
     * Optional because reports persisted before this field existed don't carry
     * it; the view falls back to the old derivation for those.
     */
    answered?: ReportQuestion[]
    /** Top questions by upvotes (includes answered ones). */
    top: ReportQuestion[]
  }
  struggleConcepts: ReportConceptStat[]
  /** Markdown narrative from the LLM; null when generation failed or empty session. */
  aiNarrative: string | null
  /** True when narrative generation failed (UI offers retry). */
  narrativeFailed: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

/**
 * A concept's grouping identity. Concept tags aren't normalized at the source, so
 * "Splay Trees", "Splay trees" and "Splay  Trees" are all one topic.
 *
 * Exported because anything that tallies per concept BEFORE mergeConcepts() runs
 * has to group by this same identity. compute-student.ts counts distinct students
 * per concept for its suppression threshold: keyed by the raw label instead, one
 * student answering two spellings would count twice and un-suppress the topic.
 */
export function conceptKey(concept: string): string {
  return concept.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Merge concept stats whose labels are the same topic spelled differently —
 * quiz-question concept tags aren't normalized at the source, so "Splay Trees",
 * "Splay trees", and "Splay  Trees" arrive as separate entries. Group by a
 * case- and whitespace-insensitive key, sum the counts, and keep the display
 * label from the variant with the most answers (deterministic). Used per-quiz
 * and again when aggregating across quizzes.
 */
export function mergeConcepts(concepts: ReportConceptStat[]): ReportConceptStat[] {
  const byKey = new Map<
    string,
    { concept: string; labelWeight: number; correctCount: number; totalCount: number }
  >()
  for (const c of concepts) {
    const key = conceptKey(c.concept)
    const agg = byKey.get(key) ?? { concept: c.concept, labelWeight: 0, correctCount: 0, totalCount: 0 }
    agg.correctCount += c.correctCount
    agg.totalCount += c.totalCount
    if (c.totalCount > agg.labelWeight) {
      agg.concept = c.concept
      agg.labelWeight = c.totalCount
    }
    byKey.set(key, agg)
  }
  return Array.from(byKey.values()).map(({ concept, correctCount, totalCount }) => ({
    concept,
    correctCount,
    totalCount,
    correctRate: pct(correctCount, totalCount),
  }))
}

/**
 * Per-question / per-concept accuracy from raw responses — fallback for
 * quizzes closed without a stored QuizReport (same math as
 * getQuizConceptAnalytics / closeQuizWithReport).
 */
function computeQuizFromResponses(
  interactionId: string,
  payload: Record<string, unknown>,
  responses: SessionReportInput['responses'],
  enrolledCount: number,
): ReportQuiz {
  const questions = (payload.questions ?? []) as Array<{
    id: string
    correctChoiceId: string
    concept?: string
  }>
  const questionMap = new Map<string, { correctChoiceId: string; concept: string }>()
  for (const q of questions) {
    questionMap.set(q.id, { correctChoiceId: q.correctChoiceId, concept: q.concept ?? 'General' })
  }

  const mine = responses.filter((r) => r.interaction_id === interactionId)
  const conceptStats = new Map<string, { correct: number; total: number }>()
  let totalAnswers = 0
  let totalCorrect = 0

  for (const resp of mine) {
    const answers = (resp.response as { answers?: Record<string, string> })?.answers ?? {}
    for (const [questionId, selectedChoiceId] of Object.entries(answers)) {
      const question = questionMap.get(questionId)
      if (!question) continue
      const stats = conceptStats.get(question.concept) ?? { correct: 0, total: 0 }
      stats.total++
      totalAnswers++
      if (selectedChoiceId === question.correctChoiceId) {
        stats.correct++
        totalCorrect++
      }
      conceptStats.set(question.concept, stats)
    }
  }

  const concepts: ReportConceptStat[] = mergeConcepts(
    Array.from(conceptStats.entries()).map(([concept, { correct, total }]) => ({
      concept,
      correctCount: correct,
      totalCount: total,
      correctRate: pct(correct, total),
    })),
  ).sort((a, b) => a.correctRate - b.correctRate)

  return {
    interactionId,
    title: (payload.title as string) || 'Quiz',
    submissions: mine.length,
    accuracy: pct(totalCorrect, totalAnswers),
    concepts,
    nonResponderCount: Math.max(0, enrolledCount - mine.length),
  }
}

// ── Main ─────────────────────────────────────────────────────────────

export function computeSessionStats(input: SessionReportInput): SessionReport {
  const { room, decks: deckInputs, interactions, responses, enrolledStudents, attendance } = input

  const enrolledCount = enrolledStudents.length
  const nameById = new Map(enrolledStudents.map((s) => [s.id, s.name]))
  const startedMs = new Date(room.createdAt).getTime()
  const endedMs = room.endedAt ? new Date(room.endedAt).getTime() : startedMs
  // Late joins measure from the real start of class, falling back to room
  // creation for sessions that predate started_at.
  const classStartMs = room.startedAt ? new Date(room.startedAt).getTime() : startedMs

  // ── Decks (per-deck transcript coverage) ──
  const decks: ReportDeck[] = [...deckInputs]
    .sort((a, b) => a.position - b.position)
    .map((d) => ({
      id: d.id,
      title: d.title,
      position: d.position,
      pageCount: d.pageCount,
      slidesWithTranscript: d.transcriptions.filter((t) => t.text.trim().length > 0).length,
      /* +1 converts the 0-indexed mark to a count. Guarded at > 0 because the mark
         defaults to 0, so an untouched deck would otherwise claim one slide shown. */
      slidesShown: (d.maxSlideShown ?? 0) > 0 ? (d.maxSlideShown as number) + 1 : null,
    }))
  const totalSlidesWithTranscript = decks.reduce((s, d) => s + d.slidesWithTranscript, 0)
  const totalSlideCount = decks.reduce<number | null>(
    (s, d) => (d.pageCount != null ? (s ?? 0) + d.pageCount : s),
    null,
  )
  const totalSlidesShown = decks.reduce<number | null>(
    (s, d) => (d.slidesShown != null ? (s ?? 0) + d.slidesShown : s),
    null,
  )

  // ── Meta ──
  const meta: SessionReport['meta'] = {
    startedAt: room.createdAt,
    endedAt: room.endedAt,
    durationMinutes: Math.max(0, Math.round((endedMs - startedMs) / 60000)),
    slideCount: totalSlideCount,
    slidesWithTranscript: totalSlidesWithTranscript,
    deckCount: decks.length,
    slidesShown: totalSlidesShown,
  }

  // ── Attendance ──
  const attendedIds = new Set(attendance.map((a) => a.student_id))
  const attendees = attendance
    .map((a) => ({
      id: a.student_id,
      name: nameById.get(a.student_id) ?? 'Student',
      joinedAt: a.joined_at,
      minutes: Math.max(
        0,
        Math.round((new Date(a.last_seen_at).getTime() - new Date(a.joined_at).getTime()) / 60000),
      ),
      lateJoin: new Date(a.joined_at).getTime() - classStartMs > LATE_JOIN_MS,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const absent = enrolledStudents
    .filter((s) => !attendedIds.has(s.id))
    .map((s) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const attendanceSection: SessionReport['attendance'] = {
    /* "Was attendance captured?" is a different question from "did anyone come?", and
       `attendance.length > 0` answered the wrong one (#645 part 2). A class nobody attended
       reported "Attendance wasn't tracked" while the per-student table two sections down
       correctly listed everyone as Absent — the same page contradicting itself, and the
       professor shown the reading that says "the data is missing" rather than the one that
       says something real about that class.

       lc_attendance shipped in migration 20260612044754, so a room opened on or after that
       date was always captured and a zero is a genuine zero. Rooms older than it could not
       have been. The length check is kept as a fallback so any row at all still counts as
       tracked, whatever the date. */
    tracked:
      new Date(room.createdAt).getTime() >= ATTENDANCE_CAPTURE_SHIPPED_MS || attendance.length > 0,
    enrolledCount,
    attendedCount: attendance.length,
    rate: pct(attendance.length, enrolledCount),
    attendees,
    absent,
  }

  // ── Active participation: responded to anything, or asked non-anonymously ──
  // Anonymous askers are deliberately excluded — their identity must not feed
  // any professor-visible metric, even in aggregate.
  const activeIds = new Set(responses.map((r) => r.student_id))
  for (const i of interactions) {
    if (i.kind === 'question' && i.payload.anonymous !== true) {
      activeIds.add(i.created_by)
    }
  }
  const participation: SessionReport['participation'] = {
    activeCount: activeIds.size,
    enrolledCount,
    rate: pct(activeIds.size, enrolledCount),
  }

  // ── Quizzes ──
  const quizzes: ReportQuiz[] = interactions
    .filter((i) => i.kind === 'quiz')
    .map((i) => {
      const stored = i.payload.report as QuizReport | undefined
      if (stored) {
        return {
          interactionId: i.id,
          title: (i.payload.title as string) || 'Quiz',
          submissions: stored.totalStudents,
          accuracy: stored.overallAccuracy,
          concepts: mergeConcepts(stored.concepts),
          nonResponderCount: stored.nonResponders?.length ?? 0,
        }
      }
      return computeQuizFromResponses(i.id, i.payload, responses, enrolledCount)
    })

  // ── Polls ──
  const polls: ReportPoll[] = interactions
    .filter((i) => i.kind === 'poll')
    .map((i) => {
      const choices = (i.payload.choices ?? []) as PollChoice[]
      const mine = responses
        .filter((r) => r.interaction_id === i.id)
        .map((r) => r.response as { choiceIds?: string[]; text?: string })
      const aggregate = computePollAggregate(choices, mine)
      return {
        interactionId: i.id,
        question: (i.payload.question as string) || 'Poll',
        total: aggregate.total,
        choices: choices.map((c) => ({ id: c.id, text: c.text, count: aggregate.counts[c.id] ?? 0 })),
      }
    })

  // ── Q&A ──
  const questionRows = interactions
    .filter((i) => i.kind === 'question')
    .map((i) => ({
      text: (i.payload.text as string) || '',
      upvotes: (i.payload.upvotes as number) ?? 0,
      answered: (i.payload.answered as boolean) ?? false,
    }))
  const byUpvotes = (a: ReportQuestion, b: ReportQuestion) => b.upvotes - a.upvotes
  const qa: SessionReport['qa'] = {
    total: questionRows.length,
    answeredCount: questionRows.filter((q) => q.answered).length,
    unanswered: questionRows.filter((q) => !q.answered).sort(byUpvotes),
    answered: questionRows.filter((q) => q.answered).sort(byUpvotes),
    top: [...questionRows].sort(byUpvotes).slice(0, 5),
  }

  // ── Struggle concepts: aggregate across all quizzes ──
  // mergeConcepts collapses case/whitespace variants of the same topic
  // ("Splay Trees" vs "Splay trees") that arrive from differently-tagged
  // questions across quizzes, so they don't show up as duplicate rows.
  const struggleConcepts: ReportConceptStat[] = mergeConcepts(quizzes.flatMap((q) => q.concepts))
    .filter((c) => c.totalCount > 0 && c.correctRate < STRUGGLE_THRESHOLD)
    .sort((a, b) => a.correctRate - b.correctRate)

  // ── Per-student performance (professor-only) ──
  // Correct-answer key across every quiz question, then each student's
  // accuracy + which quizzes they answered, joined onto attendance + Q&A.
  const quizInteractionIds = new Set(interactions.filter((i) => i.kind === 'quiz').map((i) => i.id))
  const correctByQuestion = new Map<string, string>()
  for (const i of interactions) {
    if (i.kind !== 'quiz') continue
    const questions = (i.payload.questions ?? []) as Array<{ id: string; correctChoiceId: string }>
    for (const q of questions) correctByQuestion.set(`${i.id}:${q.id}`, q.correctChoiceId)
  }

  const perStudent = new Map<string, { quizzes: Set<string>; correct: number; total: number }>()
  for (const r of responses) {
    if (!quizInteractionIds.has(r.interaction_id)) continue
    const agg = perStudent.get(r.student_id) ?? { quizzes: new Set<string>(), correct: 0, total: 0 }
    agg.quizzes.add(r.interaction_id)
    const answers = (r.response as { answers?: Record<string, string> })?.answers ?? {}
    for (const [qid, choiceId] of Object.entries(answers)) {
      const correct = correctByQuestion.get(`${r.interaction_id}:${qid}`)
      if (correct == null) continue
      agg.total++
      if (choiceId === correct) agg.correct++
    }
    perStudent.set(r.student_id, agg)
  }

  const questionsByStudent = new Map<string, number>()
  for (const i of interactions) {
    if (i.kind === 'question' && i.payload.anonymous !== true) {
      questionsByStudent.set(i.created_by, (questionsByStudent.get(i.created_by) ?? 0) + 1)
    }
  }

  const attendanceById = new Map(attendance.map((a) => [a.student_id, a]))
  const totalQuizzes = quizInteractionIds.size
  const students: ReportStudent[] = enrolledStudents
    .map((s) => {
      const att = attendanceById.get(s.id)
      const attended = !!att
      const minutes = att
        ? Math.max(0, Math.round((new Date(att.last_seen_at).getTime() - new Date(att.joined_at).getTime()) / 60000))
        : 0
      const lateJoin = att ? new Date(att.joined_at).getTime() - classStartMs > LATE_JOIN_MS : false
      const agg = perStudent.get(s.id)
      const quizzesAnswered = agg?.quizzes.size ?? 0
      const quizAccuracy = agg && agg.total > 0 ? pct(agg.correct, agg.total) : null
      const questionsAsked = questionsByStudent.get(s.id) ?? 0
      const atRisk =
        !attended ||
        (totalQuizzes > 0 && quizzesAnswered === 0) ||
        (quizAccuracy != null && quizAccuracy < STRUGGLE_THRESHOLD)
      return { id: s.id, name: s.name, attended, lateJoin, minutes, quizzesAnswered, quizAccuracy, questionsAsked, atRisk }
    })
    .sort((a, b) => (a.atRisk === b.atRisk ? a.name.localeCompare(b.name) : a.atRisk ? -1 : 1))

  /**
   * "Nothing happened at all", NOT "nothing was transcribed" (#563).
   *
   * The old test was `slidesWithTranscript === 0 && interactions.length === 0`, so a
   * 50-minute class taught with transcription switched off and no polls was reported
   * as having no data — discarding the attendance, duration and deck figures computed
   * above, which are gathered for every session regardless.
   *
   * Attendance is the strongest signal that a class really happened: a room nobody
   * joined stays empty, which is the accidentally-opened-room case. Deliberately NOT
   * gated on a minimum duration — that would put a cliff in front of a genuinely short
   * session, and the accident it guards against is already covered by nobody attending.
   *
   * The student mirror of this gate in `insights/compute-student.ts` is deliberately
   * STRICTER and must stay that way. See the comment there before harmonising them.
   */
  const empty = !(
    meta.slidesWithTranscript > 0 ||
    interactions.length > 0 ||
    attendanceSection.attendedCount > 0 ||
    decks.some((d) => d.slidesShown != null)
  )

  return {
    version: 1,
    empty,
    meta,
    decks,
    attendance: attendanceSection,
    participation,
    quizzes,
    polls,
    students,
    qa,
    struggleConcepts,
    aiNarrative: null,
    narrativeFailed: false,
  }
}
