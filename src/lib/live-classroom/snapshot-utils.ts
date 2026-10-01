// Pure helpers for snapshot payloads. Kept OUT of snapshot.ts because that
// file carries the `'use server'` directive — which requires every export to
// be an async server action. stripQuizAnswers is a sync pure function, so it
// lives here and is imported by getRoomSnapshot (and unit-tested directly).

import type { SnapshotInteraction } from './snapshot'

/**
 * Remove quiz answers from an interaction before it goes to a student: strip
 * each question's correctChoiceId + explanation and drop the class report.
 * Students only ever get answers via the server-gated reveal paths (on close,
 * or revealAnswers after they've submitted) — never from the live payload.
 */
/**
 * Remove the human-readable TEXT of an interaction before it reaches the projector
 * (#648). The wall display deliberately shows no question stems or choice labels —
 * the whole room can read that screen — but the full text was still arriving in the
 * projector's snapshot JSON, with only ProjectorView's restraint keeping it off
 * screen. That made the invariant one refactor deep: a debug view, an "expand"
 * affordance, or a generic interaction renderer would turn it into a real exposure
 * with the class watching.
 *
 * Structure, ids and counts survive, so the projector can still render its
 * kind-keyed pill and any aggregate visuals. This is the projector ONLY — students
 * need the text to answer, so it stays in their (answer-stripped) payload.
 */
export function stripInteractionText(i: SnapshotInteraction): SnapshotInteraction {
  if (i.kind !== 'quiz' && i.kind !== 'poll') return i
  const payload = { ...(i.payload as Record<string, unknown>) }

  // Poll-shaped: a single question plus choices on the payload itself.
  delete payload.question
  delete payload.prompt

  // `delete` on a shallow copy, mirroring stripQuizAnswers below rather than
  // destructuring-to-omit, which leaves unused bindings the linter rejects.
  const scrubChoices = (choices: unknown) => {
    if (!Array.isArray(choices)) return choices
    return (choices as Array<Record<string, unknown>>).map((c) => {
      const copy = { ...c }
      delete copy.text
      delete copy.label
      return copy
    })
  }

  payload.choices = scrubChoices(payload.choices)

  // Quiz-shaped: questions[], each with its own stem and choices.
  if (Array.isArray(payload.questions)) {
    payload.questions = (payload.questions as Array<Record<string, unknown>>).map((q) => {
      const copy = { ...q }
      delete copy.prompt
      delete copy.text
      copy.choices = scrubChoices(copy.choices)
      return copy
    })
  }

  return { ...i, payload }
}

export function stripQuizAnswers(i: SnapshotInteraction): SnapshotInteraction {
  if (i.kind !== 'quiz') return i
  const payload = { ...(i.payload as Record<string, unknown>) }
  delete payload.report
  if (Array.isArray(payload.questions)) {
    payload.questions = (payload.questions as Array<Record<string, unknown>>).map((q) => {
      const copy = { ...q }
      delete copy.correctChoiceId
      delete copy.explanation
      return copy
    })
  }
  return { ...i, payload }
}

/**
 * Strip the asker's identity from an ANONYMOUS question before it leaves the server
 * (#658).
 *
 * askQuestion is deliberate about anonymity — it stores `authorName: null` and its own
 * comment calls keeping the name "a privacy regression" — but the row's `created_by` is
 * the real user id and reached every student unmodified. Non-anonymous questions carry
 * BOTH id and name in the same response, so a classmate could build a uuid→name map from
 * those and attribute every anonymous question whose created_by matched. `upvotedBy`
 * leaked who upvoted what the same way.
 *
 * Anonymous questions exist so a student can admit they are lost without their classmates
 * knowing; this made that identifiable to anyone who opened devtools. The professor's own
 * view is a separate product question — this strips for EVERY audience rather than
 * quietly deciding staff may see it.
 */
export function stripAnonymousAuthor(
  i: SnapshotInteraction,
  /** The viewer, so their OWN upvote state survives the redaction. */
  viewerId: string,
): SnapshotInteraction {
  if (i.kind !== 'question') return i
  const payload = { ...(i.payload as Record<string, unknown>) }

  /* `upvotedBy` is replaced, not deleted. QuestionList reads it to disable the button
     once you have voted (`upvotedBy.includes(currentUserId)`), so removing it outright
     would let a student upvote the same question repeatedly — trading a privacy leak for
     a correctness bug. Reduced to whether THIS viewer is in it: the UI keeps working and
     nobody learns who else voted. */
  const upvotedBy = Array.isArray(payload.upvotedBy) ? (payload.upvotedBy as string[]) : []
  payload.upvotedBy = upvotedBy.includes(viewerId) ? [viewerId] : []

  if (payload.anonymous !== true) return { ...i, payload }

  delete payload.authorName
  return { ...i, created_by: '', payload }
}
