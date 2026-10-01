/**
 * The Modules page's top-level list: module sections with divider rows between
 * them. Both roles render the same sequence, so the merge lives here.
 *
 * Modules and dividers share ONE position scale (see reorderModules), which is
 * also what the roadmap reads to place its divider annotations — so the order a
 * student sees on the modules page and on the roadmap is the same order.
 */

export interface ModuleDivider {
  id: string
  title: string
  position: number
}

/** Columns a student is allowed to see of a divider — it is only a label. */
export const MODULE_DIVIDER_COLUMNS = 'id, title, position'

export type ModuleRow<M> =
  | { kind: 'module'; id: string; position: number; module: M }
  | { kind: 'divider'; id: string; position: number; divider: ModuleDivider }

/**
 * Interleave modules and dividers by their shared position scale.
 *
 * Modules win a position tie: a new module takes max(position)+1, which can
 * collide with a divider already sitting there until the next drag rewrites
 * both.
 */
export function mergeModuleRows<M extends { id: string; position: number | null }>(
  modules: M[],
  dividers: ModuleDivider[],
): ModuleRow<M>[] {
  const merged: ModuleRow<M>[] = [
    ...modules.map(
      (m): ModuleRow<M> => ({ kind: 'module', id: m.id, position: m.position ?? 0, module: m }),
    ),
    // `?? 0` on both sides: a null on either would make the subtraction NaN and
    // hand Array.sort an inconsistent comparator, scattering rows arbitrarily.
    ...dividers.map(
      (d): ModuleRow<M> => ({ kind: 'divider', id: d.id, position: d.position ?? 0, divider: d }),
    ),
  ]
  return merged.sort(
    (a, b) => a.position - b.position || (a.kind === b.kind ? 0 : a.kind === 'module' ? -1 : 1),
  )
}

/**
 * Drop dividers that label nothing.
 *
 * A divider heads the modules that follow it, so it is empty exactly when the
 * next row is another divider or the end of the list. Students only see
 * published modules, so an unpublished group leaves its heading stranded —
 * "Unit 2" with no Unit 2 under it reads as a bug, not as a hidden module.
 */
export function dropEmptyDividerGroups<M>(rows: ModuleRow<M>[]): ModuleRow<M>[] {
  return rows.filter((row, i) => row.kind !== 'divider' || rows[i + 1]?.kind === 'module')
}

/** A row of the order sent to `reorderModules`. */
export interface ModuleRowEntry {
  id: string
  kind: 'module' | 'divider'
}

/**
 * The order that puts an undone divider deletion back where it was.
 *
 * Undo re-creates the divider (it appends at the end) and then reorders. The
 * tricky part is that the toast fires after the delete revalidated, so `rows`
 * may or may not still hold the deleted divider — filtering BOTH ids out makes
 * the two cases produce the same order. `index` is clamped, so a stale index
 * appends rather than dropping the divider.
 */
export function dividerRestoreOrder<M>(
  rows: ModuleRow<M>[],
  deletedId: string,
  newId: string,
  index: number,
): ModuleRowEntry[] {
  const order = rows
    .filter((r) => r.id !== deletedId && r.id !== newId)
    .map((r): ModuleRowEntry => ({ id: r.id, kind: r.kind }))
  order.splice(Math.max(0, Math.min(index, order.length)), 0, { id: newId, kind: 'divider' })
  return order
}
