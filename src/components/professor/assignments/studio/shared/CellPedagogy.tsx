/**
 * Shared per-cell pedagogy UI, authored in the Inspector and reused on BOTH the professor
 * editor and the student view:
 *   - PedagogyCorner: corner icons that reveal hints (progressive) + explanation on hover.
 *     The answer key is professor-only: pass showAnswerKey={false} for students.
 *   - CellBadges: glanceable assessment metadata (points, difficulty, weight, time, tags).
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import {
  Award, Lightbulb, BookOpen, Tag, Gauge, Percent, KeyRound, CircleCheck, Clock,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { AuthoringMeta } from '@/lib/assignments/studio/authoring'

function HintPopover({ hints }: { hints: string[] }) {
  const [revealed, setRevealed] = useState(1)
  const shown = Math.min(revealed, hints.length)

  return (
    <Popover onOpenChange={(open) => { if (!open) setRevealed(1) }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label="Show hints"
          className="rounded-md p-1 text-warning-muted-foreground hover:bg-warning-muted"
        >
          <Lightbulb className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72" onClick={(e) => e.stopPropagation()}>
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Lightbulb className="h-3.5 w-3.5 text-warning-muted-foreground" /> Hints
        </p>
        <ol className="space-y-2">
          {hints.slice(0, shown).map((h, i) => (
            <li key={i} className="rounded-lg bg-muted/60 p-2 text-xs text-foreground">
              <span className="font-medium text-muted-foreground">Hint {i + 1}.</span> {h}
            </li>
          ))}
        </ol>
        {shown < hints.length ? (
          <button
            type="button"
            onClick={() => setRevealed((r) => r + 1)}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            <Lightbulb className="h-3.5 w-3.5" /> Reveal next hint ({hints.length - shown} left)
          </button>
        ) : (
          hints.length > 1 && <p className="mt-2 text-[11px] text-muted-foreground">All hints revealed.</p>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Corner icons that surface the cell's authored hints/explanation/answer key on hover.
 * showAnswerKey defaults to true (professor); the student view passes false.
 */
export function PedagogyCorner({ authoring, showAnswerKey = true }: { authoring: AuthoringMeta; showAnswerKey?: boolean }) {
  const hints = (authoring.hints ?? []).filter((h) => h.trim().length > 0)
  const explanation = authoring.explanation?.trim()
  const answerKey = showAnswerKey ? authoring.answerKey?.trim() : undefined
  if (hints.length === 0 && !explanation && !answerKey) return null

  return (
    <TooltipProvider delayDuration={100}>
      <div className="flex items-center gap-0.5">
        {hints.length > 0 && <HintPopover hints={hints} />}
        {explanation && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={(e) => e.stopPropagation()} aria-label="Show explanation" className="rounded-md p-1 text-info-muted-foreground hover:bg-info-muted">
                <BookOpen className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs whitespace-pre-wrap text-left text-xs">
              <p className="mb-1 font-semibold">Explanation</p>
              {explanation}
            </TooltipContent>
          </Tooltip>
        )}
        {answerKey && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={(e) => e.stopPropagation()} aria-label="Show answer key" className="rounded-md p-1 text-muted-foreground hover:bg-muted">
                <KeyRound className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs whitespace-pre-wrap text-left text-xs">
              <p className="mb-1 font-semibold">Answer key</p>
              {answerKey}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  )
}

/** Glanceable assessment metadata. Returns null when nothing is set. */
export function CellBadges({ authoring }: { authoring: AuthoringMeta }) {
  if (
    authoring.points === undefined && !authoring.difficulty && authoring.weight === undefined &&
    authoring.graded === undefined && authoring.estimatedMinutes === undefined && !authoring.conceptTags?.length
  ) return null

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">
      {authoring.points !== undefined && (
        <span className="inline-flex items-center gap-1"><Award className="h-3 w-3" />{authoring.points} pts</span>
      )}
      {authoring.difficulty && (
        <span className="inline-flex items-center gap-1 capitalize"><Gauge className="h-3 w-3" />{authoring.difficulty}</span>
      )}
      {authoring.weight !== undefined && (
        <span className="inline-flex items-center gap-1"><Percent className="h-3 w-3" />{authoring.weight}% weight</span>
      )}
      {authoring.estimatedMinutes !== undefined && (
        <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{authoring.estimatedMinutes} min</span>
      )}
      {authoring.graded !== undefined && (
        <span className="inline-flex items-center gap-1"><CircleCheck className="h-3 w-3" />{authoring.graded ? 'Graded' : 'Ungraded'}</span>
      )}
      {authoring.conceptTags?.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5"><Tag className="h-3 w-3" />{t}</span>
      ))}
    </div>
  )
}
