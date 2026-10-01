'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, BookOpen } from 'lucide-react'
import type { SyllabusBlock } from '@/lib/validations/course-about'

interface Props {
  block: SyllabusBlock
}

export function SyllabusBlockPreview({ block }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const title = block.data.title

  /* Coming-soon stub — prof has flagged this section as not ready */
  if (block.data.tba) {
    return (
      <div className="space-y-3">
        {title && (
          <h2 className="font-serif text-2xl text-foreground">
            {title}
          </h2>
        )}
        <div className="rounded-2xl border border-dashed border-border bg-muted/30 px-5 py-4">
          <p className="text-[10px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">
            Coming soon
          </p>
          <p className="text-sm text-foreground mt-1">
            The weekly schedule will be posted here before the course starts.
          </p>
        </div>
      </div>
    )
  }

  /* Hide weeks with no useful content. A week is "real" if it has a topic OR
     description OR readings — anything else is just a seed row from the
     starter template that the prof hasn't filled in yet. */
  const visible = block.data.weeks.filter(
    (w) => w.topic.trim() || w.description?.trim() || w.readings?.trim()
  )
  if (visible.length === 0) return null

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-3">
      {block.data.title && (
        <h2 className="font-serif text-2xl text-foreground">
          {block.data.title}
        </h2>
      )}
      <div className="space-y-2">
        {visible.map((week) => {
          const isOpen = expanded.has(week.id)
          return (
            <div key={week.id} className="rounded-2xl border border-border overflow-hidden bg-card">
              <button
                className="flex items-center gap-3 w-full px-4 py-3 text-left hover:bg-muted/40 transition-colors"
                onClick={() => toggle(week.id)}
              >
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="text-[11px] uppercase tracking-[0.15em] font-semibold text-muted-foreground tabular-nums">
                  Week {week.week}
                </span>
                <span className="text-sm text-foreground">{week.topic}</span>
              </button>
              {isOpen && (
                <div className="px-4 pb-4 pt-3 space-y-2 border-t border-border bg-muted/20">
                  {week.description && <p className="text-sm text-foreground leading-relaxed">{week.description}</p>}
                  {week.readings && (
                    <div className="flex items-start gap-2 text-sm text-muted-foreground">
                      <BookOpen className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span>{week.readings}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
