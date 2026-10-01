'use client'

/**
 * Decides which chat messages are ARRIVALS — something that turned up without
 * the reader doing anything — and therefore earn an entrance animation.
 *
 * Everything else does not animate. Per the frequency rule in `src/lib/motion.ts`,
 * a thread you scroll through is a scan surface, and replaying a hundred old
 * messages every time you open a conversation is the exact reflex that makes an
 * interface feel generated.
 *
 * Lives here rather than inside a component because two different ChatArea
 * implementations need it, and when this logic was pasted into both it drifted
 * within a single commit.
 */

import { useState } from 'react'

/**
 * The rule, as a pure function so it can be tested without rendering anything.
 * Each clause exists because of a specific bug found in browser QA:
 *
 *  · `isOwn` — a message you sent is never an arrival, however new its id looks.
 *    When the server confirms a send, `optimistic-<n>` is replaced by a real
 *    UUID; that id is the React key, so the row unmounts and remounts. Without
 *    this the remounted row looked unseen and last, and replayed its whole
 *    entrance from invisible: a blink on every single send.
 *
 *  · `seen === null` — nothing animates before the first fetch settles, so a
 *    thread's existing scrollback never animates on open.
 *
 *  · `id === lastId` — an arrival must be at the END of the thread. This is what
 *    keeps "Load older messages" quiet: fifty older messages are equally unseen,
 *    but they prepend, and animating half a thread because someone scrolled up
 *    is the opposite of the point. Compared by id rather than index because the
 *    rows render inside a nested group map, where an indexOf per row would make
 *    a long thread quadratic.
 *
 * Known limitation: when several messages land in one tick (a reconnect burst),
 * only the last one animates and its siblings appear instantly. Rare, and
 * cosmetic — worth revisiting only if it is actually noticeable in use.
 */
export function isMessageArrival(
  id: string,
  isOwn: boolean,
  seen: ReadonlySet<string> | null,
  lastId: string | null,
): boolean {
  if (isOwn) return false
  if (seen === null) return false
  if (seen.has(id)) return false
  return id === lastId
}

/**
 * Tracks which messages were already on screen when the current thread loaded,
 * and returns the predicate above bound to that state.
 *
 * Both state updates happen during render rather than in an effect. An effect
 * runs a frame too late: the scrollback would flash once before it could be
 * marked as old. This is React's documented "adjust state while rendering"
 * pattern, and the same one `GenerationProgress` already uses in this codebase.
 *
 * Reseeding is keyed on `loading` going back up, which is what a thread switch
 * does. Without that, a ChatArea reused across conversations keeps the FIRST
 * conversation's ids forever, and every conversation opened after it animates
 * its newest row on load.
 */
export function useMessageArrivals(
  messages: readonly { id: string }[],
  loading: boolean,
): (id: string, isOwn: boolean) => boolean {
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null)
  const [wasLoading, setWasLoading] = useState(loading)

  if (loading !== wasLoading) {
    setWasLoading(loading)
    // A new thread began fetching: forget the previous thread's scrollback.
    if (loading) setSeen(null)
  }
  if (seen === null && !loading) {
    setSeen(new Set(messages.map((m) => m.id)))
  }

  const lastId = messages.length > 0 ? messages[messages.length - 1].id : null
  return (id: string, isOwn: boolean) => isMessageArrival(id, isOwn, seen, lastId)
}
