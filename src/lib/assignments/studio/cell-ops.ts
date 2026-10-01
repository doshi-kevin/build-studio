/**
 * Pure, immutable cell operations over a StudioNotebook. Every function returns a NEW
 * notebook (never mutates) so React state updates and undo/history stay simple, and so
 * the ribbon, per-cell toolbars, and (later) the Athena seam all drive edits one way.
 *
 * Lock/collapse map onto real nbformat metadata (`editable`/`deletable`, `jupyter.
 * source_hidden`) so they survive the .ipynb round-trip instead of being UI-only state.
 */
import {
  type StudioCell,
  type StudioCellType,
  type StudioNotebook,
  genCellId,
} from './notebook-model'
import { type AuthoringMeta, setAuthoring } from './authoring'

export function newCell(cell_type: StudioCellType, source = ''): StudioCell {
  return {
    id: genCellId(),
    cell_type,
    source,
    metadata: {},
    outputs: [],
    execution_count: null,
  }
}

function withCells(nb: StudioNotebook, cells: StudioCell[]): StudioNotebook {
  return { ...nb, cells }
}

export function indexOfCell(nb: StudioNotebook, id: string): number {
  return nb.cells.findIndex((c) => c.id === id)
}

export function isLocked(cell: StudioCell): boolean {
  return cell.metadata.editable === false
}

export function isCollapsed(cell: StudioCell): boolean {
  const j = cell.metadata.jupyter
  return typeof j === 'object' && j !== null && (j as Record<string, unknown>).source_hidden === true
}

/** Insert a new cell at `atIndex` (clamped). Returns the notebook and the new cell id. */
export function insertCell(
  nb: StudioNotebook,
  atIndex: number,
  cell_type: StudioCellType,
): { nb: StudioNotebook; id: string } {
  const cell = newCell(cell_type)
  const i = Math.max(0, Math.min(atIndex, nb.cells.length))
  const cells = [...nb.cells.slice(0, i), cell, ...nb.cells.slice(i)]
  return { nb: withCells(nb, cells), id: cell.id }
}

/** Insert relative to a cell id ('above' | 'below'). */
export function insertRelative(
  nb: StudioNotebook,
  id: string,
  where: 'above' | 'below',
  cell_type: StudioCellType,
): { nb: StudioNotebook; id: string } {
  const idx = indexOfCell(nb, id)
  if (idx === -1) return insertCell(nb, nb.cells.length, cell_type)
  return insertCell(nb, where === 'above' ? idx : idx + 1, cell_type)
}

export function deleteCell(nb: StudioNotebook, id: string): StudioNotebook {
  const cell = nb.cells.find((c) => c.id === id)
  if (!cell || cell.metadata.deletable === false) return nb
  return withCells(nb, nb.cells.filter((c) => c.id !== id))
}

export function duplicateCell(nb: StudioNotebook, id: string): { nb: StudioNotebook; id: string } {
  const idx = indexOfCell(nb, id)
  if (idx === -1) return { nb, id }
  const src = nb.cells[idx]
  const copy: StudioCell = {
    ...src,
    id: genCellId(),
    outputs: [...src.outputs],
    metadata: { ...src.metadata },
  }
  const cells = [...nb.cells.slice(0, idx + 1), copy, ...nb.cells.slice(idx + 1)]
  return { nb: withCells(nb, cells), id: copy.id }
}

export function moveCell(nb: StudioNotebook, id: string, dir: 'up' | 'down'): StudioNotebook {
  const idx = indexOfCell(nb, id)
  if (idx === -1) return nb
  const target = dir === 'up' ? idx - 1 : idx + 1
  if (target < 0 || target >= nb.cells.length) return nb
  const cells = [...nb.cells]
  ;[cells[idx], cells[target]] = [cells[target], cells[idx]]
  return withCells(nb, cells)
}

/** Reorder by drag: move cell `fromId` to the slot currently held by `toId`. */
export function reorderCells(nb: StudioNotebook, fromId: string, toId: string): StudioNotebook {
  const from = indexOfCell(nb, fromId)
  const to = indexOfCell(nb, toId)
  if (from === -1 || to === -1 || from === to) return nb
  const cells = [...nb.cells]
  const [moved] = cells.splice(from, 1)
  cells.splice(to, 0, moved)
  return withCells(nb, cells)
}

export function updateSource(nb: StudioNotebook, id: string, source: string): StudioNotebook {
  return withCells(
    nb,
    nb.cells.map((c) => (c.id === id && !isLocked(c) ? { ...c, source } : c)),
  )
}

export function changeCellType(nb: StudioNotebook, id: string, cell_type: StudioCellType): StudioNotebook {
  return withCells(
    nb,
    nb.cells.map((c) =>
      c.id === id
        ? // Switching to markdown/raw drops code-only fields; back to code starts clean.
          cell_type === 'code'
          ? { ...c, cell_type }
          : { ...c, cell_type, outputs: [], execution_count: null }
        : c,
    ),
  )
}

/** Split one cell into two at a character offset. The new cell takes the tail. */
export function splitCell(nb: StudioNotebook, id: string, offset: number): { nb: StudioNotebook; id: string } {
  const idx = indexOfCell(nb, id)
  if (idx === -1) return { nb, id }
  const cell = nb.cells[idx]
  if (isLocked(cell)) return { nb, id }
  const head = cell.source.slice(0, offset)
  const tail = cell.source.slice(offset)
  const tailCell = newCell(cell.cell_type, tail)
  const headCell: StudioCell = { ...cell, source: head }
  const cells = [...nb.cells.slice(0, idx), headCell, tailCell, ...nb.cells.slice(idx + 1)]
  return { nb: withCells(nb, cells), id: tailCell.id }
}

/** Merge a cell with the one below it (source joined by a newline; keeps top cell's type). */
export function mergeCellBelow(nb: StudioNotebook, id: string): StudioNotebook {
  const idx = indexOfCell(nb, id)
  if (idx === -1 || idx === nb.cells.length - 1) return nb
  const top = nb.cells[idx]
  const below = nb.cells[idx + 1]
  if (isLocked(top) || isLocked(below)) return nb
  const merged: StudioCell = {
    ...top,
    source: top.source + (top.source.endsWith('\n') ? '' : '\n') + below.source,
  }
  const cells = [...nb.cells.slice(0, idx), merged, ...nb.cells.slice(idx + 2)]
  return withCells(nb, cells)
}

function setCellMeta(
  nb: StudioNotebook,
  id: string,
  fn: (meta: Record<string, unknown>) => Record<string, unknown>,
): StudioNotebook {
  return withCells(
    nb,
    nb.cells.map((c) => (c.id === id ? { ...c, metadata: fn({ ...c.metadata }) } : c)),
  )
}

export function toggleCollapsed(nb: StudioNotebook, id: string): StudioNotebook {
  return setCellMeta(nb, id, (meta) => {
    const j = (typeof meta.jupyter === 'object' && meta.jupyter ? meta.jupyter : {}) as Record<string, unknown>
    meta.jupyter = { ...j, source_hidden: !(j.source_hidden === true) }
    return meta
  })
}

export function toggleLocked(nb: StudioNotebook, id: string): StudioNotebook {
  return setCellMeta(nb, id, (meta) => {
    const lock = meta.editable === false
    if (lock) {
      delete meta.editable
      delete meta.deletable
    } else {
      meta.editable = false
      meta.deletable = false
    }
    return meta
  })
}

export function clearOutputs(nb: StudioNotebook, id: string): StudioNotebook {
  return withCells(
    nb,
    nb.cells.map((c) => (c.id === id ? { ...c, outputs: [], execution_count: null } : c)),
  )
}

export function clearAllOutputs(nb: StudioNotebook): StudioNotebook {
  return withCells(
    nb,
    nb.cells.map((c) => (c.cell_type === 'code' ? { ...c, outputs: [], execution_count: null } : c)),
  )
}

/** Shared authoring meta on a cell — stored in metadata.studio (round-trips in .ipynb). */
export function setCellAuthoring(nb: StudioNotebook, id: string, meta: AuthoringMeta): StudioNotebook {
  return withCells(
    nb,
    nb.cells.map((c) => (c.id === id ? { ...c, metadata: setAuthoring(c.metadata, meta) } : c)),
  )
}
