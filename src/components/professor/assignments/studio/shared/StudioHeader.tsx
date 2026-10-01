/**
 * StudioHeader — the shared top bar for every assignment studio (notebook + document).
 *
 * Left: back link · editable click-to-rename title · save status. Center: an optional slot (each
 * studio drops its StudioStepNav — Previous / step progress / Next — here). Right: `children` —
 * whatever actions that studio needs. Extracted from StudioShell so every studio surface shares one
 * header instead of drifting.
 *
 * When `onRequestExit` is provided, the back link becomes a button that calls it (used by the exit
 * guard on draft assignments) instead of navigating directly.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeft, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SaveStatus, type SaveState } from './StudioChrome'

interface Props {
  backUrl: string
  backLabel?: string
  title: string
  /** The title as first loaded — used to reset on Escape. */
  initialTitle: string
  onTitleChange: (title: string) => void
  /** Persist the (possibly renamed) title — called on blur / Enter. */
  onCommitTitle: () => void
  saveState: SaveState
  untitledLabel?: string
  /** Middle column (e.g. a StudioStepNav). Omit for a two-cluster header. */
  center?: ReactNode
  /** Right-hand actions. */
  children?: ReactNode
  /**
   * When provided, the back arrow calls this instead of navigating (exit-guard mode).
   */
  onRequestExit?: () => void
}

export function StudioHeader({
  backUrl, backLabel = 'Back', title, initialTitle, onTitleChange, onCommitTitle,
  saveState, untitledLabel = 'Untitled', center, children, onRequestExit,
}: Props) {
  const [renaming, setRenaming] = useState(false)
  const isUntitled = !title.trim() || /^untitled/i.test(title.trim())
  const headerRef = useRef<HTMLElement>(null)

  function commit() {
    setRenaming(false)
    onCommitTitle()
  }

  // Publish the header's height as a CSS variable so the Athena side panel (rendered at the
  // assignments layout, `fixed`) can start *below* the studio header instead of sliding over it.
  // Reset to 0 on unmount so non-studio assignment pages keep the full-height panel.
  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const publish = () => document.documentElement.style.setProperty('--athena-dock-top', `${el.offsetHeight}px`)
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.documentElement.style.setProperty('--athena-dock-top', '0px')
    }
  }, [])

  // Icon-only back control (a tooltip carries the label) so the left cluster stays compact and the
  // step nav can sit centered. Expanding text on hover would shift the whole header, so we don't.
  const backClass = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

  return (
    <header ref={headerRef} className="relative z-[60] shrink-0 border-b border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 lg:grid lg:grid-cols-[1fr_auto_1fr]">
          {/* Left: back + editable title + save status */}
          <div className="flex min-w-0 items-center gap-2">
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  {onRequestExit ? (
                    <button
                      type="button"
                      onClick={onRequestExit}
                      aria-label={backLabel}
                      className={backClass}
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </button>
                  ) : (
                    <Link href={backUrl} aria-label={backLabel} className={backClass}>
                      <ArrowLeft className="h-4 w-4" />
                    </Link>
                  )}
                </TooltipTrigger>
                <TooltipContent side="bottom">Go back to assignments page</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <span className="h-5 w-px shrink-0 bg-border" />
            <div className="flex min-w-0 flex-col">
              {renaming ? (
                <Input
                  value={title}
                  autoFocus
                  /* The rename action rejects past 200; without this the professor can type
                     a title that can never save. Matches AssignmentTitleEditor. */
                  maxLength={200}
                  onChange={(e) => onTitleChange(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit()
                    if (e.key === 'Escape') { onTitleChange(initialTitle); setRenaming(false) }
                  }}
                  className="h-8 max-w-sm"
                  aria-label="Assignment title"
                />
              ) : (
                <button
                  onClick={() => setRenaming(true)}
                  className="group inline-flex min-w-0 items-center gap-1.5 text-left"
                  title="Click to rename"
                >
                  <span className={cn('truncate text-xs font-medium', isUntitled ? 'text-muted-foreground' : 'text-foreground')}>
                    {title.trim() || untitledLabel}
                  </span>
                  <Pencil className="h-3 w-3 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
                </button>
              )}
              <SaveStatus state={saveState} />
            </div>
          </div>

          {/* Step nav — centered in the header (its own grid column on lg). */}
          {center ?? <span className="hidden lg:block" />}

          {/* Right: actions, aligned to the far edge. */}
          <div className="flex items-center justify-end gap-2">{children}</div>
        </div>
    </header>
  )
}
