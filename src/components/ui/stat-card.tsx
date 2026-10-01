/**
 * StatCard -- reusable stat card with icon, animated counter, and label.
 *
 * Wraps a Card component with an icon badge, an AnimatedCounter for the
 * value, a label, and an optional subtitle line. Designed for dashboard
 * summary rows and detail page stat sections.
 *
 * Type: Client Component (uses AnimatedCounter which requires useEffect)
 */
'use client'

import type { LucideIcon } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { AnimatedCounter } from '@/components/ui/animated-counter'
import { cn } from '@/lib/utils'

interface StatCardProps {
  icon: LucideIcon
  value: number
  label: string
  /** Tailwind color classes for the icon badge (e.g., "border border-border bg-muted/50") */
  color?: string
  subtitle?: string
}

export function StatCard({ icon: Icon, value, label, color, subtitle }: StatCardProps) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 pt-5 pb-4">
        <div
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
            color || 'border border-border bg-muted/50'
          )}
        >
          <Icon className={cn('h-5 w-5', !color && 'text-foreground')} />
        </div>
        <div className="min-w-0">
          <AnimatedCounter value={value} className="font-[family-name:var(--font-instrument-serif)] text-[28px]" />
          <p className="text-xs text-muted-foreground">{label}</p>
          {subtitle && (
            <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
