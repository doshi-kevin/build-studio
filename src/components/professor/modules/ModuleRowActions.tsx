/**
 * The hover-revealed action cluster shared by module sections and item rows.
 *
 * Quiet at rest so a long list stays calm, but never unreachable: the actions
 * are always visible below `sm` (there is no hover on touch) and appear on
 * keyboard focus via `group-focus-within`. Each carries a real `aria-label`.
 * The previous build used bare `opacity-0 group-hover` plus a native `title`,
 * which made every row action invisible to touch and to assistive tech.
 *
 * Because they ARE the touch affordance below `sm`, the hit area grows to 44px
 * there while the glyph stays 14px — the visual density is a desktop choice,
 * the tap target is an accessibility floor. Destructive actions get extra
 * separation so a mis-tap lands on nothing rather than on Delete.
 *
 * Two class constants rather than one builder because Tailwind only sees
 * literal class strings — the `/section` variant scopes to the section header's
 * named group so an item row's hover doesn't reveal the section's controls.
 *
 * Type: Client Component
 */
'use client'

import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

const BASE = 'flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity'

/** For controls inside an item row (`group`). */
export const ROW_ACTIONS = `${BASE} sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100`

/** For controls on a section header (`group/section`). */
export const SECTION_ACTIONS = `${BASE} sm:opacity-0 sm:group-hover/section:opacity-100 sm:group-focus-within/section:opacity-100`

/**
 * Shared button chrome for hand-rolled icon controls on this surface.
 *
 * shadcn `Button` supplies a 3px focus ring; these don't, and the cluster is
 * invisible at rest with `group-focus-within` revealing it — so the ring is
 * the ONLY cue telling a keyboard user which of five adjacent circles they're
 * on. Matches button.tsx's contract deliberately.
 */
export const ICON_BUTTON =
  'flex items-center justify-center rounded-full text-muted-foreground transition-colors ' +
  'min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 p-2.5 sm:p-1.5 ' +
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

export function RowAction({
  icon: Icon,
  label,
  onClick,
  destructive,
  disabled,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  destructive?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        ICON_BUTTON,
        destructive
          ? // Pushed away from its benign neighbour — Delete is 2px from Edit
            // otherwise, and on touch both are permanently under the thumb.
            'ml-2 hover:bg-destructive-muted hover:text-destructive'
          : 'hover:bg-muted hover:text-foreground',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  )
}
