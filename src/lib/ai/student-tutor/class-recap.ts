// Live-class recap for Athena (N4, athena-students.md §9 / U16): "what did I
// miss in Tuesday's class?" answered from data the student can already see in
// the app — the PII-free study pack (lc_class_insights_student: transcript-
// derived summary, concepts, quiz review with suppressed class aggregates),
// their OWN responses (lc_responses, self-scoped), their OWN notes (lc_notes),
// and whether they attended (lc_attendance). Nothing here reaches another
// student's data: the pack is aggregate-suppressed by construction, and every
// per-student read filters on the verified caller's id.
//
// Gate mirrors the app's insights page: ended rooms of the verified section,
// enrolled caller — the same two checks the caller's route already ran. Rooms
// without a ready study pack (e.g. a cancelled scheduled session) simply don't
// appear, which also keeps "nothing happened" sessions out of the recap.

import 'server-only'

import { logger } from '@/lib/logger'
import type { StudentInsightsContent } from '@/lib/validations/lc-class-insights'
import type { AdminDb } from './contract'

/** Recent classes only — a recap is about catching up, not the whole term
 *  (term-wide review is the study-focus tool's job). */
const MAX_SESSIONS = 3
const MAX_MISSED_PER_QUIZ = 3
const MAX_SUMMARY_CHARS = 1500
const MAX_NOTES_CHARS = 800

export interface RecapQuiz {
  title: string
  /** "2/3 correct" — or "not answered" when the student never responded. */
  myResult: string
  /** Class % correct, already suppression-gated upstream (null = suppressed). */
  classAccuracy: number | null
  /** The student's own wrong answers, question + theirs vs correct. */
  missed: Array<{ question: string; myAnswer: string; correctAnswer: string }>
}

export interface ClassRecap {
  inClass: string
  onDate: string | null
  /** False = they have no attendance row for the session — the "you missed
   *  this" case the recap exists for. */
  attended: boolean
  /** The pack's lecture summary (transcript-derived); null while pending or
   *  when the session had no usable lecture material. */
  summary: string | null
  concepts: string[]
  quizzes: RecapQuiz[]
  /** The student's OWN in-class notes, verbatim (theirs to see). */
  myNotes: string | null
}

interface RoomJoin {
  name: string | null
  status: string | null
  ended_at: string | null
  created_at: string | null
  section_id: string | null
  lecture_summary_enabled: boolean | null
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const single = (v: any) => (Array.isArray(v) ? v[0] : v)

const clamp = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`

/**
 * The most recent finished classes, newest first, each shaped for the model to
 * recap from. Returns `[]` — never a hedge — when no class has a study pack yet.
 */
export async function fetchClassRecaps(
  adminDb: AdminDb,
  sectionId: string,
  userId: string,
): Promise<ClassRecap[]> {
  const { data, error } = await adminDb
    .from('lc_class_insights_student')
    .select(
      'room_id, content, lc_rooms!inner(name, status, ended_at, created_at, section_id, lecture_summary_enabled)',
    )
    .eq('status', 'ready')
    .eq('lc_rooms.section_id', sectionId)
    .eq('lc_rooms.status', 'ended')
    .order('generated_at', { ascending: false })
    .limit(MAX_SESSIONS)

  if (error) {
    logger.error('fetchClassRecaps: pack read failed', error, { sectionId })
    return []
  }

  const rows = (data ?? []) as Array<{ room_id: string; content: StudentInsightsContent | null; lc_rooms: RoomJoin | RoomJoin[] | null }>
  const roomIds = rows.map((r) => r.room_id)
  if (roomIds.length === 0) return []

  // Everything per-student in one pass, all filtered on the verified caller.
  const quizIds = rows.flatMap((r) => (r.content?.quizzes ?? []).map((q) => q.interactionId))
  const [attendanceRes, notesRes, responsesRes] = await Promise.all([
    adminDb.from('lc_attendance').select('room_id').eq('student_id', userId).in('room_id', roomIds),
    adminDb.from('lc_notes').select('room_id, content').eq('student_id', userId).in('room_id', roomIds),
    quizIds.length
      ? adminDb.from('lc_responses').select('interaction_id, response').eq('student_id', userId).in('interaction_id', quizIds)
      : Promise.resolve({ data: [] }),
  ])
  const attendedRooms = new Set(((attendanceRes.data ?? []) as Array<{ room_id: string }>).map((a) => a.room_id))
  const notesByRoom = new Map(
    ((notesRes.data ?? []) as Array<{ room_id: string; content: string | null }>).map((n) => [n.room_id, n.content ?? '']),
  )
  const myAnswersByQuiz = new Map<string, Record<string, string>>()
  for (const r of (responsesRes.data ?? []) as Array<{ interaction_id: string; response: { answers?: Record<string, string> } | null }>) {
    myAnswersByQuiz.set(r.interaction_id, r.response?.answers ?? {})
  }

  const recaps: ClassRecap[] = []
  for (const row of rows) {
    const room = single(row.lc_rooms)
    const content = row.content
    if (!room || !content || content.empty) continue

    const quizzes: RecapQuiz[] = (content.quizzes ?? []).map((quiz) => {
      const mine = myAnswersByQuiz.get(quiz.interactionId)
      const choiceText = (q: (typeof quiz.questions)[number], choiceId: string): string =>
        q.choices.find((c) => c.id === choiceId)?.text ?? 'unknown'
      let answered = 0
      let correct = 0
      const missed: RecapQuiz['missed'] = []
      for (const q of quiz.questions) {
        const my = mine?.[q.id]
        if (my === undefined) continue
        answered++
        if (my === q.correctChoiceId) correct++
        else if (missed.length < MAX_MISSED_PER_QUIZ) {
          missed.push({
            question: clamp(q.prompt, 200),
            myAnswer: choiceText(q, my),
            correctAnswer: choiceText(q, q.correctChoiceId),
          })
        }
      }
      return {
        title: quiz.title,
        myResult: answered > 0 ? `${correct}/${answered} correct` : 'not answered',
        classAccuracy: quiz.classAccuracy,
        missed,
      }
    })

    const notes = notesByRoom.get(row.room_id)?.trim()
    const when = room.ended_at ?? room.created_at
    // The pack's summary is written FROM the transcript, so it honours the same
    // replay toggle the spoken surfaces do (G14) — a professor who declined to
    // have their words played back declined it here too. Null predates the
    // column and means on. Everything else in the recap (quiz review, concepts,
    // the student's own answers and notes) is not their speech, so it stays.
    const replayOff = room.lecture_summary_enabled === false
    recaps.push({
      inClass: room.name?.trim() || 'a live class',
      onDate: when ? String(when).slice(0, 10) : null,
      attended: attendedRooms.has(row.room_id),
      summary: content.summary && !replayOff ? clamp(content.summary, MAX_SUMMARY_CHARS) : null,
      concepts: (content.concepts ?? []).map((c) => c.concept),
      quizzes,
      myNotes: notes ? clamp(notes, MAX_NOTES_CHARS) : null,
    })
  }
  return recaps
}
