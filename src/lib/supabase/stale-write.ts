/**
 * The one message for a rejected stale write, plus the flag that lets a caller
 * treat it differently from an ordinary failure.
 *
 * Wording matters here more than in most errors, because this message asks the
 * reader to DO something. The first draft said "Reload the page to see their
 * version, then reapply your change" — which, from inside an open dialog, means
 * "discard everything you just typed". It now tells them to copy first.
 *
 * `conflict: true` travels with it so the form can keep the message on screen:
 * a conflict delivered as an auto-dismissing toast leaves the reader looking at a
 * filled-in form with no visible reason nothing saved, and if they glanced away
 * they'll conclude it worked. See .claude/rules/data-access.md (#724).
 */
export const STALE_WRITE_MESSAGE =
  'Someone else changed this while you were editing. Copy your changes, then reload to see their version.'

/** Shape returned by an action whose guarded update matched zero rows. */
export const staleWriteError = () => ({ error: STALE_WRITE_MESSAGE, conflict: true as const })
