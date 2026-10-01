/**
 * Answer key card for the grading view: shows every cell's professor-only answer key (rendered
 * with LaTeX/markdown) so the grader can reference the expected answers while marking. Only the
 * professor detail page renders this, so students never see it.
 *
 * Type: Client Component
 */
'use client'

import { KeyRound } from 'lucide-react'
import { CollapsibleCard } from './studio/shared/CollapsibleCard'
import { StudioMarkdown } from './studio/shared/StudioMarkdown'
import type { AnswerKeyEntry } from '@/lib/assignments/studio/answer-keys'

export function AssignmentAnswerKeyCard({ entries }: { entries: AnswerKeyEntry[] }) {
  if (entries.length === 0) return null
  return (
    <CollapsibleCard title="Answer key" icon={KeyRound} defaultOpen>
      <div className="space-y-4">
        {entries.map((e, i) => (
          <div key={i} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-foreground">{e.label}</p>
              {e.points != null && <span className="shrink-0 text-xs text-muted-foreground">{e.points} pts</span>}
            </div>
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <StudioMarkdown content={e.answerKey} />
            </div>
          </div>
        ))}
      </div>
    </CollapsibleCard>
  )
}
