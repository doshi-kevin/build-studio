/**
 * The Modules page's top-level row list — shared by the professor board and the
 * student list, so a bug here shows up on two pages and on the roadmap (which
 * reads the same position scale).
 */
import { describe, it, expect } from 'vitest'
import {
  mergeModuleRows,
  dropEmptyDividerGroups,
  dividerRestoreOrder,
  type ModuleRow,
} from '@/components/shared/modules/module-rows'

interface TestModule {
  id: string
  position: number | null
}

const mod = (id: string, position: number | null): TestModule => ({ id, position })
const div = (id: string, position: number) => ({ id, title: id.toUpperCase(), position })

/** Compact shape for asserting an order: ['m:a', 'd:x', …] */
const shape = (rows: ModuleRow<TestModule>[]) =>
  rows.map((r) => `${r.kind === 'module' ? 'm' : 'd'}:${r.id}`)

describe('mergeModuleRows', () => {
  it('interleaves modules and dividers by the shared position scale', () => {
    const rows = mergeModuleRows(
      [mod('a', 0), mod('b', 2), mod('c', 4)],
      [div('x', 1), div('y', 3)],
    )
    expect(shape(rows)).toEqual(['m:a', 'd:x', 'm:b', 'd:y', 'm:c'])
  })

  it('puts a module before a divider on a position tie', () => {
    // A new module takes max(position)+1, which can land on a divider's
    // position until the next drag rewrites both tables.
    const rows = mergeModuleRows([mod('new', 3)], [div('x', 3)])
    expect(shape(rows)).toEqual(['m:new', 'd:x'])
  })

  it('treats a null module position as 0 rather than dropping the module', () => {
    const rows = mergeModuleRows([mod('a', null)], [div('x', 1)])
    expect(shape(rows)).toEqual(['m:a', 'd:x'])
  })
})

describe('dropEmptyDividerGroups', () => {
  it('drops a divider whose group has no modules under it', () => {
    // What a student sees when the professor hasn't published Unit 2 yet.
    const rows = mergeModuleRows([mod('a', 0)], [div('unit1', 1), div('unit2', 2)])
    expect(shape(dropEmptyDividerGroups(rows))).toEqual(['m:a'])
  })

  it('drops a trailing divider', () => {
    const rows = mergeModuleRows([mod('a', 0)], [div('x', 1)])
    expect(shape(dropEmptyDividerGroups(rows))).toEqual(['m:a'])
  })

  it('keeps a divider that heads at least one module', () => {
    const rows = mergeModuleRows([mod('a', 1)], [div('x', 0)])
    expect(shape(dropEmptyDividerGroups(rows))).toEqual(['d:x', 'm:a'])
  })

  it('collapses a run of dividers down to the one that heads the modules', () => {
    const rows = mergeModuleRows([mod('a', 3)], [div('x', 0), div('y', 1), div('z', 2)])
    expect(shape(dropEmptyDividerGroups(rows))).toEqual(['d:z', 'm:a'])
  })
})

describe('dividerRestoreOrder', () => {
  const rowsWith = mergeModuleRows(
    [mod('a', 0), mod('b', 2)],
    [div('gone', 1)],
  )
  const rowsWithout = mergeModuleRows([mod('a', 0), mod('b', 2)], [])

  it('produces the same order whether or not the delete has revalidated yet', () => {
    // The undo fires from a toast, so `rows` may still hold the deleted divider
    // or may not — both paths have to put the new one in the same place.
    const stale = dividerRestoreOrder(rowsWith, 'gone', 'fresh', 1)
    const fresh = dividerRestoreOrder(rowsWithout, 'gone', 'fresh', 1)
    expect(stale).toEqual(fresh)
  })

  it('puts the divider back between the same two modules', () => {
    expect(dividerRestoreOrder(rowsWith, 'gone', 'fresh', 1)).toEqual([
      { id: 'a', kind: 'module' },
      { id: 'fresh', kind: 'divider' },
      { id: 'b', kind: 'module' },
    ])
  })

  it('appends rather than losing the divider when the index is stale', () => {
    const order = dividerRestoreOrder(rowsWithout, 'gone', 'fresh', 99)
    expect(order.at(-1)).toEqual({ id: 'fresh', kind: 'divider' })
    expect(order).toHaveLength(3)
  })

  it('never emits the new id twice', () => {
    // Restore can race the revalidation that already added the new row.
    const withFresh = mergeModuleRows([mod('a', 0)], [div('fresh', 1)])
    const order = dividerRestoreOrder(withFresh, 'gone', 'fresh', 0)
    expect(order.filter((e) => e.id === 'fresh')).toHaveLength(1)
  })
})
