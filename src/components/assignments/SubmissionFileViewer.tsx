/**
 * SubmissionFileViewer — chooses how to view one submitted file by its extension:
 *   - `.zip`   → in-app file-tree explorer (expand inline)
 *   - `.ipynb` → in-app notebook renderer (expand inline)
 *   - others   → the existing MaterialViewer popup via FilePreviewLink
 *
 * The zip/notebook rows also expose a Download button (the signed URL) so a professor
 * can grab the original file. Drops into any list of submission files in place of
 * FilePreviewLink. Needs the submission id + storage path (not just a signed URL) so the
 * viewers can read content server-side.
 *
 * Type: Client Component
 */
'use client'

import { useState, type ReactNode } from 'react'
import { Archive, FileCode, ChevronDown, ChevronRight, Download, type LucideIcon } from 'lucide-react'
import { extensionOf } from '@/lib/assignments/zip'
import { FilePreviewLink } from './FilePreviewLink'
import { ZipExplorer } from './ZipExplorer'
import { NotebookViewer } from './NotebookViewer'

export interface SubmissionFileRef {
  name: string
  path: string
  url: string | null
}

interface SubmissionFileViewerProps {
  submissionId: string
  file: SubmissionFileRef
}

export function SubmissionFileViewer({ submissionId, file }: SubmissionFileViewerProps) {
  const ext = extensionOf(file.name)

  if (ext === 'zip') {
    return (
      <ExpandableFileRow name={file.name} icon={Archive} openLabel="Explore" closeLabel="Hide files" downloadUrl={file.url}>
        <ZipExplorer submissionId={submissionId} filePath={file.path} />
      </ExpandableFileRow>
    )
  }

  if (ext === 'ipynb') {
    return (
      <ExpandableFileRow name={file.name} icon={FileCode} openLabel="View notebook" closeLabel="Hide" downloadUrl={file.url}>
        <NotebookViewer submissionId={submissionId} filePath={file.path} />
      </ExpandableFileRow>
    )
  }

  return <FilePreviewLink url={file.url} name={file.name} />
}

function ExpandableFileRow({
  name,
  icon: Icon,
  openLabel,
  closeLabel,
  downloadUrl,
  children,
}: {
  name: string
  icon: LucideIcon
  openLabel: string
  closeLabel: string
  downloadUrl: string | null
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-muted/50"
          aria-expanded={open}
        >
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {open ? closeLabel : openLabel}
          </span>
        </button>
        {downloadUrl && (
          <a
            href={downloadUrl}
            download={name}
            title={`Download ${name}`}
            className="relative inline-flex shrink-0 items-center gap-1 rounded-xl border border-border p-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50"
          >
            <Download className="h-4 w-4" />
            <span className="sr-only">Download {name}</span>
          </a>
        )}
      </div>
      {open && children}
    </div>
  )
}
