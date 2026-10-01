/**
 * Shared studio chrome: the save-status pill and the step indicator. Used by both the
 * notebook studio (StudioShell) and the verbal studio (VerbalStudio) so the two surfaces
 * share one header implementation instead of drifting.
 */
'use client'

import { Check, Loader2, CloudOff, ArrowLeft, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'unsaved'

export function SaveStatus({ state }: { state: SaveState }) {
  // 'idle' means nothing has been saved yet this session — it is NOT "saved". Rendering the
  // reassuring "All changes saved" for it made the header claim a write that never happened
  // (notably on the Publish step, where the panel owns its own indicator).
  //
  // Rendered as reserved-but-invisible rather than removed: this pill sits under the title in a
  // flex column whose height is published to the Athena dock via a ResizeObserver, so unmounting it
  // would shift the header — and the dock — on the first keystroke. Same reasoning as the step-nav
  // cluster, which is kept mounted and merely hidden on the final step.
  if (state === 'idle') {
    return (
      <span aria-hidden className="invisible inline-flex items-center gap-1.5 text-xs">
        Saving…
      </span>
    )
  }
  if (state === 'unsaved') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-warning-muted-foreground">
        <CloudOff className="h-3.5 w-3.5" />
        Not saved yet
      </span>
    )
  }
  if (state === 'saving') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Saving…
      </span>
    )
  }
  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
        <CloudOff className="h-3.5 w-3.5" />
        Couldn&apos;t save
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check className="h-3.5 w-3.5 text-success-muted-foreground" />
      All changes saved
    </span>
  )
}

/**
 * Studio step navigation: a "Previous step" button, the (display-only) step progress, and a
 * "Next Step" button, grouped as one cluster for the header center. Generic over the stage list
 * so every studio (notebook, document, file-upload, verbal) shares one implementation.
 *
 * The steps are NOT clickable — the flow is enforced through Previous/Next so professors move
 * through it in order. `active` is the 0-based current step. Previous is disabled on the first
 * step; pass `hideNext` on the final (publish) step, where the page carries its own action.
 */
export function StudioStepNav({
  steps, active, onPrev, onNext, hideNext, nextLabel = 'Next Step',
}: {
  steps: readonly string[]
  active: number
  onPrev: () => void
  onNext: () => void
  hideNext?: boolean
  nextLabel?: string
}) {
  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onPrev}
        disabled={active === 0}
        className="shrink-0"
      >
        <ArrowLeft className="h-4 w-4" />
        <span className="hidden lg:inline">Previous step</span>
      </Button>

      <div className="flex items-center gap-1.5 rounded-full border border-border bg-muted/50 p-1.5">
        {steps.map((label, i) => {
          const isActive = i === active
          return (
            <div
              key={label}
              aria-current={isActive ? 'step' : undefined}
              className={cn(
                'inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm',
                isActive ? 'bg-card font-medium text-foreground shadow-sm' : 'text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'inline-flex h-5 w-5 items-center justify-center rounded-full text-xs tabular-nums',
                  isActive ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground',
                )}
              >
                {i + 1}
              </span>
              {/* Hide the label on small screens so the pill row can't overflow the header. */}
              <span className="hidden sm:inline">{label}</span>
            </div>
          )
        })}
      </div>

      {/* Kept mounted (just invisible) on the final step so the pills/Previous stay put — hiding it
          outright would shrink the cluster and shift everything as steps change. */}
      <Button
        type="button"
        size="sm"
        onClick={onNext}
        aria-hidden={hideNext}
        tabIndex={hideNext ? -1 : undefined}
        className={cn('shrink-0', hideNext && 'invisible pointer-events-none')}
      >
        {nextLabel}
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  )
}
