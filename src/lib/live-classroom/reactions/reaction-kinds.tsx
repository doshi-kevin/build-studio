// Single source of truth for the pacing reactions (#36). Both the student
// reaction bar and the professor's live aggregate badges render from this
// ordered list, so labels/icons/order never drift between the two surfaces.

import { HelpCircle, Turtle, ThumbsUp, Rabbit, type LucideIcon } from 'lucide-react'
import type { ReactionKind } from '@/lib/live-classroom/broadcast/types'

export interface ReactionMeta {
  kind: ReactionKind
  /** Student-facing button label. */
  label: string
  Icon: LucideIcon
  /** Drives the professor badge color: 'alert' = students struggling (red,
   *  the prof should act), 'positive' = class is fine / wants to move (emerald). */
  tone: 'alert' | 'positive'
}

/** Display order for the student bar and the professor badges. */
export const REACTION_KINDS: ReactionMeta[] = [
  { kind: 'confused', label: 'Confused', Icon: HelpCircle, tone: 'alert' },
  { kind: 'slow_down', label: 'Slow down', Icon: Turtle, tone: 'alert' },
  { kind: 'got_it', label: 'Got it', Icon: ThumbsUp, tone: 'positive' },
  { kind: 'speed_up', label: 'Speed up', Icon: Rabbit, tone: 'positive' },
]
