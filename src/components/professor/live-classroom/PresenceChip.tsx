// Compact "live" / "N students present" pill shown above the deck. When the
// presence count isn't known yet (Phase 4 will wire Supabase Presence into
// useRoomChannel) we fall back to a calm "Live" indicator so the chip
// never looks broken or empty. The dot uses the success token — red reads as
// "error" or "recording" and we want a calm "everything's fine" signal.

'use client'

import { Users } from 'lucide-react'

interface Props {
  count?: number
}

/** No theme prop: over the fullscreen stage the `.lc-stage` scope re-points these
 *  same tokens (see globals.css), so one set of classes covers both surfaces. */
export function PresenceChip({ count }: Props) {
  const showCount = typeof count === 'number'

  return (
    <div className="inline-flex items-center gap-1.5">
      {/* Deliberately static, NOT `.lc-live-dot`. This chip is pinned in the
          control bar for the whole lecture; a dot pulsing for fifty minutes is
          noise the professor learns to ignore, which then costs the pulses that
          DO mean something (a new poll, the sync pill, the blanked projector).
          The ping is reserved for transient signals and for the projector, where
          a static dot couldn't distinguish "live" from "frozen". */}
      <span className="inline-flex h-2 w-2 rounded-full bg-success" aria-hidden />
      {showCount && (
        <>
          <span className="h-3 w-px bg-border" aria-hidden />
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Users className="h-3 w-3" aria-hidden />
            <span className="tabular-nums">{count}</span>
          </span>
        </>
      )}
    </div>
  )
}
