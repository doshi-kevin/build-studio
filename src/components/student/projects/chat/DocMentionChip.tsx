/**
 * DocMentionChip — inline @doc pill rendered inside chat message
 * bodies. Hovering the chip opens a HoverCard with the doc title,
 * pinned state, last-updated timestamp, and a short text excerpt for
 * quick context without leaving chat.
 *
 * Doc previews are fetched on first hover (lazy) via `getDocPreview`
 * and cached in a module-level Map so subsequent hovers are instant.
 */
'use client'

import { useCallback, useState } from 'react'
import { FileText, Loader2, Pin } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import {
  getDocPreview,
  type DocPreview,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/chat-actions'

interface DocMentionChipProps {
  docId: string
  label: string
  sectionId: string
}

// Cache doc previews across all rendered chips for the session.
const previewCache = new Map<string, DocPreview>()
const inflightFetches = new Map<string, Promise<DocPreview | null>>()

async function loadPreview(docId: string, sectionId: string): Promise<DocPreview | null> {
  if (previewCache.has(docId)) return previewCache.get(docId) as DocPreview
  const existing = inflightFetches.get(docId)
  if (existing) return existing
  const promise = getDocPreview(docId, sectionId)
    .then((res) => {
      if (res.data) {
        previewCache.set(docId, res.data)
        return res.data
      }
      return null
    })
    .finally(() => {
      inflightFetches.delete(docId)
    })
  inflightFetches.set(docId, promise)
  return promise
}

export function DocMentionChip({
  docId,
  label,
  sectionId,
}: DocMentionChipProps) {
  const [preview, setPreview] = useState<DocPreview | null>(
    () => previewCache.get(docId) ?? null,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open || preview || loading) return
      setLoading(true)
      loadPreview(docId, sectionId)
        .then((data) => {
          if (data) setPreview(data)
          else setError(true)
        })
        .catch(() => setError(true))
        .finally(() => setLoading(false))
    },
    [docId, sectionId, preview, loading],
  )

  return (
    <HoverCard openDelay={120} closeDelay={80} onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>
        <span
          className="inline-flex items-center gap-1 font-semibold text-foreground cursor-default align-baseline hover:underline underline-offset-2"
          tabIndex={0}
        >
          <FileText className="h-3 w-3 shrink-0" />
          {label}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 max-w-[90vw]">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading doc…
          </div>
        )}
        {!loading && error && (
          <p className="text-xs text-muted-foreground py-1">
            This doc is no longer available.
          </p>
        )}
        {preview && <DocPreviewBody preview={preview} />}
      </HoverCardContent>
    </HoverCard>
  )
}

function DocPreviewBody({ preview }: { preview: DocPreview }) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight truncate">
            {preview.title}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Updated {formatRelativeTime(preview.updated_at)}
          </p>
        </div>
        {preview.is_pinned && (
          <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-xl bg-muted text-muted-foreground">
            <Pin className="h-2.5 w-2.5" />
            Pinned
          </span>
        )}
      </div>

      <div className="border-t pt-2">
        {preview.excerpt ? (
          <p className="text-xs leading-snug text-foreground/80 wrap-break-word line-clamp-6">
            {preview.excerpt}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground italic">
            This doc is empty.
          </p>
        )}
      </div>
    </div>
  )
}

function formatRelativeTime(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
  } catch {
    return iso
  }
}
