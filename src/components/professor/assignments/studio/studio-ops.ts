/**
 * The single callback contract the ribbon, canvas, and per-cell toolbars all drive edits
 * through. Centralised so the UI never touches notebook state directly — the shell owns
 * state and implements these by composing the pure functions in `lib/.../cell-ops`.
 */
import type { StudioCellType } from '@/lib/assignments/studio/notebook-model'
import type { AuthoringMeta } from '@/lib/assignments/studio/authoring'

export interface CellOps {
  setSource: (id: string, source: string) => void
  insert: (where: 'above' | 'below', type: StudioCellType, refId?: string | null) => void
  remove: (id: string) => void
  duplicate: (id: string) => void
  move: (id: string, dir: 'up' | 'down') => void
  reorder: (fromId: string, toId: string) => void
  changeType: (id: string, type: StudioCellType) => void
  split: (id: string, offset: number) => void
  mergeBelow: (id: string) => void
  toggleCollapse: (id: string) => void
  toggleLock: (id: string) => void
  clearOutputs: (id: string) => void
  /** Shared authoring meta (points / explanation / hints / concept tags) on any block. */
  setAuthoring: (id: string, meta: AuthoringMeta) => void
}

/** Insert/Format engine — applies snippet edits to the active cell's textarea. */
export interface EditorOps {
  /** Insert text at the cursor of the focused cell. */
  insert: (text: string) => void
  /** Wrap the selection (or a placeholder) with pre/suf markers. */
  wrap: (pre: string, suf: string, placeholder?: string) => void
  /** Prepend a prefix at the start of the current line (headings, lists, quotes). */
  linePrefix: (prefix: string) => void
}

/** Quick cell actions on the selected block (full controls live in the Inspector). */
export interface AssessOps {
  cycleDifficulty: () => void
  toggleGraded: () => void
  /** Append a new (empty) hint to the selected cell; the professor fills it in the Inspector. */
  addHint: () => void
}

/** Document / view-level actions the ribbon drives (owned by the shell). All REAL. */
export interface DocActions {
  rename: () => void
  openFile: () => void
  download: () => void
  exportHtml: () => void
  clearAllOutputs: () => void
  collapseAll: () => void
  expandAll: () => void
  togglePreview: () => void
  toggleRail: () => void
}
