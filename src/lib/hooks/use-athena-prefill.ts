'use client'

/**
 * The pre-fill handoff — design doc §14.4.
 *
 * Athena's shipped drive puts its payload in the URL (`?node=`, `?challenge=`)
 * because a key or an id is short and harmless there. A drafted sentence is
 * not: a question she wrote for the student is up to a few hundred characters
 * of prose, and a URL is the wrong home for it — it lands in browser history,
 * in the referer header, and in every access log between here and the CDN.
 *
 * So drafts travel out of band: the shell writes one entry to `sessionStorage`,
 * pushes the route, and the target surface takes it. Properties that follow,
 * all of them wanted:
 *
 *   • **Read once.** Taking it deletes it, so a draft can't reappear on a later
 *     visit to the same page.
 *   • **A handoff, not a saved draft.** It is scoped to the route she drove to
 *     and expires in two minutes. Without that, a proposal the student never
 *     acted on sat in storage until the tab closed — and the booking dialog
 *     mounts on page load, so coming back to the booking page later in the same
 *     session for an unrelated appointment found prose about their weak topics
 *     already in the note field, ready to be sent to their professor as their
 *     own words.
 *   • **Not persisted.** A refresh loses it, exactly like the run card. We do
 *     not resurrect a proposal the student walked away from, and nothing about
 *     it reaches the database until they submit the real form.
 *   • **Same tab only.** `sessionStorage`, not `localStorage` — a drive in one
 *     tab must not pre-fill a form in another.
 *
 * The draft is model-adjacent text going into a form the student will submit,
 * so consumers must render it as a controlled input VALUE and never as HTML,
 * and must never overwrite something the student has already typed.
 */

import { useEffect, useState } from 'react'

const KEY = 'athena-prefill'
/** Same-tab notification, for a surface that is already mounted when she
 *  drives — asking "what should I ask?" while sitting in the live class is the
 *  normal case, not the edge case. */
const EVENT = 'scholera:athena-prefill'

/** Which surface a draft is for. One per propose tool that drafts prose. */
export type PrefillKind = 'lc_question' | 'booking_note'

/** Two minutes: long enough to land, read and start typing; short enough that a
 *  proposal the student walked away from is gone. */
const TTL_MS = 120_000

export function writeAthenaPrefill(kind: PrefillKind, text: string, route: string): void {
  try {
    // `route` is the path she drove to, so a draft can only be claimed by the
    // page it was written for. `at` expires it.
    const path = route.split('?')[0]
    sessionStorage.setItem(KEY, JSON.stringify({ kind, text, path, at: Date.now() }))
  } catch {
    // Storage blocked (private mode, embedded webview). The drive still
    // happens; the student lands on the right page with an empty form, which
    // is a smaller loss than not going at all.
  }
  window.dispatchEvent(new CustomEvent(EVENT))
}

/** Take the pending draft for this surface, if there is one. Deletes it. */
function takePrefill(kind: PrefillKind): string | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      kind?: unknown
      text?: unknown
      path?: unknown
      at?: unknown
    }
    if (parsed?.kind !== kind || typeof parsed.text !== 'string') return null

    // Two reasons to refuse a draft. EXPIRED is also cleared, so a stale note
    // can't ambush a form later in the session. WRITTEN-FOR-ANOTHER-PAGE is only
    // refused, not cleared — the page it belongs to may mount later and claim it.
    // A missing/non-string path fails CLOSED (treated as another page): the check
    // reads as a scope guarantee, so an unscoped entry must not be claimable by
    // any page. Today only writeAthenaPrefill writes entries, so it always sets a
    // path — this just keeps the guard honest.
    const expired = typeof parsed.at !== 'number' || Date.now() - parsed.at > TTL_MS
    const elsewhere = typeof parsed.path !== 'string' || parsed.path !== window.location.pathname
    if (expired || elsewhere) {
      if (expired) sessionStorage.removeItem(KEY)
      return null
    }

    sessionStorage.removeItem(KEY)
    return parsed.text
  } catch {
    // A corrupt entry costs the student a pre-fill, never the page.
    return null
  }
}

/**
 * The draft Athena left for this surface, or null. Returns it once — the
 * consumer owns it from then on.
 */
/**
 * @param enabled Gate the read. Defaults true (take on mount). Pass the dialog's `open`
 *   where the consumer is ALWAYS MOUNTED and only toggles visibility: the TTL is
 *   evaluated at the moment of the read, so taking it at mount meant a draft stayed
 *   valid indefinitely as long as the dialog had not been opened yet — the 120s expiry
 *   simply never fired (#664). Reading on open evaluates the TTL when the student
 *   actually sees it, which is what the TTL is for.
 */
export function useAthenaPrefill(kind: PrefillKind, enabled = true): string | null {
  const [draft, setDraft] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    // Both arrival orders are real: she can drive to a page that then mounts
    // (the read below), or drive to the page the student is already on (the
    // event). Neither is the exception.
    const take = () => {
      const text = takePrefill(kind)
      if (text !== null) setDraft(text)
    }
    take()
    window.addEventListener(EVENT, take)
    return () => window.removeEventListener(EVENT, take)
  }, [kind, enabled])

  return draft
}
