// Pure computation of the PII-FREE student Class Insights blob from the same
// raw session rows the professor report uses. Everything here is safe for any
// enrolled student to read: quiz content (questions + correct answers +
// explanations), class-level aggregates SUPPRESSED below STUDENT_MIN_RESPONDENTS,
// and concept accuracy. It deliberately produces NO names, NO attendance,
// NO absentees, and NO who-answered-what — a student's own numbers are
// computed live from their own responses at view time, never stored here.
//
// The AI parts (summary, flashcards, practiceQuiz) are added by the
// orchestrator after this runs; here they start null.

import { conceptKey, mergeConcepts, type SessionReportInput } from '@/lib/live-classroom/report/compute'
import {
  STUDENT_MIN_RESPONDENTS,
  type StudentInsightsContent,
  type StudentInsightQuiz,
  type StudentInsightConcept,
} from '@/lib/validations/lc-class-insights'

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

interface PayloadQuestion {
  id: string
  prompt: string
  choices: Array<{ id: string; text: string }>
  correctChoiceId: string
  concept?: string
  explanation?: string
}

export function computeStudentInsights(input: SessionReportInput): StudentInsightsContent {
  const { decks: deckInputs, interactions, responses } = input

  // ── Meta (no identities) ──
  const slidesWithTranscript = deckInputs.reduce(
    (s, d) => s + d.transcriptions.filter((t) => t.text.trim().length > 0).length,
    0,
  )
  const slideCount = deckInputs.reduce<number | null>(
    (s, d) => (d.pageCount != null ? (s ?? 0) + d.pageCount : s),
    null,
  )
  const startedMs = new Date(input.room.createdAt).getTime()
  const endedMs = input.room.endedAt ? new Date(input.room.endedAt).getTime() : startedMs

  // ── Quizzes: full review content + suppressed class accuracy ──
  const conceptTally = new Map<string, { correct: number; total: number }>()
  // Distinct students per concept, keyed by conceptKey() — the same identity
  // mergeConcepts() groups by. Suppression MUST count people, not answers: one
  // student answering enough questions on a topic would otherwise clear the
  // threshold and publish what is really their own accuracy to the class.
  const conceptRespondents = new Map<string, Set<string>>()

  const quizzes: StudentInsightQuiz[] = interactions
    .filter((i) => i.kind === 'quiz')
    .map((i) => {
      const rawQuestions = (i.payload.questions ?? []) as PayloadQuestion[]
      const questions = rawQuestions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        choices: (q.choices ?? []).map((c) => ({ id: c.id, text: c.text })),
        correctChoiceId: q.correctChoiceId,
        concept: q.concept ?? 'General',
        explanation: q.explanation ?? '',
      }))
      const correctById = new Map(questions.map((q) => [q.id, { correct: q.correctChoiceId, concept: q.concept }]))

      const mine = responses.filter((r) => r.interaction_id === i.id)
      const respondentCount = new Set(mine.map((r) => r.student_id)).size
      let totalAnswers = 0
      let totalCorrect = 0
      for (const resp of mine) {
        const answers = (resp.response as { answers?: Record<string, string> })?.answers ?? {}
        for (const [qid, choiceId] of Object.entries(answers)) {
          const q = correctById.get(qid)
          if (!q) continue
          totalAnswers++
          const key = conceptKey(q.concept)
          const respondents = conceptRespondents.get(key) ?? new Set<string>()
          respondents.add(resp.student_id)
          conceptRespondents.set(key, respondents)
          const tally = conceptTally.get(q.concept) ?? { correct: 0, total: 0 }
          tally.total++
          const isCorrect = choiceId === q.correct
          if (isCorrect) {
            totalCorrect++
            tally.correct++
          }
          conceptTally.set(q.concept, tally)
        }
      }

      const suppressed = respondentCount < STUDENT_MIN_RESPONDENTS
      return {
        interactionId: i.id,
        title: (i.payload.title as string) || 'Quiz',
        questions,
        respondentCount,
        classAccuracy: suppressed ? null : pct(totalCorrect, totalAnswers),
        comparisonSuppressed: suppressed,
      }
    })

  // ── Concepts: class accuracy, suppressed below the threshold ──
  const concepts: StudentInsightConcept[] = mergeConcepts(
    Array.from(conceptTally.entries()).map(([concept, { correct, total }]) => ({
      concept,
      correctCount: correct,
      totalCount: total,
      correctRate: pct(correct, total),
    })),
  )
    .map((c) => {
      // Distinct students who answered anything tagged with this concept — NOT the
      // answer tally, which one student can inflate on their own.
      const respondentCount = conceptRespondents.get(conceptKey(c.concept))?.size ?? 0
      const suppressed = respondentCount < STUDENT_MIN_RESPONDENTS
      return {
        concept: c.concept,
        correctRate: suppressed ? null : c.correctRate,
        respondentCount,
        suppressed,
      }
    })
    .sort((a, b) => (a.correctRate ?? 101) - (b.correctRate ?? 101))

  /**
   * DELIBERATELY STRICTER than the professor gate in `report/compute.ts`, and it must
   * stay that way — do not "harmonise" the two (#563).
   *
   * They answer different questions. The professor report is operational: who came, for
   * how long, how far through the deck, all useful on their own. The study pack is
   * academic: with no transcript and no quiz there is genuinely nothing to study, and
   * the empty branch of `StudentInsightsView` already offers the two things that DO
   * survive — the recording and the student's own notes. Loosening this would swap a
   * clean "Nothing to study here" for a card announcing that no audio was captured,
   * followed by nothing.
   */
  const empty = slidesWithTranscript === 0 && interactions.length === 0

  /* Whether the LLM extras are actually coming, which is NOT the same as "this session
     isn't empty". `generate.ts` skips every LLM call when the session has no lecture
     material, because an empty context makes the model hallucinate. A quiz-only session
     was therefore written with extrasPending=true and patched to false a moment later,
     which cost the student a spinner for extras that were never going to arrive — and if
     the patch never landed (a crash between the two writes) the row sat at `ready` with
     extrasPending true forever. The client's poll only gives up after consecutive fetch
     FAILURES, so a successful "still pending" spins indefinitely.

     The predicate has to be a safe OVER-approximation, and only one is available here.
     `hasLectureMaterials` accepts extracted slide text as well as audio, and that text
     lives in `lc_decks.extraction`, a column this function is never handed — so
     `slidesWithTranscript` alone would under-predict for a deck with text but no audio,
     and under-predicting is the harmful direction: the client stops polling and the
     student never sees extras that did generate. With zero decks, though,
     `buildSessionLectureContext` iterates nothing and provably returns empty strings,
     so that case is safe to call. Anything else keeps the old optimistic answer. */
  const extrasPending = !empty && (slidesWithTranscript > 0 || deckInputs.length > 0)

  return {
    version: 1,
    empty,
    extrasPending,
    // Set by the orchestrator (generate.ts) once it builds the lecture context;
    // the deterministic compute can't yet know whether material exists for the LLM.
    noMaterials: false,
    meta: {
      durationMinutes: Math.max(0, Math.round((endedMs - startedMs) / 60000)),
      slideCount,
      slidesWithTranscript,
      deckCount: deckInputs.length,
    },
    quizzes,
    concepts,
    summary: null,
    summaryFailed: false,
    flashcards: null,
    flashcardsFailed: false,
    practiceQuiz: null,
    practiceQuizFailed: false,
  }
}
