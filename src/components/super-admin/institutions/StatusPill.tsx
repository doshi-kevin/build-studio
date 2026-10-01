// Monochrome institution-status pill. Replaces emerald/red/amber color tokens
// with neutral surface + lucide icon (Check / Pause / Archive) so the pill is
// distinguishable without relying on color (Apple HIG / WCAG redundant encoding).

import { Check, Pause, Archive } from 'lucide-react'

export function StatusPill({ status }: { status: string }) {
  const label = status.charAt(0).toUpperCase() + status.slice(1)
  const Icon = status === 'active' ? Check : status === 'suspended' ? Pause : Archive
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground">
      <Icon className="h-3 w-3" />
      {label}
    </span>
  )
}
