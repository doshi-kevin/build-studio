// Maps a mastery tier to the app's semantic token classes (no raw colors).
// The design system's destructive/warning/success tokens are defined for exactly
// these score bands (<60 / ≥60 / ≥80); "none" uses muted.

import type { MasteryTier } from '@/lib/skills/mastery'

export interface TierStyle {
  dot: string
  text: string
  bar: string
  badge: string
}

export const TIER_STYLES: Record<MasteryTier, TierStyle> = {
  weak: {
    dot: 'bg-destructive',
    text: 'text-destructive',
    bar: 'bg-destructive',
    badge: 'bg-destructive-muted text-destructive-muted-foreground',
  },
  shaky: {
    dot: 'bg-warning',
    text: 'text-warning-muted-foreground',
    bar: 'bg-warning',
    badge: 'bg-warning-muted text-warning-muted-foreground',
  },
  strong: {
    dot: 'bg-success',
    text: 'text-success-muted-foreground',
    bar: 'bg-success',
    badge: 'bg-success-muted text-success-muted-foreground',
  },
  none: {
    dot: 'bg-muted-foreground/40',
    text: 'text-muted-foreground',
    bar: 'bg-muted-foreground/30',
    badge: 'bg-muted text-muted-foreground',
  },
}
