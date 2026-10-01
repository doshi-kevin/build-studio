/**
 * TemplateHistoryList: the professor's previously-made templates for a picker group, shown below
 * the sub-template choices. Clicking one clones it into a fresh draft (handled by the parent).
 *
 * Type: Client Component (presentational)
 */
'use client'

import { History, Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import type { TemplateHistoryItem } from '@/lib/assignments/studio/template-history'

export function TemplateHistoryList({
  items, onPick, busyId, disabled,
}: {
  items: TemplateHistoryItem[]
  onPick: (id: string) => void
  busyId: string | null
  disabled?: boolean
}) {
  if (items.length === 0) return null
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div className="flex items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">Reuse a template you made</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            disabled={disabled}
            onClick={() => onPick(it.id)}
            className="rounded-2xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <Card className="h-full gap-0 py-0 transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-md">
              <CardContent className="flex items-start gap-3 p-4">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  {busyId === it.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" aria-hidden="true" />}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{it.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {it.subtitle} · {new Date(it.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>
    </div>
  )
}
