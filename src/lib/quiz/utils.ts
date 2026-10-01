/**
 * Quiz utility functions — pure helpers used across the quiz system.
 */

/** Fisher-Yates shuffle — returns a new shuffled array */
export function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

/** Format seconds as mm:ss or hh:mm:ss */
export function formatTime(seconds: number): string {
  if (seconds < 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * Remaining seconds for a live quiz countdown, computed from the server-assigned
 * `openedAt` (ISO 8601) and the quiz `totalSeconds`. Clamped to [0, totalSeconds]
 * so a skewed client clock can't show negative time or *more* than the limit:
 *   - client clock behind the server (elapsed < 0) → clamps to totalSeconds
 *   - client clock ahead / time elapsed → clamps down to 0
 * `nowMs` is injectable for testing; defaults to Date.now().
 */
export function quizTimeRemaining(
  openedAt: string | null,
  totalSeconds: number,
  nowMs: number = Date.now(),
): number {
  if (!openedAt) return totalSeconds
  const elapsed = Math.floor((nowMs - new Date(openedAt).getTime()) / 1000)
  return Math.min(totalSeconds, Math.max(0, totalSeconds - elapsed))
}

/** Get letter grade from percentage score */
export function getGradeLetter(score: number): string {
  if (score >= 93) return 'A'
  if (score >= 90) return 'A-'
  if (score >= 87) return 'B+'
  if (score >= 83) return 'B'
  if (score >= 80) return 'B-'
  if (score >= 77) return 'C+'
  if (score >= 73) return 'C'
  if (score >= 70) return 'C-'
  if (score >= 67) return 'D+'
  if (score >= 60) return 'D'
  return 'F'
}

/**
 * Count blank markers — standalone runs of 3+ underscores, e.g. `_____` — in
 * fill-in-the-blank question text. Used to check the markers line up with the
 * number of defined blanks.
 *
 * Requires 3+ underscores so it ignores markdown bold (`__word__`) and LaTeX
 * subscripts (`x_i`); the `\w` lookarounds additionally skip markdown bold-italic
 * (`___word___`), whose `___` delimiters sit flush against text — a real blank
 * stands alone (whitespace/punctuation/boundary on both sides). `\w` includes
 * `_`, so the engine can't start a match mid-run and count a flush `word_____`.
 */
export function countBlankMarkers(text: string): number {
  return (text.match(/(?<!\w)_{3,}(?!\w)/g) ?? []).length
}

/**
 * The single canonical sentence for a fill-in-the-blank marker/blank mismatch,
 * reused across the bank dialog (inline note + save toast), the wizard editor
 * (inline note), and the wizard publish validation — so the professor never
 * sees two different phrasings for the same problem.
 */
export function blankMarkerMismatchMessage(blankCount: number, markerCount: number): string {
  const blanks = `${blankCount} blank${blankCount === 1 ? '' : 's'} defined`
  const markers = `${markerCount} “_____” marker${markerCount === 1 ? '' : 's'} in the question text`
  return `${blanks} but ${markers}. They must match.`
}

/** Generate a unique ID */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for environments where crypto.randomUUID is unavailable
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** Get current ISO timestamp string */
export function nowISO(): string {
  return new Date().toISOString()
}

/**
 * True when a stored date carries no meaningful time-of-day — either a bare
 * `YYYY-MM-DD` or a timestamp sitting exactly on UTC midnight. The quiz due-date
 * picker is `type="date"`, so every due date it writes is one of these two.
 */
function isDateOnly(isoString: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(isoString) || /T00:00:00(\.000)?Z$/.test(isoString)
}

/**
 * Format a date string for display.
 *
 * A date-only value is formatted in UTC. Formatting UTC midnight in local time
 * rendered the PREVIOUS day for every timezone behind UTC — a quiz due
 * 2026-12-31 showed as "Due Dec 30, 2026" for every US student (#311). Values
 * that do carry a real time still format in the viewer's local zone.
 */
export function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(isDateOnly(isoString) ? { timeZone: 'UTC' } : {}),
  })
}

/**
 * The instant a due date actually expires, in epoch ms.
 *
 * A date-only due date means the END of that day, not its first instant. Treating
 * it as UTC midnight made a quiz "due Dec 31" stop accepting work on the evening
 * of Dec 30 for US students — it silently shortened every deadline by a day (#311).
 *
 * NOTE: end-of-day is resolved in UTC, not in the institution's local zone. That
 * fixes the reported bug for every timezone behind UTC, but a student in UTC+10
 * still loses part of their last day. Doing it exactly needs `institutions.timezone`
 * threaded through both this call and the client checks — deliberately left as a
 * follow-up rather than hardcoding one zone here.
 */
export function dueDeadlineMs(dueDate: string): number {
  const base = new Date(dueDate).getTime()
  if (Number.isNaN(base)) return NaN
  // +1 day −1ms → 23:59:59.999 UTC on the stated day.
  return isDateOnly(dueDate) ? base + 24 * 60 * 60 * 1000 - 1 : base
}

/** Whether a quiz's due date has passed. Shared so the "Past due" badge, the
 *  explanation gate, and the server's late check can't disagree. */
export function isPastDue(dueDate: string | null | undefined, now: number = Date.now()): boolean {
  if (!dueDate) return false
  const deadline = dueDeadlineMs(dueDate)
  return !Number.isNaN(deadline) && deadline < now
}

/** Format a date string with time */
export function formatDateTime(isoString: string): string {
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
