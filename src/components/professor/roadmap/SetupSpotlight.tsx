/**
 * SetupSpotlight — the "name it and place it" first-run moment for a new resource.
 *
 * Dims the whole screen behind a scrim (portaled to <body> so page layout can't
 * interfere), lifts the host's name field (children) above it, and anchors a
 * card beneath with the roadmap module picker and a confirm / decide-later
 * choice. Opens at a deterministic moment (page mount), so it can never stack
 * on top of another dialog — the failure mode of the old autosave-timed
 * placement popup. Used by the quiz studio and the new-assignment entry;
 * generic over any resource that wants the same ritual.
 *
 * The name input itself belongs to the host (it's the host's real form field);
 * this component only elevates it and collects the optional module choice. The
 * lifted look is an absolutely-positioned halo layer behind the children —
 * never margins/padding on the wrapper — so opening the spotlight can't shift
 * the host's layout (e.g. break an mx-auto centering).
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getPlacementModules } from '@/lib/roadmap/placement-actions'

// Stable arguments for the hydration check (see `mounted` below).
const subscribeNoop = () => () => {}
const snapshotTrue = () => true
const snapshotFalse = () => false

interface SetupSpotlightProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  /** Card copy — say what's being set up and that both choices can change later. */
  description: string
  ariaLabel: string
  /** Confirm button label. It confirms the name and the (optional) placement. */
  confirmLabel?: string
  /** Fired on confirm with the chosen module id ('' when none was picked / none exist). */
  onConfirm: (moduleId: string) => void
  /** Classes for the wrapper around the spotlighted children (the host's layout). */
  className?: string
  /** Inset overrides for the halo behind the children while open (default -inset-x-4 -inset-y-3). */
  haloClassName?: string
  /** The element being spotlighted — typically the host's name input block. */
  children: React.ReactNode
}

export function SetupSpotlight({
  open,
  onOpenChange,
  sectionId,
  description,
  ariaLabel,
  confirmLabel = 'Start building',
  onConfirm,
  className,
  haloClassName,
  children,
}: SetupSpotlightProps) {
  const [modules, setModules] = useState<{ id: string; title: string; weekNumber: number | null }[] | null>(null)
  const [moduleId, setModuleId] = useState('')
  // Portal target exists only in the browser — false during the SSR pass so it
  // never touches document, true from the first client render.
  const mounted = useSyncExternalStore(subscribeNoop, snapshotTrue, snapshotFalse)

  useEffect(() => {
    if (!open) return
    let alive = true
    getPlacementModules(sectionId).then((mods) => {
      if (alive) setModules(mods.data ?? [])
    })
    const onKey = (e: KeyboardEvent) => {
      // defaultPrevented → an open dropdown already consumed this Escape.
      if (e.key === 'Escape' && !e.defaultPrevented) onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      alive = false
      window.removeEventListener('keydown', onKey)
    }
  }, [open, sectionId, onOpenChange])

  // The spotlight always opens on a NEW resource — it's the "name it and place
  // it" moment, and the naming step matters even with no modules. So the popup
  // shows whenever `open`; only the module PICKER is conditional — dropped when
  // the section has no modules (nothing to place into → placement stays empty
  // and the resource stays off the roadmap, same as "Decide later").
  const hasModules = (modules?.length ?? 0) > 0

  return (
    <>
      {/* Scrim — same treatment as DialogOverlay. Portaled to <body> so an
          ancestor's transform/spacing can't reposition or offset it. */}
      {open && mounted && createPortal(
        <div
          className="fixed inset-0 z-50 bg-black/50"
          aria-hidden="true"
          onClick={() => onOpenChange(false)}
        />,
        document.body,
      )}
      <div className={cn(className, open && 'relative z-60')}>
        {children}
        {open && (
          <div
            role="dialog"
            aria-label={ariaLabel}
            className="absolute left-0 top-full mt-5 w-80 max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl border bg-popover p-4 text-popover-foreground shadow-xl"
          >
            <p className="text-sm text-muted-foreground">{description}</p>
            {/* Module picker — only when the section actually has modules. */}
            {hasModules && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-foreground">
                  Module it belongs to <span className="font-normal text-muted-foreground">· optional</span>
                </p>
                <Select
                  value={moduleId}
                  onValueChange={(v) => {
                    setModuleId(v)
                    // Persist the pick immediately — so it's saved even if the
                    // popup is dismissed (click-outside / Escape) rather than
                    // confirmed with "Start building".
                    onConfirm(v)
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Module it belongs to">
                    <SelectValue placeholder="Pick a module — or decide later" />
                  </SelectTrigger>
                  {/* Above the z-60 spotlight layer (portal default is z-50) */}
                  <SelectContent className="z-70">
                    {(modules ?? []).map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.weekNumber ? `Week ${m.weekNumber} · ` : ''}{m.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex justify-end gap-2">
              {/* "Decide later" only when there's a module choice to defer —
                  with no picker it would just be a second button that closes. */}
              {hasModules && (
                <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                  Decide later
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  onConfirm(moduleId)
                  onOpenChange(false)
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </div>
        )}
        {/* Halo — the lifted-card look, painted behind the children (-z-10
            inside this z-60 context, still above the z-50 scrim). Absolute,
            so it never affects the host's layout. Rendered last: a space-y
            parent then can't add sibling margins to the real children. */}
        {open && (
          <div
            aria-hidden="true"
            className={cn('absolute -inset-x-4 -inset-y-3 -z-10 rounded-2xl bg-background shadow-xl', haloClassName)}
          />
        )}
      </div>
    </>
  )
}
