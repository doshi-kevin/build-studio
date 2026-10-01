'use client'

import { ClipboardCheck, Users, Percent, AlertTriangle } from 'lucide-react'

/** Client-safe mirror of LiveClassReport (the server type lives in a server-only module). */
interface Report {
  found: boolean
  note?: string
  closedAt?: string
  totalStudents?: number
  overallAccuracy?: number
  concepts?: { concept: string; correctRate: number; correctCount: number; totalCount: number }[]
  weakestConcepts?: string[]
  questions?: { prompt: string; concept: string; correctRate: number }[]
  nonResponders?: string[]
}

/** Score color: green ≥80, amber ≥60, red <60 (matches the gradebook scale). */
function rateClass(pct: number): string {
  if (pct >= 80) return 'text-success-muted-foreground'
  if (pct >= 60) return 'text-warning-muted-foreground'
  return 'text-destructive-muted-foreground'
}

export function LiveClassReportCard({ output }: { output: Report }) {
  if (!output || typeof output !== 'object') return null

  if (!output.found) {
    return (
      <div className="rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        {output.note || 'No live-class report available yet.'}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary/10">
          <ClipboardCheck className="h-4 w-4 text-primary" />
        </div>
        <span className="text-sm font-semibold text-foreground">Live-class quiz report</span>
      </div>

      <div className="grid grid-cols-2 gap-2 p-4">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
          <Percent className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <p className={`text-sm font-semibold tabular-nums ${rateClass(output.overallAccuracy ?? 0)}`}>
              {output.overallAccuracy ?? 0}%
            </p>
            <p className="truncate text-xs text-muted-foreground">overall accuracy</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
          <Users className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground tabular-nums">{output.totalStudents ?? 0}</p>
            <p className="truncate text-xs text-muted-foreground">students answered</p>
          </div>
        </div>
      </div>

      {output.concepts && output.concepts.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Concepts (weakest first)</p>
          <div className="flex flex-col gap-1.5">
            {output.concepts.map((c) => (
              <div key={c.concept} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">{c.concept}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{c.correctCount}/{c.totalCount}</span>
                <span className={`w-12 shrink-0 text-right font-semibold tabular-nums ${rateClass(c.correctRate)}`}>
                  {c.correctRate}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {output.nonResponders && output.nonResponders.length > 0 && (
        <div className="border-t border-border bg-warning-muted/30 px-4 py-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-warning-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5" />
            {output.nonResponders.length} didn&apos;t answer
          </p>
          <p className="text-sm text-foreground">{output.nonResponders.join(', ')}</p>
        </div>
      )}
    </div>
  )
}
