/**
 * `modules.unlock_date` — the one place that decides what "not open yet" means.
 *
 * A module can be in three independent states, and confusing them has real cost:
 *   - `is_published = false`  → a draft. Students see nothing at all.
 *   - `unlock_date` in the future → published but NOT OPEN YET. This file.
 *   - `coverage_state = 'skipped'` → visible, just out of the progress percentage.
 *
 * Unlocking early is deliberately NOT a second flag: clearing the date IS the
 * unlock. A date plus an "open anyway" boolean would be four states, two of them
 * self-contradictory ("opens Aug 12" while visible), and every read path would
 * have to check both.
 *
 * Shared by the student roadmap loader (which strips a locked week's contents
 * server-side), the professor Modules board, and the roadmap card — so all three
 * agree on the same instant and print the same words.
 */

/**
 * Which of these modules aren't open yet — the set a caller uses to withhold
 * CONTENTS while still drawing the module itself.
 *
 * Both student surfaces keep a locked week on screen (dimmed, "Opens Aug 6") so the
 * course visibly continues past today, and both use this to scope the follow-up
 * items read to the open modules only. That's what keeps an unopened week's lecture
 * titles, file paths and signed URLs out of the payload — and it means nothing
 * downstream has to remember the rule.
 */
export function lockedModuleIds(
  modules: readonly { id: string; unlock_date?: string | null }[],
): Set<string> {
  const now = Date.now()
  const locked = new Set<string>()
  for (const m of modules) if (isUnlockPending(m.unlock_date, now)) locked.add(m.id)
  return locked
}

/**
 * The gate as a PostgREST `.or()` argument, for any student-path query that reads
 * `modules` and should not see a locked one AT ALL (as opposed to seeing it empty):
 * `.eq('is_published', true).or(openModuleFilter())`.
 *
 * Prefer this over filtering in JS whenever the query's own ids feed a second read
 * (items, files, signed URLs): a locked week can't reach `moduleIds`, so nothing
 * downstream has to remember the rule. The AI-tutor readers use it this way.
 *
 * The two student PAGES don't — they need the locked week on screen (dimmed, "Opens
 * Aug 6") and use `lockedModuleIds` to scope only the follow-up items read.
 *
 * Safe to interpolate: the value is a server-generated ISO instant, which contains
 * no `,`/`(`/`)` for PostgREST's `or=()` parser to split on, and never any client
 * input.
 *
 * **Every student-facing reader of `modules` needs this or `isUnlockPending`.** The
 * ones that get missed are the LLM context builders (the AI tutor's chat route and
 * its `getCourseContentForChat`) and the file/page render routes — they're the
 * highest-value payloads and they don't look like "listings".
 */
export function openModuleFilter(now: Date = new Date()): string {
  return `unlock_date.is.null,unlock_date.lte.${now.toISOString()}`
}

/** True when this module is published but its open date hasn't arrived. */
export function isUnlockPending(unlockDate: string | null | undefined, now: number = Date.now()): boolean {
  if (!unlockDate) return false
  const at = new Date(unlockDate).getTime()
  // An unparseable date must read as OPEN, never as locked: a bad value would
  // otherwise hide real material with no way for the professor to see why.
  return !Number.isNaN(at) && at > now
}

/**
 * "Opens Aug 12" — the label on a locked week, and on the professor's chip.
 *
 * Day precision on purpose: the professor set a release, not a bell, and a time
 * on the student's map would read as a deadline. The exact instant stays in the
 * module dialog, where they set it.
 *
 * The locale is PINNED, not `undefined`. Both callers render inside SSR'd client
 * components, and a runtime-resolved locale formats one way on the server and
 * another in the browser — which threw a real hydration error ("server rendered
 * HTML didn't match the client") on the Modules board. Matches the ~70 other
 * 'en-US' call sites in this codebase; the UI copy is English throughout.
 */
export function unlockLabel(unlockDate: string | null | undefined): string | null {
  if (!unlockDate) return null
  const d = new Date(unlockDate)
  if (Number.isNaN(d.getTime())) return null
  return `Opens ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}
