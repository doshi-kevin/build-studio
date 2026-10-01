'use client'

// Reports tab gallery. A section accumulates one ended-session row per class for
// the whole term, so rendering every card at once bloats the DOM and the
// staggered entrance animation. We render an initial page and reveal more on
// demand — the professor almost always wants the most recent sessions (the list
// arrives newest-first), so the tail rarely needs to open.

import { useState } from 'react'
import Link from 'next/link'
import { ChevronRight, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { LocalDateTime } from '@/components/shared/LocalDateTime'
import { LiveClassName } from '@/components/live-classroom/shared/LiveClassName'

export interface ReportItem {
  id: string
  name: string | null
  createdAt: string
  duration: string | null
  deckPageCount: number | null
  reported: boolean
}

const PAGE_SIZE = 12

export function ReportsGallery({ sectionId, reports }: { sectionId: string; reports: ReportItem[] }) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const visible = reports.slice(0, visibleCount)
  const remaining = reports.length - visible.length

  return (
    <div className="space-y-3">
      <AnimatedList className="space-y-2">
        {visible.map((room) => (
          <AnimatedItem key={room.id}>
            <Link
              href={`/professor/courses/${sectionId}/live-classroom/${room.id}/report`}
              className="group flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
                  <FileText className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    <LiveClassName name={room.name} createdAt={room.createdAt} />
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <LocalDateTime iso={room.createdAt} mode="datetime" />
                    {room.duration && <> · {room.duration}</>}
                    {room.deckPageCount && <> · {room.deckPageCount} slides</>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {room.reported && (
                  <span className="rounded-full bg-success-muted px-2.5 py-1 text-xs font-medium text-success-muted-foreground">
                    Report ready
                  </span>
                )}
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5" />
              </div>
            </Link>
          </AnimatedItem>
        ))}
      </AnimatedList>

      {remaining > 0 && (
        <div className="flex justify-center pt-1">
          <Button
            variant="outline"
            className="rounded-xl"
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          >
            Show more ({remaining})
          </Button>
        </div>
      )}
    </div>
  )
}
