// The entry pill — Athena while she's closed (dock v2, prototype variant 01).
//
// It replaces the old "Athena" button, and the difference is the point: this is
// not a button that opens an empty chat. It is parked exactly where the docked
// composer will land (right 16px / bottom 16px / radius 16px), sits dim until
// the pointer comes near, and WIDENS into a real mini composer on hover. The
// tide disc is a real button: click it and she opens with whatever's typed, or
// with nothing at all — typing first is optional, not required. Enter (and ⌘K,
// kept undiscoverable on purpose — it was never the only way in) do the same.
//
// Geometry, glass and the tide disc live in globals.css (.athena-pill,
// .athena-tide); only the proximity wake-up and the tide's click need JS.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/** How close the pointer gets before she brightens. */
const NEAR_PX = 120

export function AthenaEntryPill({
  courseCode,
  onSubmit,
}: {
  courseCode: string
  /** Empty string ⇒ open on a fresh chat; text ⇒ open with it already sent. */
  onSubmit: (text: string) => void
}) {
  const pillRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [near, setNear] = useState(false)
  const [value, setValue] = useState('')

  // Proximity wake-up. A padded hover halo would have done this in pure CSS but
  // it swallows clicks meant for the app underneath, so measure the distance
  // instead and leave the pill's own box as the only hit target.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const r = pillRef.current?.getBoundingClientRect()
      if (!r) return
      const dx = Math.max(r.left - e.clientX, e.clientX - r.right, 0)
      const dy = Math.max(r.top - e.clientY, e.clientY - r.bottom, 0)
      setNear(Math.hypot(dx, dy) < NEAR_PX)
    }
    document.addEventListener('pointermove', onMove)
    return () => document.removeEventListener('pointermove', onMove)
  }, [])

  const submit = useCallback(() => {
    const text = value.trim()
    setValue('')
    inputRef.current?.blur()
    onSubmit(text)
  }, [value, onSubmit])

  // ⌘K / ⌘J is the send, and it lives here rather than in the shell because the
  // pill is the only thing that knows what's been typed into it. Nothing typed ⇒
  // it opens her on a fresh chat, which is still a valid gesture. The pill only
  // exists while she's closed, so this shortcut is only ever the OPEN one — the
  // shell owns it from there.
  //
  // It does NOT fire while the student is typing somewhere else. ⌘K is a browser
  // key (Firefox focuses its search bar), and claiming it page-wide meant a
  // student mid-sentence in an assignment field lost the keystroke to a chat
  // opening on top of them. Our own field is exempt: it handles Enter itself and
  // ⌘K there is unambiguous.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (!(e.metaKey || e.ctrlKey) || (key !== 'k' && key !== 'j')) return
      const el = document.activeElement
      const typingElsewhere =
        el instanceof HTMLElement &&
        el !== inputRef.current &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typingElsewhere) return
      e.preventDefault()
      submit()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [submit])

  return (
    /* Absolute (not fixed): the host is the content column, and the pill has to
       land on the composer's exact footprint inside it.

       Raised on small screens (#640): in a live class at 390px this pill sat on top
       of the student's "Participate" control — a 48-point hit-test across that
       button's own box resolved 41 points to the pill, so ~85% of it was untappable
       and tapping its centre opened Athena. Participate is how a student answers
       polls, takes quizzes and asks questions, and phones are where students are, so
       the pill yields. The collision is mobile-only — the desktop Participate is a
       separate inline button — hence the lg: reset rather than moving it for
       everyone. */
    <div className="absolute bottom-20 right-4 z-40 lg:bottom-4">
      <div
        ref={pillRef}
        className="athena-pill"
        data-near={near ? 'true' : undefined}
        /* The shortcut's only on-screen home now that the ⌘K chip is gone. A
           native tooltip costs no layout on a 10rem box and appears on exactly
           the hover-dwell that already widens it — where a chip cost width and
           read as clutter. Without this the accelerator was undiscoverable to
           everyone except screen-reader users (aria-keyshortcuts, below). */
        title="Ask Athena — ⌘K"
        // The whole pill is the text affordance — clicking anywhere focuses the
        // field, which is what makes hover-to-widen work on touch too.
        onClick={() => inputRef.current?.focus()}
      >
        <button
          type="button"
          className="athena-tide"
          aria-label="Open Athena"
          title="Open Athena"
          // Stop the parent's onClick from also firing (it focuses the input) —
          // this button already did the thing focusing was a means to.
          onClick={(e) => {
            e.stopPropagation()
            submit()
          }}
        />
        <span className="athena-pill-label" aria-hidden>
          Ask Athena
        </span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              // Blur only — the text STAYS. Escape is a reflex, and wiping a
              // half-written prompt with no undo is worse than leaving the pill
              // holding it. (It used to clear the value anyway, directly against
              // this comment.)
              e.stopPropagation()
              inputRef.current?.blur()
            }
          }}
          className="athena-pill-input"
          placeholder={`Ask Athena anything about ${courseCode}…`}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
          // Nothing on screen advertises the shortcut (the ⌘K chip was visual
          // noise on a box this small), so this is the only way anyone learns it
          // exists.
          aria-label="Ask Athena"
          aria-keyshortcuts="Meta+K Control+K Meta+J Control+J"
        />
      </div>
    </div>
  )
}
