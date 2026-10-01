'use client'

// The attendance code as the room sees it (#82).
//
// Two states, because the code has two jobs at different moments:
//
//   OVERLAY — at the start, over the title slide. Everyone is settling and looking up, so it
//   is enormous and unmissable. Not a separate "code slide": the professor would have to
//   click past it, and a blank screen reads as "is the projector broken?". Over the title
//   slide the room still sees what the lecture is while people filter in.
//
//   CHIP — for the rest of class, top-right. This is the half that matters for the student
//   who arrives late or whose laptop dropped: they can always read it off the wall without
//   the professor doing anything. It is bigger than "a chip" would suggest on purpose. The
//   people it serves are at the BACK, and legibility of a random code runs about 1:100 of
//   viewing distance to glyph height (prose gets away with 1:150 because the reader can guess
//   a word; four random characters give them nothing). At 4vw a 1080p projector on a 3.6m
//   screen throws roughly 100mm glyphs, which carries about 15m. The 2vw it started at died
//   around row three.
//
// Sized in vw/vh rather than rem: this is a wall at the far end of a lecture hall, not a
// laptop, so it has to scale with the projected surface.

import { KeyRound } from 'lucide-react'

interface ProjectorJoinCodeProps {
  code: string
  /** True until the professor starts the lecture; drives overlay vs chip. */
  showOverlay: boolean
}

export function ProjectorJoinCode({ code, showOverlay }: ProjectorJoinCodeProps) {
  if (!showOverlay) {
    return (
      <div
        className="pointer-events-none absolute right-[2.5vw] top-[2.5vw] z-30 flex items-center gap-[0.8vw] rounded-full bg-background/85 px-[1.4vw] py-[0.7vw] backdrop-blur"
        aria-label={`Attendance code ${code.split('').join(' ')}`}
      >
        {/* No "Code" label. At any size that fits beside the digits it is unreadable past the
            front rows, so it spent width without telling anyone anything. The icon carries it. */}
        <KeyRound className="h-[2vw] w-[2vw] text-muted-foreground" aria-hidden />
        <span className="font-mono text-[4vw] font-bold leading-none tracking-[0.15em] text-foreground">
          {code}
        </span>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/60 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-[2vh] px-[4vw] text-center">
        <div className="flex items-center gap-[1vw] text-muted-foreground">
          <KeyRound className="h-[2.4vw] w-[2.4vw]" aria-hidden />
          <span className="text-[1.8vw] font-medium uppercase tracking-[0.2em]">
            Attendance code
          </span>
        </div>
        {/* The code itself. Wide tracking so each character is read individually rather than
            as a word, which is how people mistype them. */}
        <p className="font-mono text-[14vw] font-bold leading-none tracking-[0.12em] text-foreground">
          {code}
        </p>
        <p className="text-[1.5vw] text-muted-foreground">
          Enter this in Scholera to be marked present
        </p>
      </div>
    </div>
  )
}
