/**
 * DeadEnd -- the shared surface for a route the user cannot use. Two variants:
 *
 *  - `missing` (default): the thing isn't there -- a nonexistent record, a
 *    resource owned by another institution, a course they aren't enrolled in,
 *    a revoked link. Compass icon: "you're off the map".
 *  - `no-access`: the AREA exists and saying so is safe, but this role can't
 *    enter it -- e.g. a professor opening /student/*. Lock icon.
 *
 * Which variant is a SECURITY decision, not a cosmetic one: `no-access` is only
 * allowed on role-area boundaries, where the area's existence is public
 * knowledge. Anything keyed by a resource ID stays `missing` -- "you don't have
 * access to X" confirms X exists, which leaks tenancy. Full rule:
 * `.claude/rules/dead-ends.md`.
 *
 * Title and description default to vetted, tenant-safe copy per variant --
 * prefer the defaults; override only when the surface genuinely needs its own
 * wording (and never wording that distinguishes "gone" from "not allowed" on a
 * `missing` dead end). `action` is required: a dead end with no exit isn't
 * finished.
 *
 * Wraps EmptyState so dead ends share the app-wide state idiom (centered icon +
 * title + description + CTA). Layout-agnostic: boundaries inside (dashboard)
 * render it bare in <main>; public callers supply their own full-page frame.
 *
 * Type: Server-safe (no client hooks), so it works inside not-found.tsx.
 */

import Link from 'next/link'
import { Compass, Lock, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

const VARIANT_DEFAULTS = {
  missing: {
    icon: Compass,
    title: "We couldn't find that page",
    // Deliberately fuses "gone" and "no access" -- cross-tenant denials surface
    // as 404s, so the copy must not confirm the resource exists elsewhere.
    description: 'It may have been removed, or you may not have access to it.',
  },
  'no-access': {
    icon: Lock,
    title: "You don't have access to this area",
    // Second sentence is the actual self-service fix, not filler: the most common
    // way a LEGITIMATE user lands here is a stale JWT after a role change (the
    // staff layout documents this for TAs, but it's true of every promotion).
    // The old copy spent that sentence restating the button.
    description: 'This area is for a different role. If your role changed recently, sign out and back in to refresh it.',
  },
} as const

interface DeadEndProps {
  variant?: keyof typeof VARIANT_DEFAULTS
  /** Prefer the variant default -- override only with reason. */
  title?: string
  /** Prefer the variant default; on `missing`, never distinguish "gone" from "not allowed". */
  description?: string
  icon?: LucideIcon
  /** Required: every dead end offers a way out. */
  action: { label: string; href: string }
  /** Optional second exit, e.g. back to the parent list as well as home. */
  secondaryAction?: { label: string; href: string }
  className?: string
}

export function DeadEnd({
  variant = 'missing',
  title,
  description,
  icon,
  action,
  secondaryAction,
  className,
}: DeadEndProps) {
  const defaults = VARIANT_DEFAULTS[variant]
  return (
    <EmptyState
      icon={icon ?? defaults.icon}
      title={title ?? defaults.title}
      description={description ?? defaults.description}
      className={className}
    >
      {/* size="lg" is 40px, under the 44px mobile tap floor this repo holds
          elsewhere (min-h-11 … sm:min-h-0, see ModuleRowActions). It matters more
          here than on a dense row: the CTA is usually the ONLY control on the
          page, and the user reaching it is already lost. Desktop stays 40px.
          gap-3 on mobile because the stacked secondary is a ghost -- its 44px hit
          area is invisible at rest, so 8px between them invites a mis-tap. */}
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:gap-2">
        <Button asChild size="lg" className="min-h-11 sm:min-h-0">
          <Link href={action.href}>{action.label}</Link>
        </Button>
        {secondaryAction && (
          <Button asChild size="lg" variant="ghost" className="min-h-11 sm:min-h-0">
            <Link href={secondaryAction.href}>{secondaryAction.label}</Link>
          </Button>
        )}
      </div>
    </EmptyState>
  )
}
