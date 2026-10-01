/**
 * EmptyState -- placeholder for pages/tabs with no data.
 *
 * Two layouts:
 *  - `default`: a centered faded icon + title + description (+ optional link CTA).
 *  - `teaching`: a bordered dashed card with an icon chip, used to onboard the
 *    user into a feature ("Build your first quiz"). Pass an action button via
 *    `children` (for onClick flows like opening a dialog) or `action` (for links).
 *
 * Type: Server-safe (no client hooks). When an onClick CTA is needed, the
 * client parent passes a <Button> through `children`.
 */

import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  /** Link-style CTA. For onClick CTAs, pass a <Button> as children instead. */
  action?: {
    label: string
    href: string
  }
  /** Custom CTA slot (e.g. a <Button onClick> that opens a dialog). */
  children?: React.ReactNode
  variant?: 'default' | 'teaching'
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  children,
  variant = 'default',
  className,
}: EmptyStateProps) {
  const cta = children ?? (action && (
    <Button asChild>
      <Link href={action.href}>{action.label}</Link>
    </Button>
  ))

  if (variant === 'teaching') {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/50 py-16 px-4 text-center',
          className,
        )}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-foreground">{title}</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
        {cta && <div className="mt-6">{cta}</div>}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col items-center justify-center py-16 px-4 text-center', className)}>
      <Icon className="h-12 w-12 text-muted-foreground/40 mb-4" />
      <h3 className="text-lg font-semibold text-foreground">{title}</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">{description}</p>
      {cta && <div className="mt-6">{cta}</div>}
    </div>
  )
}
