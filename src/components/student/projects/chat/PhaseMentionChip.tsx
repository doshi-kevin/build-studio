/**
 * PhaseMentionChip — inline @phase pill rendered inside chat message
 * bodies. Hovering the chip opens a HoverCard with the phase title,
 * status, and checklist items for quick context without leaving chat.
 *
 * Phase data is fetched on first hover (lazy) via `getPhasePreview`
 * and cached in a module-level Map so subsequent hovers are instant.
 */
'use client'

import { useCallback, useState } from 'react'
import { ListChecks, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import {
  getPhasePreview,
  type PhasePreview,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/chat-actions'

interface PhaseMentionChipProps {
  phaseId: string
  label: string
  sectionId: string
}

// Cache phase previews across all rendered chips for the session.
const previewCache = new Map<string, PhasePreview>()
const inflightFetches = new Map<string, Promise<PhasePreview | null>>()

async function loadPreview(phaseId: string, sectionId: string): Promise<PhasePreview | null> {
  if (previewCache.has(phaseId)) return previewCache.get(phaseId) as PhasePreview
  const existing = inflightFetches.get(phaseId)
  if (existing) return existing
  const promise = getPhasePreview(phaseId, sectionId).then((res) => {
    if (res.data) {
      previewCache.set(phaseId, res.data)
      return res.data
    }
    return null
  }).finally(() => {
    inflightFetches.delete(phaseId)
  })
  inflightFetches.set(phaseId, promise)
  return promise
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function statusToneClass(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-success text-success-foreground'
    case 'in_progress':
      return 'bg-muted text-foreground border border-border'
    case 'blocked':
      return 'bg-destructive/10 text-destructive'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

export function PhaseMentionChip({
  phaseId,
  label,
  sectionId,
}: PhaseMentionChipProps) {
  const [preview, setPreview] = useState<PhasePreview | null>(() => previewCache.get(phaseId) ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open || preview || loading) return
      setLoading(true)
      loadPreview(phaseId, sectionId)
        .then((data) => {
          if (data) setPreview(data)
          else setError(true)
        })
        .catch(() => setError(true))
        .finally(() => setLoading(false))
    },
    [phaseId, sectionId, preview, loading],
  )

  return (
    <HoverCard openDelay={120} closeDelay={80} onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>
        <span
          className="inline-flex items-center gap-1 font-semibold text-foreground cursor-default align-baseline hover:underline underline-offset-2"
          tabIndex={0}
        >
          <ListChecks className="h-3 w-3 shrink-0" />
          {label}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 max-w-[90vw]">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading phase…
          </div>
        )}
        {!loading && error && (
          <p className="text-xs text-muted-foreground py-1">
            This phase is no longer available.
          </p>
        )}
        {preview && <PhasePreviewBody preview={preview} />}
      </HoverCardContent>
    </HoverCard>
  )
}

function PhasePreviewBody({ preview }: { preview: PhasePreview }) {
  const total = preview.items.length
  const done = preview.items.filter((i) => i.is_completed).length
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight truncate">
            {preview.title}
          </p>
          {preview.description && (
            <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">
              {preview.description}
            </p>
          )}
        </div>
        <span
          className={cn(
            'shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-xl',
            statusToneClass(preview.status),
          )}
        >
          {statusLabel(preview.status)}
        </span>
      </div>

      {(preview.start_date || preview.due_date) && (
        <div className="text-[11px] text-muted-foreground flex items-center gap-2">
          {preview.start_date && (
            <span>Starts {formatDate(preview.start_date)}</span>
          )}
          {preview.due_date && <span>Due {formatDate(preview.due_date)}</span>}
        </div>
      )}

      <div className="border-t pt-2">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold mb-1.5">
          <span>Items</span>
          <span>
            {done} / {total}
          </span>
        </div>
        {total === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No items yet
          </p>
        ) : (
          <ul className="space-y-1 max-h-48 overflow-y-auto">
            {preview.items.slice(0, 8).map((item) => (
              <li
                key={item.id}
                className="flex items-start gap-2 text-xs leading-snug"
              >
                <span
                  className={cn(
                    'mt-0.5 h-3 w-3 rounded-xl border shrink-0 flex items-center justify-center',
                    item.is_completed
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-border',
                  )}
                  aria-hidden
                >
                  {item.is_completed && (
                    <svg
                      viewBox="0 0 12 12"
                      className="h-2 w-2"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path d="M2.5 6.5L5 9l4.5-5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span
                  className={cn(
                    'min-w-0 wrap-break-word',
                    item.is_completed && 'line-through text-muted-foreground',
                  )}
                >
                  {item.title}
                </span>
              </li>
            ))}
            {total > 8 && (
              <li className="text-[11px] text-muted-foreground italic pt-1">
                +{total - 8} more
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}
