/**
 * DividerRule — the visual of a module-level divider: a rule either side of an
 * uppercase label.
 *
 * Shared because both roles render the same break in the same order — the
 * professor's is draggable and editable, the student's is the plain label. The
 * `leading`/`trailing` slots are where the professor board hangs its grip and
 * its action cluster; the student page passes neither, so the label centres
 * itself between two full-width rules.
 */

import { cn } from '@/lib/utils'

interface DividerRuleProps {
  title: string
  /** Grip or saving spinner, ahead of the first rule. */
  leading?: React.ReactNode
  /** Action cluster, after the second rule. */
  trailing?: React.ReactNode
  className?: string
}

export function DividerRule({ title, leading, trailing, className }: DividerRuleProps) {
  return (
    /* More room above than below: the label introduces what FOLLOWS it, and
       symmetric spacing between two cards refuses to say which side it owns. */
    <div className={cn('flex items-center gap-2 pt-5 pb-1', className)}>
      {leading}
      {/* Lighter than the cards' own `border-border` so the list's dominant
          structure stays the cards, not three equal-weight lines 20px apart.
          `min-w-3` keeps the divider metaphor alive once the label is long. */}
      <div className="h-px min-w-3 flex-1 bg-border/60" />
      {/* Truncates like every other title on this surface — the 40-char cap the
          dialog allows needs ~320px, which a phone doesn't have once the
          professor's controls take their 44px each. */}
      <span
        className="min-w-0 truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        title={title}
      >
        {title}
      </span>
      <div className="h-px min-w-3 flex-1 bg-border/60" />
      {trailing}
    </div>
  )
}
