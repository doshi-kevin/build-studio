import 'server-only'

/**
 * Which scheduled draft quizzes are actually allowed to go live.
 *
 * Scheduled publish has THREE writers — the professor quiz list, the student quiz
 * list, and a pg_cron job — and the "must have questions" rule was originally
 * added to only one of them, so a question-less quiz still reached students by
 * whichever path ran first (#311). This is the single copy both server paths call;
 * the cron path enforces the same rule in SQL (see the migration that recreates
 * `schedule_quiz_publish`).
 *
 * The rule mirrors `publishQuiz` exactly: at least one question, and none of them
 * incomplete. A quiz that fails it stays a draft WITH its schedule intact, so it
 * publishes on its own once the professor finishes the questions.
 */
export async function selectPublishableScheduledQuizIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  nowISO: string,
): Promise<{ eligibleIds: string[]; heldBack: number }> {
  const { data: dueRows, error: dueErr } = await adminDb
    .from('quizzes')
    .select('id')
    .eq('section_id', sectionId)
    .eq('status', 'draft')
    .not('scheduled_publish_at', 'is', null)
    .lte('scheduled_publish_at', nowISO)

  if (dueErr) throw dueErr

  const dueIds: string[] = (dueRows ?? []).map((q: { id: string }) => q.id)
  if (dueIds.length === 0) return { eligibleIds: [], heldBack: 0 }

  const { data: assignments } = await adminDb
    .from('quiz_question_assignments')
    .select('quiz_id, question:quiz_questions(is_complete)')
    .in('quiz_id', dueIds)

  const questionCount = new Map<string, number>()
  const incomplete = new Set<string>()
  for (const a of (assignments ?? []) as Array<{
    quiz_id: string
    question: { is_complete?: boolean } | { is_complete?: boolean }[] | null
  }>) {
    questionCount.set(a.quiz_id, (questionCount.get(a.quiz_id) ?? 0) + 1)
    const q = Array.isArray(a.question) ? a.question[0] : a.question
    if (q && q.is_complete === false) incomplete.add(a.quiz_id)
  }

  const eligibleIds = dueIds.filter(
    (id) => (questionCount.get(id) ?? 0) > 0 && !incomplete.has(id),
  )
  return { eligibleIds, heldBack: dueIds.length - eligibleIds.length }
}
