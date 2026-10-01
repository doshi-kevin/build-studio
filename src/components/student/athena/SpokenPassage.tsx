// What the professor SAID on a cited slide — the lead of the citation preview
// for a "said in class" citation (N1, athena-students.md §5).
//
// A spoken citation is evidence from the lecture transcript, so the panel opens
// on the words; the slide stays underneath (DocumentPagePreview's `lead` slot)
// because the words were said over it. Fetched on open rather than carried in
// the answer: the transcript is gated at read time (the room must have ended and
// "Catch me up" must still be on), and a passage is far too long to ride along
// with every chip the student might never click.

'use client'

import { useEffect, useState } from 'react'
import { Loader2, Quote } from 'lucide-react'
import { getSpokenPassage } from '@/app/(dashboard)/student/courses/[sectionId]/ai-tutor/actions'

/** Lines of the passage shown before the reader asks for the rest. A slide's
 *  row is everything said while it was up — `lc_append_transcription` keeps
 *  concatenating, up to 8,000 characters — so an unclamped quote pushes the
 *  slide the citation NAMES off the bottom of the panel after about ninety
 *  seconds of talking. The slides worth citing are the ones professors dwell
 *  on, so that is the common case, not the tail. */
const CLAMP_LINES = 12
/** Roughly what fills those lines in a ~27rem panel (~50 characters each). A
 *  character count, not a measured height: the alternative is a layout pass on
 *  every open to decide whether one button renders. Erring long only means the
 *  toggle appears on a passage that happened to fit. */
const CLAMP_CHARS = CLAMP_LINES * 50

export function SpokenPassage({
  sectionId,
  itemId,
  citedTitle,
  /** 1-based, as the citation prints it. */
  slide,
}: {
  sectionId: string
  itemId: string
  /** The deck title as the answer cited it — the key that finds the transcript. */
  citedTitle?: string
  slide: number
}) {
  const [state, setState] = useState<'loading' | 'done'>('loading')
  const [passage, setPassage] = useState<{ text: string; room?: string } | null>(null)
  const [expanded, setExpanded] = useState(false)

  /* No synchronous reset here — the call site keys this component on the target
     it is fetching, so a different citation remounts it with fresh state
     instead of showing the previous slide's words while the new ones load. */
  useEffect(() => {
    let cancelled = false
    getSpokenPassage(sectionId, slide, { title: citedTitle, itemId })
      .then((r) => {
        if (cancelled) return
        setPassage(r.text ? { text: r.text, room: r.room } : null)
        setState('done')
      })
      /* The action itself never rejects — but the CALL can (a dropped
         connection, a server action that 500s before its own try block). Landing
         on the "couldn't pull it up" line beats a spinner that runs for the rest
         of the session; the slide below is still the citation either way. */
      .catch(() => {
        if (!cancelled) setState('done')
      })
    return () => {
      cancelled = true
    }
  }, [sectionId, itemId, citedTitle, slide])

  // `role="status"` on the wrapper, not the spinner: the passage is what a
  // reader who has moved into this panel is waiting for, so its ARRIVAL is the
  // announcement, not the fact that a fetch started.
  const frame = (children: React.ReactNode) => (
    <div role="status" className="w-full rounded-2xl border border-border bg-muted/40 p-4">
      {children}
    </div>
  )

  if (state === 'loading') {
    return frame(
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Finding what was said…
      </div>,
    )
  }

  /* Nothing came back. NOT silence: the chip said "said in class" and the panel
     header repeats it, so a bare slide underneath reads as the app breaking its
     own promise. And silence would be the wrong claim anyway — a transcript
     under 20 words is never indexed (TRANSCRIPT_MIN_WORDS), so a spoken citation
     existing at all means words existed. What changed is our ability to show
     them: the professor turned the recap off, or the room is gone. */
  if (!passage) {
    return frame(
      <p className="text-sm text-muted-foreground">
        Couldn&apos;t pull up what was said here — the slide is below.
      </p>,
    )
  }

  const clamped = !expanded && passage.text.length > CLAMP_CHARS

  return frame(
    <blockquote>
      <div className="mb-2 flex min-w-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Quote className="h-3 w-3 shrink-0" aria-hidden />
        {/* Provenance only — the panel header already carries the slide number,
            and a long room name is the professor's own text, so it truncates
            rather than wrapping the eyebrow onto two ragged lines. */}
        <span className="truncate">{passage.room ? `Said in ${passage.room}` : 'Said in class'}</span>
      </div>
      <p
        className={`whitespace-pre-wrap text-sm leading-relaxed text-foreground ${
          clamped ? 'line-clamp-12' : ''
        }`}
      >
        {passage.text}
      </p>
      {passage.text.length > CLAMP_CHARS && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 rounded-xl text-xs font-semibold text-primary transition-colors hover:text-foreground"
        >
          {expanded ? 'Show less' : 'Show everything said'}
        </button>
      )}
    </blockquote>,
  )
}
