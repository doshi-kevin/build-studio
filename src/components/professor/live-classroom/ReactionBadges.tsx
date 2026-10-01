// Professor's live pacing-reaction badges (#36). One pill per reaction kind
// with a non-zero count, color-coded by tone (red = students struggling,
// success = class is fine) so the professor can't miss it — including over the
// black fullscreen stage. Each pill pops on mount and re-pops whenever its
// count changes (the `key` includes the count) to catch peripheral vision.
// Counts decay on their own (see useReactions); renders nothing when quiet.

'use client'

import { motion } from 'framer-motion'
import { REACTION_KINDS } from '@/lib/live-classroom/reactions/reaction-kinds'
import type { ReactionCounts } from '@/lib/live-classroom/broadcast/use-reactions'
import { SPRING_SNAPPY } from '@/lib/motion'

// One treatment per tone, no light/dark fork. The `-muted` / `-muted-foreground`
// pairs carry through from :root onto the stage unchanged, where the tint sits
// 1.12–1.18:1 off the letterbox — present, but never the brightest object on a
// screen whose whole job is the slide. (On the old black stage the same :root
// tints measured 18:1 and glowed, which is why the stage scope used to fork
// them; it does not need to now. See globals.css.)
const TONE = {
  alert: 'border-destructive/30 bg-destructive-muted text-destructive-muted-foreground',
  positive: 'border-success/40 bg-success-muted text-success-muted-foreground',
} as const

export function ReactionBadges({ counts }: { counts: ReactionCounts }) {
  const active = REACTION_KINDS.filter((r) => counts[r.kind] > 0)
  if (active.length === 0) return null

  return (
    <div className="inline-flex items-center gap-1.5">
      {active.map(({ kind, label, Icon, tone }) => (
        <motion.span
          // Re-mount on count change so the pill re-pops and pulls the eye.
          key={`${kind}-${counts[kind]}`}
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          // SNAPPY, not POP: this remounts on every count change, so during a
          // burst (thirty students tapping "confused" at once) overshooting pops
          // overlap into continuous wobble in the professor's peripheral vision.
          // A signal that never stops moving stops being read.
          transition={SPRING_SNAPPY}
          title={`${counts[kind]} ${label.toLowerCase()}`}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE[tone]}`}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{label}</span>
          <span className="tabular-nums">{counts[kind]}</span>
        </motion.span>
      ))}
    </div>
  )
}
