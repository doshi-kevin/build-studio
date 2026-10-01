'use client'

/**
 * The attachment chip both Athena composers use — professor console and student
 * dock. Two roles, one component: in the composer it shows upload status and a
 * remove button; on a sent message it's read-only and links to the signed URL.
 * Mirrors the ChatGPT/Gemini preview: type icon + filename + type/status label.
 */

import {
  FileText,
  FileSpreadsheet,
  Presentation,
  Loader2,
  X,
  Image as ImageIcon,
  File as FileIcon,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { extOf } from '@/lib/ai/athena-attachments'
import type { PendingAttachment } from '@/lib/hooks/use-athena-attachments'

const OFFICE_EXTS = ['docx', 'pptx', 'xlsx', 'doc', 'ppt', 'xls']

/** Icon + human label for a file extension. */
export function fileTypeMeta(ext: string): { Icon: LucideIcon; label: string } {
  switch (ext) {
    case 'pdf':
      return { Icon: FileText, label: 'PDF' }
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':
      return { Icon: ImageIcon, label: 'Image' }
    case 'docx':
    case 'doc':
      return { Icon: FileText, label: 'Document' }
    case 'pptx':
    case 'ppt':
      return { Icon: Presentation, label: 'Slides' }
    case 'xlsx':
    case 'xls':
      return { Icon: FileSpreadsheet, label: 'Spreadsheet' }
    case 'csv':
      return { Icon: FileSpreadsheet, label: 'CSV' }
    case 'md':
      return { Icon: FileText, label: 'Markdown' }
    case 'txt':
      return { Icon: FileText, label: 'Text' }
    default:
      return { Icon: FileIcon, label: 'File' }
  }
}

export type AttachmentChipData = Pick<
  PendingAttachment,
  'displayName' | 'ext' | 'status' | 'signedUrl' | 'error'
>

/** Chip data for a file part on a sent message (filename + maybe a signed URL). */
export function chipFromFilePart(filename: unknown, url: unknown): AttachmentChipData {
  const name = typeof filename === 'string' && filename ? filename : 'file'
  return {
    displayName: name,
    ext: extOf(name),
    status: 'ready',
    // A bare storage path is not clickable — only a signed URL is.
    signedUrl: typeof url === 'string' && /^https?:/.test(url) ? url : undefined,
  }
}

export function AttachmentChip({
  data,
  onRemove,
}: {
  data: AttachmentChipData
  onRemove?: () => void
}) {
  const { Icon, label } = fileTypeMeta(data.ext)
  const uploading = data.status === 'uploading'
  const failed = data.status === 'error'
  const isOffice = OFFICE_EXTS.includes(data.ext)
  const subLabel = uploading ? (isOffice ? 'Preparing…' : 'Uploading…') : failed ? data.error || 'Failed' : label

  const inner = (
    <>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      </span>
      <div className="min-w-0">
        <p className="max-w-[150px] truncate text-xs font-medium text-foreground">{data.displayName}</p>
        <p className={cn('truncate text-[11px]', failed ? 'text-destructive' : 'text-muted-foreground')}>{subLabel}</p>
      </div>
    </>
  )

  const base = 'flex items-center gap-2 rounded-xl border border-border/60 bg-card px-2.5 py-1.5 shadow-sm'

  if (onRemove) {
    return (
      <div className={base}>
        {inner}
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${data.displayName}`}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }
  if (data.signedUrl) {
    return (
      <a href={data.signedUrl} target="_blank" rel="noopener noreferrer" className={cn(base, 'transition hover:border-ring/40')}>
        {inner}
      </a>
    )
  }
  return <div className={base}>{inner}</div>
}
