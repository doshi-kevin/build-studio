// Pure helpers used to render aggregates client-side. The server is the
// authoritative computer (via the lc_responses_after_insert trigger) and
// pushes aggregate_updated events; these helpers exist so getRoomSnapshot
// callers can render counts immediately and so unit tests have a typed
// surface to assert against.

export interface PollChoice {
  id: string
  text: string
}

export interface PollAggregate {
  /** Map of choiceId → count. */
  counts: Record<string, number>
  total: number
}

export interface QuizAggregate {
  submissions: number
}

/**
 * Compute poll aggregate from a list of response rows. Each response is
 * either { choiceIds: string[] } (single/multiple-choice) or { text } (word cloud).
 * Word-cloud responses are bucketed by lowercased text.
 */
export function computePollAggregate(
  choices: PollChoice[],
  responses: Array<{ choiceIds?: string[]; text?: string }>,
): PollAggregate {
  const counts: Record<string, number> = {}
  for (const c of choices) counts[c.id] = 0

  let total = 0
  for (const r of responses) {
    if (r.choiceIds) {
      for (const cid of r.choiceIds) {
        if (cid in counts) counts[cid] += 1
        else counts[cid] = 1
      }
      total += 1
    } else if (r.text) {
      const key = r.text.trim().toLowerCase()
      counts[key] = (counts[key] ?? 0) + 1
      total += 1
    }
  }

  return { counts, total }
}

/**
 * Quiz aggregate: just the submission count. A future expansion could
 * include per-question correctness; that lives in scoring helpers, not
 * here.
 */
export function computeQuizAggregate(
  responses: Array<unknown>,
): QuizAggregate {
  return { submissions: responses.length }
}

/**
 * Score a single quiz response against the quiz's correct answers.
 * Returns a fraction in [0, 1].
 */
export function scoreQuizResponse(
  questions: Array<{ id: string; correctChoiceId: string }>,
  answers: Record<string, string>,
): number {
  if (questions.length === 0) return 0
  let correct = 0
  for (const q of questions) {
    if (answers[q.id] === q.correctChoiceId) correct += 1
  }
  return correct / questions.length
}
