/**
 * Athena ↔ Notebook adapter: translates the generic authoring ops (from the template
 * registry) into this editor's native cell-ops, and serializes the notebook into the
 * generic AuthoringState the panel snapshots each turn.
 *
 * Pure + immutable (mirrors cell-ops), so it's unit-testable and the shell stays thin:
 * the shell just calls applyNotebookOps and drops the result into React state.
 *
 * This is the CLIENT write path for kind='notebook'. Nothing here persists — the shell's
 * existing autosave/Save commits, exactly as when the professor edits by hand.
 */
import {
  insertRelative,
  insertCell,
  updateSource,
  deleteCell,
  indexOfCell,
} from './cell-ops'
import type { StudioNotebook } from './notebook-model'
import type { NotebookOp } from '@/lib/ai/assignment-assistant/templates/registry'
import type { AuthoringState } from '@/lib/ai/assignment-assistant/schemas'

/** Per-cell content budget in the <screen> snapshot (keeps per-turn input flat). */
const CELL_PREVIEW_MAX = 1500

export function serializeNotebookForAthena(nb: StudioNotebook, title: string): AuthoringState {
  return {
    kind: 'notebook',
    meta: { title },
    components: nb.cells.map((c) => ({
      id: c.id,
      type: c.cell_type,
      content:
        c.source.length > CELL_PREVIEW_MAX ? `${c.source.slice(0, CELL_PREVIEW_MAX)}\n…(truncated)` : c.source,
    })),
  }
}

/** Move cell `id` to just after `afterId` (or to the top when afterId is absent). */
function moveAfter(nb: StudioNotebook, id: string, afterId?: string): StudioNotebook {
  const from = indexOfCell(nb, id)
  if (from === -1) return nb
  const cells = [...nb.cells]
  const [moved] = cells.splice(from, 1)
  let to = 0
  if (afterId) {
    const anchor = cells.findIndex((c) => c.id === afterId)
    to = anchor === -1 ? cells.length : anchor + 1
  }
  cells.splice(to, 0, moved)
  return { ...nb, cells }
}

/**
 * Apply a batch of notebook ops. Ops carry optional fields (the schema is flat for
 * Gemini reliability), so each op is validated here: one that lacks what it needs, or
 * targets a missing cell, is SKIPPED and NOT counted — so `changed` truthfully reflects
 * what landed (the panel reports applied:false when nothing did, never a false success).
 */
export function applyNotebookOps(
  nb: StudioNotebook,
  ops: NotebookOp[],
): { nb: StudioNotebook; title: string | null; summary: string; changed: number } {
  let next = nb
  let title: string | null = null
  const counts = { inserted: 0, updated: 0, removed: 0, reordered: 0, renamed: false }
  const has = (id?: string) => !!id && indexOfCell(next, id) !== -1

  for (const op of ops) {
    switch (op.op) {
      case 'insert': {
        if (!op.cellType || op.source === undefined) break
        const r =
          op.afterId && has(op.afterId)
            ? insertRelative(next, op.afterId, 'below', op.cellType)
            : insertCell(next, next.cells.length, op.cellType)
        next = updateSource(r.nb, r.id, op.source)
        counts.inserted++
        break
      }
      case 'update':
        if (op.source === undefined || !has(op.id)) break
        next = updateSource(next, op.id as string, op.source)
        counts.updated++
        break
      case 'remove': {
        if (!has(op.id)) break
        const before = next.cells.length
        next = deleteCell(next, op.id as string)
        if (next.cells.length < before) counts.removed++
        break
      }
      case 'reorder':
        if (!has(op.id)) break
        next = moveAfter(next, op.id as string, op.afterId)
        counts.reordered++
        break
      case 'setMeta':
        if (op.title) {
          title = op.title
          counts.renamed = true
        }
        break
    }
  }

  const parts: string[] = []
  if (counts.inserted) parts.push(`added ${counts.inserted} cell${counts.inserted > 1 ? 's' : ''}`)
  if (counts.updated) parts.push(`edited ${counts.updated} cell${counts.updated > 1 ? 's' : ''}`)
  if (counts.removed) parts.push(`removed ${counts.removed} cell${counts.removed > 1 ? 's' : ''}`)
  if (counts.reordered) parts.push(`reordered ${counts.reordered} cell${counts.reordered > 1 ? 's' : ''}`)
  if (counts.renamed) parts.push('renamed the assignment')
  const changed = counts.inserted + counts.updated + counts.removed + counts.reordered + (counts.renamed ? 1 : 0)
  const summary = parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'No matching cells to change'

  return { nb: next, title, summary, changed }
}
