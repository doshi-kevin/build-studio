import { describe, expect, it } from 'vitest'
import {
  decide,
  type CollectionAccess,
  type InstallationState,
  type RecordOperation,
  type ViewerRole,
} from '@/lib/studio/policy'

// The approved access table (docs/reference/studio-plugin-server.md), written out cell by
// cell rather than derived, so this test is the specification and not a copy of the code.
// own: allowed, limited to and stamped with the viewer's own records.
// all: allowed, no owner filter.  -: refused.
type Cell = 'own' | 'all' | '-'
const ROLES: ViewerRole[] = ['student', 'professor', 'ta', 'grader']
type Row = [Cell, Cell, Cell, Cell]
type Table = Record<CollectionAccess, Record<RecordOperation, Row>>

const ACTIVE: Table = {
  perStudent: {
    list: ['own', 'all', 'all', 'all'],
    get: ['own', 'all', 'all', 'all'],
    create: ['own', '-', '-', '-'],
    update: ['own', '-', '-', '-'],
    delete: ['own', '-', '-', '-'],
  },
  shared: {
    list: ['all', 'all', 'all', 'all'],
    get: ['all', 'all', 'all', 'all'],
    create: ['-', 'all', 'all', '-'],
    update: ['-', 'all', 'all', '-'],
    delete: ['-', 'all', 'all', '-'],
  },
  staffOnly: {
    list: ['-', 'all', 'all', 'all'],
    get: ['-', 'all', 'all', 'all'],
    create: ['-', 'all', 'all', '-'],
    update: ['-', 'all', 'all', '-'],
    delete: ['-', 'all', 'all', '-'],
  },
}

// Archived: still readable by whoever could read it, writable by nobody.
const ARCHIVED: Table = {
  perStudent: {
    list: ['own', 'all', 'all', 'all'],
    get: ['own', 'all', 'all', 'all'],
    create: ['-', '-', '-', '-'],
    update: ['-', '-', '-', '-'],
    delete: ['-', '-', '-', '-'],
  },
  shared: {
    list: ['all', 'all', 'all', 'all'],
    get: ['all', 'all', 'all', 'all'],
    create: ['-', '-', '-', '-'],
    update: ['-', '-', '-', '-'],
    delete: ['-', '-', '-', '-'],
  },
  staffOnly: {
    list: ['-', 'all', 'all', 'all'],
    get: ['-', 'all', 'all', 'all'],
    create: ['-', '-', '-', '-'],
    update: ['-', '-', '-', '-'],
    delete: ['-', '-', '-', '-'],
  },
}

const EXPECTED = {
  own: { allow: true, ownerFilter: 'self', ownerStamp: 'self' },
  all: { allow: true, ownerFilter: 'none', ownerStamp: 'none' },
  '-': { allow: false },
} as const

const cases = (Object.entries({ active: ACTIVE, archived: ARCHIVED }) as [InstallationState, Table][]).flatMap(
  ([state, table]) =>
    (Object.entries(table) as [CollectionAccess, Record<RecordOperation, Row>][]).flatMap(([access, ops]) =>
      (Object.entries(ops) as [RecordOperation, Row][]).flatMap(([operation, row]) =>
        ROLES.map((role, i) => ({ state, access, operation, role, cell: row[i] })),
      ),
    ),
)

describe('decide', () => {
  it('covers every role, access rule, operation and state', () => {
    expect(cases).toHaveLength(4 * 3 * 5 * 2)
  })

  it.each(cases)('$state $access $operation as $role: $cell', ({ state, access, operation, role, cell }) => {
    expect(decide(role, access, operation, state)).toEqual(EXPECTED[cell])
  })
})
