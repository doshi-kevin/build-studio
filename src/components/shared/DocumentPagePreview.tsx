// Citation preview pane: renders the cited page of a source PDF via the
// /api/extraction/page render endpoint. Used by the AI tutor (cite a module
// file by `itemId`) and the quiz creator (cite a module file by `itemId`, or
// an ad-hoc upload by `filePath`). Citations are page-granular today; if a
// unit-level highlight ever lands, the `#bbox=` deep-link format in
// lib/extraction/citation.ts is the producer to wire up.
'use client'

import { useState } from 'react'
import { Loader2, X, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface DocumentPagePreviewProps {
  /** A module item to render by id. Provide this OR `filePath`. */
  itemId?: string
  /** A storage path to render directly (ad-hoc quiz uploads). Provide this OR `itemId`. */
  filePath?: string
  page: number
  title: string
  /** Replaces the default "Page N" line — a spoken citation says "slide N". */
  subtitle?: string
  /** Rendered ABOVE the page, inside the same scroll area. Athena puts the
   *  professor's spoken words here for a "said in class" citation: the words are
   *  what was cited, the slide is what they were said over. */
  lead?: React.ReactNode
  onClose: () => void
}

export function DocumentPagePreview({ itemId, filePath, page, title, subtitle, lead, onClose }: DocumentPagePreviewProps) {
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading')
  const src = itemId
    ? `/api/extraction/page?item=${encodeURIComponent(itemId)}&page=${page}`
    : `/api/extraction/page?path=${encodeURIComponent(filePath ?? '')}&page=${page}`

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">{subtitle ?? `Page ${page}`}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close preview" className="shrink-0">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* One column for both shapes: with no `lead` this lays the page out
          exactly as the row version did (top-aligned, centred horizontally). */}
      <div className="flex flex-1 flex-col items-center gap-4 overflow-auto p-4">
        {lead}
        {state === 'loading' && (
          <div className="flex items-center gap-2 pt-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Rendering page…
          </div>
        )}
        {state === 'error' && (
          <div className="flex items-center gap-2 pt-12 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Couldn&apos;t render this page — it may not be a PDF, or the render failed.
          </div>
        )}
        {/* The image loads even while hidden (display:none images still fire
            onLoad), so a single <img> drives the state. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={src}
          src={src}
          alt={`${title} — page ${page}`}
          className="max-w-full rounded-xl border shadow"
          style={{ display: state === 'loaded' ? 'block' : 'none' }}
          onLoad={() => setState('loaded')}
          onError={() => setState('error')}
        />
      </div>
    </div>
  )
}
