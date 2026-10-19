import { describe, expect, it } from 'vitest'
import {
  decide,
  decideForFrame,
  decideForServer,
  type CollectionAccess,
  type WriteMode,
  type RecordOperation,
  type ViewerRole,
} from '@/lib/studio/policy'

// The approved access table (docs/reference/studio-plugin-server.md), written out cell by
// cell rather than derived, so this test is the specification and not a copy of the code.
// own: allowed, limited to and stamped with the viewer's own records.
// all: allowed, no owner filter.
// about: allowed, no owner filter, a created record is owned by the student it names.
// -: refused.
type Cell = 'own' | 'all' | 'about' | '-'
const ROLES: ViewerRole[] = ['student', 'professor', 'ta', 'grader']
type Row = [Cell, Cell, Cell, Cell]
type Table = Record<CollectionAccess, Record<RecordOperation, Row>>

const WRITABLE: Table = {
  perStudent: {
    list: ['own', 'all', 'all', 'all'],
    get: ['own', 'all', 'all', 'all'],
    create: ['own', '-', '-', '-'],
    update: ['own', '-', '-', '-'],
    delete: ['own', '-', '-', '-'],
  },
  staffPerStudent: {
    list: ['own', 'all', 'all', 'all'],
    get: ['own', 'all', 'all', 'all'],
    create: ['-', 'about', 'about', '-'],
    update: ['-', 'about', 'about', '-'],
    delete: ['-', 'about', 'about', '-'],
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

// Read-only (archived installation or section, lost entitlement, completed enrollment):
// still readable by whoever could read it, writable by nobody.
const READ_ONLY: Table = {
  perStudent: {
    list: ['own', 'all', 'all', 'all'],
    get: ['own', 'all', 'all', 'all'],
    create: ['-', '-', '-', '-'],
    update: ['-', '-', '-', '-'],
    delete: ['-', '-', '-', '-'],
  },
  staffPerStudent: {
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
  about: { allow: true, ownerFilter: 'none', ownerStamp: 'student' },
  '-': { allow: false },
} as const

const cases = (Object.entries({ writable: WRITABLE, readOnly: READ_ONLY }) as [WriteMode, Table][]).flatMap(
  ([mode, table]) =>
    (Object.entries(table) as [CollectionAccess, Record<RecordOperation, Row>][]).flatMap(([access, ops]) =>
      (Object.entries(ops) as [RecordOperation, Row][]).flatMap(([operation, row]) =>
        ROLES.map((role, i) => ({ mode, access, operation, role, cell: row[i] })),
      ),
    ),
)

describe('server and frame rules', () => {
  it('a declared read never grants a write, and server-written collections refuse every frame', () => {
    const key = { access: 'staffOnly' } as const
    const attempts = { access: 'perStudent', writes: 'server' } as const
    expect(decideForServer('student', key, 'list', 'writable', true).allow).toBe(true)
    expect(decideForServer('student', key, 'list', 'writable', false).allow).toBe(false)
    for (const op of ['create', 'update', 'delete'] as const) expect(decideForServer('student', key, op, 'writable', true).allow).toBe(false)
    expect(decideForServer('student', attempts, 'create', 'writable', false).allow).toBe(true)
    for (const role of ['student', 'professor', 'ta'] as const) expect(decideForFrame(role, attempts, 'create', 'writable').allow).toBe(false)
    expect(decideForFrame('student', attempts, 'list', 'writable')).toEqual(decide('student', 'perStudent', 'list', 'writable'))
  })
})

describe('decide', () => {
  it('covers every role, access rule, operation and write mode', () => {
    expect(cases).toHaveLength(4 * 4 * 5 * 2)
  })

  it.each(cases)('$mode $access $operation as $role: $cell', ({ mode, access, operation, role, cell }) => {
    expect(decide(role, access, operation, mode)).toEqual(EXPECTED[cell])
  })
})
