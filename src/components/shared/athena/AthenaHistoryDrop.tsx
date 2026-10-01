/**
 * AthenaHistoryDrop — the "reopen a past conversation" affordance, shared by every
 * docked Athena surface.
 *
 * Shaped as a CURTAIN that drops out from behind the panel header rather than a side
 * rail: the dock is a narrow slide-in column (288-480px in practice) with no room for a
 * permanent sidebar, unlike the professor Assistant Console's full-page rail or the
 * student dock's fullscreen-only AthenaHistoryRail.
 *
 * Standard and Frontier threads share ONE list, sorted by recency, with a small tag on
 * the ones that need it — not two tabs. `mode` is optional precisely so the student
 * surface, where Frontier does not exist, renders the same list with no dead concept.
 *
 * Rows are TWO lines: the title owns the full width, the timestamp and tag sit beneath
 * it. A single-line row put a fixed-width timestamp ("less than a minute ago" is 127px)
 * in front of a flexible title, which at 288px left a Frontier row with zero characters
 * of title — inverting the hierarchy against the only thing that identifies a thread.
 * Two lines also lands the row at 44px on touch, and keeps tagged and untagged rows the
 * same height.
 *
 * Non-modal, like the rest of the dock: closes on an outside pointerdown rather than
 * behind a dimming scrim, because Athena never traps you in a modal here.
 *
 * Motion is a CSS transform transition on `ease-drawer` — the curve globals.css names
 * as the Athena dock's own, "for anything that slides in from an edge" — at the dock's
 * `duration-200`, with an explicit `motion-reduce` guard. It translates rather than
 * growing a max-height, because the thing described is a shade pulled down, and a
 * height animation reads as content inflating instead. A CSS transition rather than a
 * framer spring because nothing here is interruptible mid-gesture: the curtain is open
 * or it is not, so there is no value to retarget.
 */
'use client'

import { useEffect, useRef } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { AlertCircle, Compass, Trash2 } from 'lucide-react'

/** One past conversation, in the smallest shape every surface can supply. */
export interface AthenaHistoryItem {
  id: string
  title: string
  /** ISO timestamp of last activity. */
  updatedAt: string
  /** Studio only. Omitted on the student surface, where Frontier has no meaning. */
  mode?: 'standard' | 'frontier'
}

interface AthenaHistoryDropProps {
  id: string
  open: boolean
  onClose: () => void
  loading: boolean
  /** Set when the list could not be fetched. Rendered INSTEAD of the empty state —
   *  "you have no chats" is the worst possible way to report a failed read. */
  error?: string | null
  onRetry?: () => void
  items: AthenaHistoryItem[]
  activeId: string
  onSelect: (item: AthenaHistoryItem) => void
  /** Optional per-row removal. Only pass this where removal is REVERSIBLE. */
  onRemove?: (item: AthenaHistoryItem) => void
  removeLabel?: string
  emptyText?: string
  heading?: string
  /** Focus lands back here when the curtain closes. Without it, `inert` drops focus
   *  to <body> and a keyboard user restarts from the top of the document (WCAG 2.4.3). */
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>
}

export function AthenaHistoryDrop({
  id,
  open,
  onClose,
  loading,
  error,
  onRetry,
  items,
  activeId,
  onSelect,
  onRemove,
  removeLabel = 'Delete',
  emptyText = 'Your past chats will appear here.',
  heading = 'Recents',
  returnFocusRef,
}: AthenaHistoryDropProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Pointerdown, not click — the curtain is already collapsing by the time a click on
  // the composer behind it lands. Same choice as the student dock's history rail.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, onClose])

  // Escape closes the CURTAIN, not the whole dock. The dock listens on `document` in the
  // bubble phase; this runs in the CAPTURE phase and stops propagation, so while the
  // curtain is open the dock never sees the key.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  // Hand focus back on close. `inert` removes the subtree from the a11y tree, so a
  // keyboard user who was inside the list loses focus to <body> with no announcement
  // and no way back except tabbing from the document root.
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) {
      const inside = containerRef.current?.contains(document.activeElement)
      if (inside || document.activeElement === document.body) returnFocusRef?.current?.focus()
    }
    wasOpen.current = open
  }, [open, returnFocusRef])

  return (
    /* The curtain hides by sliding UP by its own height, which puts it directly
       over — and well above — the header it drops from. z-index hides the part
       behind the header, but everything taller than the header spilled out of
       the top of the dock, so a closed curtain showed a strip of the first chat
       title floating above the controls.
       This mask is the fix. It sizes itself to the curtain, so the curtain
       translating -100% lands entirely outside it and `overflow-hidden` clips
       it. The motion is untouched: still a shade pulled down, not a height
       inflating. Bottom padding leaves room for the open curtain's shadow,
       which the mask would otherwise cut off. */
    <div className="pointer-events-none absolute inset-x-0 top-full z-30 overflow-hidden pb-4">
    <div
      id={id}
      ref={containerRef}
      aria-hidden={!open}
      // Closed, the rows would otherwise stay in the tab order behind the header.
      inert={!open}
      className={`pointer-events-auto overflow-hidden rounded-b-3xl border-x border-b border-border/60 bg-card shadow-lg transition-transform duration-200 ease-drawer motion-reduce:transition-none ${
        open ? 'translate-y-0' : '-translate-y-full'
      }`}
    >
      <div className="max-h-80 overflow-y-auto p-2">
        <p
          id={`${id}-heading`}
          className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {heading}
        </p>

        {loading ? (
          // Skeletons, not a spinner: the curtain is still mid-drop when this renders,
          // and a spinner row would jolt the height again when the list lands.
          <div className="space-y-1 px-2.5 py-1" aria-live="polite" aria-busy="true">
            <span className="sr-only">Loading past chats…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-11 animate-pulse rounded-2xl bg-muted/60" />
            ))}
          </div>
        ) : error ? (
          <div className="px-2.5 py-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
              {error}
            </p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 rounded-xl px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Try again
              </button>
            )}
          </div>
        ) : items.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-muted-foreground">{emptyText}</p>
        ) : (
          <ul aria-labelledby={`${id}-heading`} className="flex flex-col gap-0.5">
            {items.map((item) => {
              const isActive = item.id === activeId
              return (
                <li
                  key={item.id}
                  className={`group/thread flex items-center gap-1 rounded-2xl pr-1 ${
                    isActive ? 'bg-accent' : 'hover:bg-accent'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(item)}
                    aria-current={isActive ? 'true' : undefined}
                    className={`min-w-0 flex-1 rounded-2xl px-2.5 py-3 text-left md:py-2 ${
                      isActive ? 'font-semibold' : ''
                    }`}
                  >
                    <span className="block truncate text-sm">{item.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      {formatDistanceToNowStrict(new Date(item.updatedAt), { addSuffix: true })}
                      {item.mode === 'frontier' && (
                        <span
                          title="Frontier mode — Athena interviews you about your field before it builds"
                          className="flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                        >
                          <Compass className="h-2.5 w-2.5" aria-hidden />
                          Frontier
                        </span>
                      )}
                    </span>
                  </button>
                  {onRemove && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemove(item)
                      }}
                      aria-label={`${removeLabel} "${item.title}"`}
                      // Always visible below md: a touch device has no hover, so a
                      // hover-only control simply does not exist on a phone.
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted-foreground opacity-100 transition-opacity hover:text-destructive focus-visible:opacity-100 md:h-7 md:w-7 md:opacity-0 md:group-hover/thread:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
    </div>
  )
}
