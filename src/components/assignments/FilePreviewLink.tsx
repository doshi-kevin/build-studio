/**
 * FilePreviewLink — a file row that opens the shared MaterialViewer popup.
 *
 * Same in-app preview the rest of Scholera uses: PDFs and images render inline
 * in a modal; other types (doc, ppt, zip) show a download card. Self-contained
 * (owns its open state) so it drops into any client list of submission files.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { Paperclip, Eye } from 'lucide-react'
import { MaterialViewer } from '@/components/ui/material-viewer'

interface FilePreviewLinkProps {
  url: string | null
  name: string
}

export function FilePreviewLink({ url, name }: FilePreviewLinkProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => url && setOpen(true)}
        disabled={!url}
        className="flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
          <Eye className="h-3.5 w-3.5" />
          Preview
        </span>
      </button>
      {url && (
        <MaterialViewer open={open} onOpenChange={setOpen} url={url} fileName={name} />
      )}
    </>
  )
}
