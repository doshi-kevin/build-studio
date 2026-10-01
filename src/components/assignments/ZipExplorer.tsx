/**
 * ZipExplorer — browse a submitted `.zip` in-app: a file tree on the left, a preview of
 * the selected file on the right. All reading happens server-side via signed actions
 * (`listSubmissionZip` / `readSubmissionZipEntry`); nothing is unzipped in the browser
 * and nothing is executed. PDFs reuse the shared MaterialViewer; code/text render inline.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { Folder, File as FileIcon, Loader2, AlertCircle } from 'lucide-react'
import { listSubmissionZip, readSubmissionZipEntry, type ZipEntryResponse } from '@/lib/assignments/viewer-actions'
import { type ZipFileNode } from '@/lib/assignments/zip'
import { CodeFileViewer } from './CodeFileViewer'
import { NotebookCells } from './NotebookCells'

interface ZipExplorerProps {
  submissionId: string
  filePath: string
}

interface TreeNode {
  name: string
  path: string
  size?: number
  isFile: boolean
  children: TreeNode[]
}

/** Build a nested folder tree from the flat list of file paths. */
function buildTree(files: ZipFileNode[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isFile: false, children: [] }
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    let node = root
    parts.forEach((part, idx) => {
      const isLast = idx === parts.length - 1
      let child = node.children.find((c) => c.name === part && c.isFile === isLast)
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, idx + 1).join('/'),
          isFile: isLast,
          size: isLast ? file.size : undefined,
          children: [],
        }
        node.children.push(child)
      }
      node = child
    })
  }
  sortLevel(root)
  return root.children
}

/** Folders first, then files; alphabetical within each. Recurses. */
function sortLevel(node: TreeNode) {
  node.children.sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1
    return a.name.localeCompare(b.name)
  })
  node.children.forEach(sortLevel)
}

function base64ToBlobUrl(base64: string, mime: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

export function ZipExplorer({ submissionId, filePath }: ZipExplorerProps) {
  const [list, setList] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; files: ZipFileNode[]; omitted: number }
  >({ status: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)
  const [entry, setEntry] = useState<
    { status: 'loading' } | { status: 'done'; data: ZipEntryResponse } | null
  >(null)

  useEffect(() => {
    let active = true
    listSubmissionZip(submissionId, filePath).then((res) => {
      if (!active) return
      if ('error' in res) setList({ status: 'error', message: res.error })
      else setList({ status: 'ready', files: res.files, omitted: res.omitted })
    })
    return () => {
      active = false
    }
  }, [submissionId, filePath])

  const tree = useMemo(
    () => (list.status === 'ready' ? buildTree(list.files) : []),
    [list],
  )

  function openEntry(path: string) {
    setSelected(path)
    setEntry({ status: 'loading' })
    readSubmissionZipEntry(submissionId, filePath, path).then((data) =>
      setEntry({ status: 'done', data }),
    )
  }

  if (list.status === 'loading') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading archive…
      </div>
    )
  }
  if (list.status === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/20 p-4 text-sm">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{list.message}</span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="space-y-3 rounded-xl border border-border bg-card p-3">
        <div className="max-h-[18rem] overflow-auto rounded-xl border border-border bg-muted/20 p-2">
          <TreeLevel nodes={tree} selected={selected} onSelect={openEntry} depth={0} />
        </div>
        <div className="min-w-0">
          <EntryPreview name={selected} entry={entry} />
        </div>
      </div>
      {list.omitted > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          Showing the first {list.files.length.toLocaleString()} files — {list.omitted.toLocaleString()} more not shown. Download the archive to see everything.
        </p>
      )}
    </div>
  )
}

function TreeLevel({
  nodes,
  selected,
  onSelect,
  depth,
}: {
  nodes: TreeNode[]
  selected: string | null
  onSelect: (path: string) => void
  depth: number
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) =>
        node.isFile ? (
          <li key={node.path}>
            <button
              type="button"
              onClick={() => onSelect(node.path)}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              className={`flex w-full items-center gap-2 rounded-xl py-1.5 pr-2 text-left text-sm transition-colors hover:bg-muted ${
                selected === node.path ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'
              }`}
            >
              <FileIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
          </li>
        ) : (
          <li key={node.path}>
            <details open>
              <summary
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                className="flex cursor-pointer items-center gap-2 rounded-xl py-1.5 pr-2 text-sm font-medium text-foreground hover:bg-muted"
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{node.name}</span>
              </summary>
              <TreeLevel nodes={node.children} selected={selected} onSelect={onSelect} depth={depth + 1} />
            </details>
          </li>
        ),
      )}
    </ul>
  )
}

function EntryPreview({
  name,
  entry,
}: {
  name: string | null
  entry: { status: 'loading' } | { status: 'done'; data: ZipEntryResponse } | null
}) {
  // Build a blob URL for any PDF entry so it renders inline (no focus-stealing modal).
  // Revoked when the selection changes or the view unmounts.
  const pdfUrl = useMemo(
    () =>
      entry?.status === 'done' && !('error' in entry.data) && entry.data.kind === 'pdf'
        ? base64ToBlobUrl(entry.data.dataBase64, entry.data.mime)
        : null,
    [entry],
  )
  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl)
    }
  }, [pdfUrl])

  if (!name || !entry) {
    return (
      <div className="flex h-full min-h-[8rem] items-center justify-center rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        Select a file to preview it.
      </div>
    )
  }
  if (entry.status === 'loading') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Opening {name.split('/').pop()}…
      </div>
    )
  }

  const data = entry.data
  const baseName = name.split('/').pop() ?? name

  if ('error' in data) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/20 p-4 text-sm">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{data.error}</span>
      </div>
    )
  }

  if (data.kind === 'notebook') {
    return <NotebookCells notebook={data.notebook} />
  }

  if (data.kind === 'text') {
    return <CodeFileViewer content={data.content} truncated={data.truncated} />
  }

  if (data.kind === 'image') {
    return (
      <div className="overflow-auto rounded-xl border border-border bg-muted/20 p-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`data:${data.mime};base64,${data.dataBase64}`}
          alt={baseName}
          className="mx-auto max-h-[85vh] rounded-xl"
        />
      </div>
    )
  }

  if (data.kind === 'pdf') {
    return pdfUrl ? (
      <iframe
        src={pdfUrl}
        title={baseName}
        className="h-[85vh] w-full rounded-xl border border-border bg-muted/20"
      />
    ) : (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Opening {baseName}…
      </div>
    )
  }

  // binary
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
      Preview isn&apos;t available for this file type.
    </div>
  )
}
