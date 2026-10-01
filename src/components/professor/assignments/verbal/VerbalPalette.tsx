/**
 * Left column for the verbal studio: the cell-type palette, mirroring NotebookPalette.
 * Clicking an item appends that cell to the interview. Nothing here executes or calls AI.
 */
'use client'

import { Hand, MessageSquareText, ListChecks, type LucideIcon, Bot } from 'lucide-react'
import type { VerbalCellType } from '@/lib/assignments/verbal/config'

interface PaletteItem {
  type: VerbalCellType
  title: string
  description: string
  icon: LucideIcon
}

const ITEMS: PaletteItem[] = [
  { type: 'greeting', title: 'Greeting', description: 'Spoken opener, by name and topic.', icon: Hand },
  { type: 'question', title: 'Question', description: 'A prompt answered aloud.', icon: MessageSquareText },
  { type: 'mcq', title: 'MCQ', description: 'A multiple-choice question.', icon: ListChecks },
  { type: 'ai_followup', title: 'AI follow-up', description: 'Athena asks an adaptive follow-up.', icon: Bot },
]

export function VerbalPalette({ onAdd }: { onAdd: (type: VerbalCellType) => void }) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-card lg:flex">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add to interview</h2>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <div className="space-y-0.5">
          {ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.type}
                type="button"
                onClick={() => onAdd(item.type)}
                className="flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-accent"
              >
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{item.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
