/**
 * Right column: the notebook's cell list + inline settings (quiz-editor style).
 *
 * Always visible in edit mode. Each cell is a row; clicking a row selects it (scrolling the
 * center canvas to it) and expands its authoring settings inline. One row open at a time,
 * driven by the shared `selectedId`.
 */
'use client'

import { useEffect } from 'react'
import { ChevronDown, ChevronRight, Lock, PanelRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { InspectorPanel, type ReferenceLink } from './shared/InspectorPanel'
import { SolverPanel } from './shared/SolverPanel'
import type { StudioNotebook, StudioCell } from '@/lib/assignments/studio/notebook-model'
import { getAuthoring, type AuthoringMeta } from '@/lib/assignments/studio/authoring'
import { isLocked } from '@/lib/assignments/studio/cell-ops'

export type { ReferenceLink }

const TYPE_LABEL: Record<StudioCell['cell_type'], string> = {
  code: 'Code',
  markdown: 'Text block',
  raw: 'Raw',
}

/**
 * True when this cell is byte-identical to the one directly above it — i.e. what you get
 * straight after Duplicate.
 *
 * Deliberately DERIVED rather than stored, and never written into the cell's source: the
 * outline label comes from the cell's own content, so appending a real "(copy)" would edit
 * the professor's code/markdown. Because it is derived, the marker disappears by itself the
 * moment either copy is edited — which is exactly when they stop being ambiguous.
 */
export function isCopyOfPrevious(cells: StudioCell[], i: number): boolean {
  if (i === 0) return false
  const prev = cells[i - 1]
  const cur = cells[i]
  return (
    !!prev && !!cur &&
    cur.cell_type === prev.cell_type &&
    cur.source === prev.source &&
    cur.source.trim() !== ''
  )
}

/** First meaningful line of a cell's source, stripped of markdown heading marks. */
function snippet(source: string): string {
  const line = source.split('\n').find((l) => l.trim()) ?? ''
  return line.replace(/^#{1,6}\s*/, '').trim()
}

interface Props {
  sectionId: string
  notebook: StudioNotebook
  selectedId: string | null
  solverEnabled: boolean
  collapsed?: boolean
  onExpand?: () => void
  onSelect: (id: string) => void
  onChangeAuthoring: (meta: AuthoringMeta) => void
  onDeleteCell: (id: string) => void
  references: ReferenceLink[]
  onChangeReferences: (refs: ReferenceLink[]) => void
  onAddSolutionToCell: (markdown: string) => void
  onAddSolutionToAnswerKey: (text: string) => void
}

export function NotebookInspector({
  sectionId, notebook, selectedId, solverEnabled, collapsed, onExpand, onSelect,
  onChangeAuthoring, onDeleteCell, references, onChangeReferences,
  onAddSolutionToCell, onAddSolutionToAnswerKey,
}: Props) {
  // When a cell is selected elsewhere (e.g. clicked in the center canvas), keep its
  // expanded row visible in this list.
  useEffect(() => {
    if (selectedId) {
      document.getElementById(`studio-cellrow-${selectedId}`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedId])

  if (collapsed) {
    return (
      <aside className="flex h-full w-full flex-col gap-0.5 overflow-y-auto py-2">
        <button
          type="button"
          onClick={onExpand}
          aria-label="Expand block inspector"
          className="mx-1 mb-1 flex h-11 w-[calc(100%-0.5rem)] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <PanelRight className="h-4 w-4" />
        </button>
        {notebook.cells.map((cell, i) => (
          <button
            key={cell.id}
            type="button"
            onClick={() => { onExpand?.(); onSelect(cell.id) }}
            aria-label={`Select block ${i + 1}`}
            className={cn(
              'mx-1 flex h-11 w-[calc(100%-0.5rem)] items-center justify-center rounded-lg text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              cell.id === selectedId
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {i + 1}
          </button>
        ))}
      </aside>
    )
  }

  return (
    <aside className="flex h-full w-full flex-col gap-3 overflow-y-auto">
      {solverEnabled && (
        <SolverPanel
          sectionId={sectionId}
          hasSelectedCell={!!selectedId}
          onAddToCell={onAddSolutionToCell}
          onAddToAnswerKey={onAddSolutionToAnswerKey}
        />
      )}

      <div className="space-y-2">
        <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Blocks</p>
        {notebook.cells.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">No blocks yet. Add one from the palette.</p>
        ) : (
          <ul className="space-y-2">
            {notebook.cells.map((cell, i) => (
              <CellRow
                key={cell.id}
                cell={cell}
                index={i}
                isCopy={isCopyOfPrevious(notebook.cells, i)}
                expanded={cell.id === selectedId}
                onToggle={() => onSelect(cell.id)}
                sectionId={sectionId}
                references={references}
                onChangeReferences={onChangeReferences}
                onChangeAuthoring={onChangeAuthoring}
                onDelete={() => onDeleteCell(cell.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

function CellRow({
  cell, index, isCopy, expanded, onToggle, sectionId, references, onChangeReferences, onChangeAuthoring, onDelete,
}: {
  cell: StudioCell
  index: number
  /** Identical to the block above — flagged so a fresh duplicate is tellable apart. */
  isCopy: boolean
  expanded: boolean
  onToggle: () => void
  sectionId: string
  references: ReferenceLink[]
  onChangeReferences: (refs: ReferenceLink[]) => void
  onChangeAuthoring: (meta: AuthoringMeta) => void
  onDelete: () => void
}) {
  const authoring = getAuthoring(cell.metadata)
  const locked = isLocked(cell)
  const graded = authoring.graded === true
  const preview = snippet(cell.source)

  return (
    <li
      id={`studio-cellrow-${cell.id}`}
      className={cn(
        'rounded-xl border transition-colors',
        expanded ? 'border-primary/50 bg-card shadow-sm' : 'border-border bg-card hover:border-border',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
      >
        <span className="mt-0.5 shrink-0 text-xs font-semibold text-primary">{index + 1}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-foreground">{TYPE_LABEL[cell.cell_type]}</span>
            {/* Straight after Duplicate the outline shows two identical rows, so deleting
                "the new one" by position was a coin flip that could destroy the original.
                Derived from content, so it clears itself once either copy is edited. */}
            {isCopy && (
              <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                copy
              </span>
            )}
            {locked && <Lock className="h-3 w-3 text-muted-foreground" aria-label="Locked" />}
            {graded && authoring.points != null && authoring.points > 0 && (
              <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">{authoring.points} pts</span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {preview || 'Empty block'}
          </span>
        </span>
        {expanded
          ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="border-t border-border p-3">
          <InspectorPanel
            authoring={authoring}
            onChange={onChangeAuthoring}
            disabled={locked}
            sectionId={sectionId}
            references={references}
            onChangeReferences={onChangeReferences}
            onDelete={onDelete}
          />
        </div>
      )}
    </li>
  )
}
