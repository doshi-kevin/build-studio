/**
 * Upload a local image into a notebook/verbal cell.
 *
 * Picks a file, uploads it via the `uploadCellImage` server action (public bucket),
 * and hands the resulting `![alt](url)` markdown back to the caller to insert at the
 * cursor. Two visual variants match the two call sites: a full-width tile under the
 * notebook Image Gallery, and a compact chip beside the verbal insert toolbar.
 *
 * The server action is the real authz/validation gate; the client-side size/type
 * check here is just fast feedback so the professor isn't left waiting on an upload
 * that will be rejected.
 */
'use client'

import { useRef, useState } from 'react'
import { ImageUp, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { uploadCellImage } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { imageMarkdown } from '@/lib/assignments/studio/insert-ops'
import { MAX_CELL_IMAGE_SIZE, CELL_IMAGE_MIME_TYPES } from '@/lib/validations/assignment'

const ACCEPT = CELL_IMAGE_MIME_TYPES.join(',')

interface Props {
  sectionId: string
  assignmentId: string
  /** Receives the `![alt](url)` markdown to insert at the cursor. */
  onInserted: (markdown: string) => void
  variant?: 'tile' | 'chip'
}

export function CellImageUploadButton({ sectionId, assignmentId, onInserted, variant = 'tile' }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return

    if (!CELL_IMAGE_MIME_TYPES.includes(file.type as (typeof CELL_IMAGE_MIME_TYPES)[number])) {
      toast.error('Upload a PNG, JPEG, GIF, or WebP image.')
      return
    }
    if (file.size > MAX_CELL_IMAGE_SIZE) {
      toast.error('That image is larger than 5 MB.')
      return
    }

    setUploading(true)
    const fd = new FormData()
    fd.append('image', file)
    const res = await uploadCellImage(sectionId, assignmentId, fd)
    setUploading(false)

    if ('error' in res) {
      toast.error(res.error)
      return
    }
    onInserted(imageMarkdown(file.name, res.url))
  }

  const Icon = uploading ? Loader2 : ImageUp

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        onChange={onFile}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />
      {variant === 'tile' ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background px-2 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-60"
        >
          <Icon className={cn('h-4 w-4', uploading && 'animate-spin')} />
          {uploading ? 'Uploading…' : 'Upload image'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          title="Upload image"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
        >
          <Icon className={cn('h-3.5 w-3.5 text-muted-foreground', uploading && 'animate-spin')} />
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      )}
    </>
  )
}
