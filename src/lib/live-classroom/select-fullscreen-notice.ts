// Picks which pending poll/quiz to surface as the in-fullscreen banner.
// Q&A questions are filtered out (only response-required prompts qualify),
// dismissed entries are skipped, and the most-recently opened wins so a
// stale prompt doesn't outrank a fresh one when the prof stacks them.
//
// Also exposes the snapshot → candidate mapping used by StudentClassroomView,
// so the kind/title/opened_at projection (which differs per kind) is testable
// without mounting the React tree.

export interface FullscreenNoticeCandidate {
  id: string
  kind: 'poll' | 'quiz' | 'question'
  title: string
  opened_at: string | null
}

export function selectFullscreenNotice<T extends FullscreenNoticeCandidate>(
  candidates: readonly T[],
  dismissedIds: ReadonlySet<string>,
): T | null {
  const eligible = candidates.filter(
    (c) => (c.kind === 'poll' || c.kind === 'quiz') && !dismissedIds.has(c.id),
  )
  if (eligible.length === 0) return null
  return eligible.slice().sort((a, b) => {
    const at = a.opened_at ? new Date(a.opened_at).getTime() : 0
    const bt = b.opened_at ? new Date(b.opened_at).getTime() : 0
    return bt - at
  })[0]
}

// Minimal slice of SnapshotInteraction the mapping needs. Kept structural so
// the full snapshot type can flow in without an explicit cast.
export interface PendingInteractionSource {
  id: string
  kind: 'poll' | 'quiz' | 'question'
  status: 'draft' | 'open' | 'closed'
  payload: Record<string, unknown>
  opened_at: string | null
}

/**
 * Projects open SnapshotInteractions into FullscreenNoticeCandidates,
 * dropping anything the student has already responded to.
 *
 * Title source differs per kind:
 *   - poll:  payload.question (the prompt is the headline)
 *   - quiz:  payload.title    (questions live in payload.questions[])
 *   - question (Q&A): payload.title — included for completeness, but the
 *                     selector filters questions out before they reach the
 *                     banner anyway.
 *
 * Falls back to a kind-appropriate generic ("Quiz" / "Poll") when payload
 * is missing the expected field, so the banner never renders blank.
 */
export function computePendingFullscreenInteractions(
  openInteractions: readonly PendingInteractionSource[],
  respondedIds: ReadonlySet<string>,
): FullscreenNoticeCandidate[] {
  return openInteractions
    .filter((i) => i.status === 'open' && !respondedIds.has(i.id))
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      title:
        (i.kind === 'poll'
          ? (i.payload?.question as string | undefined)
          : (i.payload?.title as string | undefined)) ??
        (i.kind === 'quiz' ? 'Quiz' : 'Poll'),
      opened_at: i.opened_at ?? null,
    }))
}
