/**
 * NotebookCells — presentational rendering of a parsed notebook, cell by cell:
 * markdown (via the script-safe MarkdownLatex), code (line-numbered), and outputs
 * (text, images, error tracebacks), with nbgrader point badges. Shared by the
 * standalone NotebookViewer and the in-zip preview in ZipExplorer.
 *
 * Type: Client Component
 */
'use client'

import { AlertCircle } from 'lucide-react'
import type { NotebookCell, NotebookOutput, ParsedNotebook } from '@/lib/assignments/notebook'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { CodeFileViewer } from './CodeFileViewer'

export function NotebookCells({ notebook }: { notebook: ParsedNotebook }) {
  if (notebook.cells.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        This notebook has no cells.
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-3">
      {notebook.cells.map((cell, i) => (
        <CellBlock key={i} cell={cell} />
      ))}
      {notebook.truncated && (
        <p className="rounded-xl bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          This notebook has more cells than we preview; the rest are not shown.
        </p>
      )}
    </div>
  )
}

function CellBlock({ cell }: { cell: NotebookCell }) {
  const points = cell.nbgrader?.points

  return (
    <div className="space-y-2">
      {cell.cellType === 'markdown' ? (
        <div className="rounded-xl border border-border bg-background p-4">
          {points != null && <PointsBadge points={points} />}
          <MarkdownLatex content={cell.source} />
        </div>
      ) : (
        <div>
          {points != null && <PointsBadge points={points} />}
          {cell.source.trim() ? (
            <CodeFileViewer content={cell.source} />
          ) : (
            <p className="rounded-xl border border-dashed border-border px-4 py-2 text-xs text-muted-foreground">
              Empty cell
            </p>
          )}
        </div>
      )}
      {cell.outputs.length > 0 && (
        <div className="space-y-2 pl-3">
          {cell.outputs.map((out, i) => (
            <OutputBlock key={i} output={out} />
          ))}
        </div>
      )}
    </div>
  )
}

function PointsBadge({ points }: { points: number }) {
  return (
    <span className="mb-2 inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
      {points} {points === 1 ? 'point' : 'points'}
    </span>
  )
}

function OutputBlock({ output }: { output: NotebookOutput }) {
  if (output.type === 'image') {
    return (
      <div className="overflow-auto rounded-xl border border-border bg-muted/20 p-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`data:${output.mime};base64,${output.dataBase64}`}
          alt="Notebook output"
          className="mx-auto max-h-[60vh] rounded-xl"
        />
      </div>
    )
  }

  if (output.type === 'error') {
    return (
      <div className="overflow-auto rounded-xl border border-destructive/20 bg-destructive/10 p-3">
        <p className="flex items-start gap-1.5 font-mono text-xs font-semibold text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-words">
            {output.errorType}: {output.errorValue}
          </span>
        </p>
        {output.traceback && (
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
            {output.traceback}
          </pre>
        )}
        {output.truncated && <p className="mt-1 text-xs text-muted-foreground">Traceback truncated.</p>}
      </div>
    )
  }

  // text
  return (
    <div className="overflow-auto rounded-xl border border-border bg-muted/20 p-3">
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
        {output.content}
      </pre>
      {output.truncated && <p className="mt-1 text-xs text-muted-foreground">Output truncated.</p>}
    </div>
  )
}
