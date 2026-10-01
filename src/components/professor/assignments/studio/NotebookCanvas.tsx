/**
 * The center block document — a vertical, reorderable list of notebook cells.
 * Reuses @dnd-kit (the same pattern as about/BlockCanvas) for reorder. Renders an
 * empty-state when there are no cells, and a read-only stack in preview mode.
 */
'use client'

import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { NotebookPen, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { StudioNotebook } from '@/lib/assignments/studio/notebook-model'
import { NotebookCellView } from './NotebookCellView'
import type { CellOps } from './studio-ops'

interface Props {
  notebook: StudioNotebook
  selectedId: string | null
  mode: 'edit' | 'preview'
  ops: CellOps
  onSelect: (id: string) => void
  onCellFocus?: (id: string, el: HTMLTextAreaElement) => void
  onCellBlur?: (id: string) => void
}

export function NotebookCanvas({ notebook, selectedId, mode, ops, onSelect, onCellFocus, onCellBlur }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  if (notebook.cells.length === 0) {
    return (
      <div className="mx-auto mt-12 flex max-w-md flex-col items-center gap-3 rounded-2xl border border-dashed border-border p-10 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <NotebookPen className="h-6 w-6" aria-hidden="true" />
        </span>
        <p className="font-medium text-foreground">This notebook is empty</p>
        <p className="text-sm text-muted-foreground">Add your first block to start authoring.</p>
        <Button onClick={() => ops.insert('below', 'code', null)}>
          <Plus className="h-4 w-4" /> Add a code block
        </Button>
      </div>
    )
  }

  if (mode === 'preview') {
    return (
      <div className="mx-auto max-w-3xl divide-y divide-border">
        {notebook.cells.map((c, i) => (
          <NotebookCellView key={c.id} cell={c} index={i} selected={false} mode="preview" ops={ops} onSelect={() => {}} />
        ))}
      </div>
    )
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (over && active.id !== over.id) ops.reorder(String(active.id), String(over.id))
  }

  const firstId = notebook.cells[0]?.id

  return (
    <DndContext id="studio-cells" sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={notebook.cells.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="mx-auto max-w-5xl">
          {/* Add a block at the very top */}
          <div className="mb-2 flex justify-start pl-9">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => (firstId ? ops.insert('above', 'code', firstId) : ops.insert('below', 'code', null))}
            >
              <Plus className="h-4 w-4" /> Add Block
            </Button>
          </div>

          {notebook.cells.map((c, i) => (
            <div key={c.id}>
              <SortableCell id={c.id}>
                {(handle) => (
                  <div className="flex items-start gap-2">
                    {/* Execution-count-style index — a visual ordering marker only, never run state */}
                    <span className="mt-3 w-7 shrink-0 select-none text-right font-mono text-xs text-muted-foreground tabular-nums">
                      [{i + 1}]
                    </span>
                    <div className="min-w-0 flex-1">
                      <NotebookCellView
                        cell={c}
                        index={i}
                        selected={c.id === selectedId}
                        mode="edit"
                        ops={ops}
                        onSelect={() => onSelect(c.id)}
                        onCellFocus={onCellFocus}
                        onCellBlur={onCellBlur}
                        dragHandle={handle}
                      />
                    </div>
                  </div>
                )}
              </SortableCell>

              {/* Insert a block between this one and the next */}
              <AddCellHere onClick={() => ops.insert('below', 'code', c.id)} />
            </div>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

function AddCellHere({ onClick }: { onClick: () => void }) {
  return (
    <div className="group/add relative flex h-6 items-center pl-9">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-transparent py-1 text-xs text-muted-foreground opacity-0 transition-[color,background-color,border-color,opacity]',
          'hover:border-border hover:bg-muted/40 hover:text-foreground group-hover/add:opacity-100 focus-visible:opacity-100',
        )}
      >
        <Plus className="h-3.5 w-3.5" /> Add new block here
      </button>
    </div>
  )
}

function SortableCell({
  id, children,
}: {
  id: string
  children: (handle: React.HTMLAttributes<HTMLButtonElement>) => React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const handle = { ...attributes, ...listeners } as React.HTMLAttributes<HTMLButtonElement>
  return (
    <div ref={setNodeRef} style={style} className={isDragging ? 'opacity-60' : undefined}>
      {children(handle)}
    </div>
  )
}
