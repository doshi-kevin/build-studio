// Tests for module item type enum — validates the 7 allowed item types and rejects
// invalid ones. Also pins the product decision that 'assignment' is intentionally
// absent from the picker registry while remaining a valid legacy item_type.

import { describe, it, expect } from 'vitest'
import {
  MODULE_ITEM_TYPES,
  MODULE_ITEM_TYPE_INFO,
  createModuleItemSchema,
  moduleDividerSchema,
  reorderModuleListSchema,
} from '@/lib/validations/module'

describe('createModuleItemSchema', () => {
  const parse = (data: unknown) => createModuleItemSchema.safeParse(data)

  it('accepts all valid item types', () => {
    for (const item_type of ['lecture', 'video', 'image', 'reference', 'assignment', 'note', 'link', 'section_divider']) {
      expect(parse({
        item_type,
        content: {},
        is_visible: true,
      }).success).toBe(true)
    }
  })

  it('rejects invalid item_type', () => {
    expect(parse({
      item_type: 'podcast',
      content: {},
      is_visible: true,
    }).success).toBe(false)
  })
})

describe('MODULE_ITEM_TYPE_INFO picker registry', () => {
  // Regression guard: 'assignment' and 'link' are intentionally removed from the
  // picker (assignments live in the dedicated Assignments tab; a link is just a
  // Reference), but both MUST stay valid in MODULE_ITEM_TYPES so legacy items
  // keep parsing/editing.
  it('omits "assignment" and "link" from the picker', () => {
    const keys = MODULE_ITEM_TYPE_INFO.map((info) => info.key)
    expect(keys).not.toContain('assignment')
    expect(keys).not.toContain('link')
  })

  it('still allows "assignment" and "link" as legacy item_types at the schema level', () => {
    expect(MODULE_ITEM_TYPES).toContain('assignment')
    expect(MODULE_ITEM_TYPES).toContain('link')
  })

  it('exposes "image" as a new picker type that is also schema-valid', () => {
    const keys = MODULE_ITEM_TYPE_INFO.map((info) => info.key)
    expect(keys).toContain('image')
    expect(MODULE_ITEM_TYPES).toContain('image')
  })

  it('every picker entry is a valid ModuleItemType', () => {
    for (const info of MODULE_ITEM_TYPE_INFO) {
      expect(MODULE_ITEM_TYPES).toContain(info.key)
    }
  })
})

// The two schemas behind the Modules page divider row. Both guard a server action
// whose only input validation they ARE, so the boundaries are the contract.
describe('moduleDividerSchema', () => {
  const parse = (title: unknown) => moduleDividerSchema.safeParse({ title })

  it('accepts a label and trims surrounding space', () => {
    const res = parse('  Midterm  ')
    expect(res.success && res.data.title).toBe('Midterm')
  })

  it('rejects an empty or whitespace-only label', () => {
    // Whitespace-only matters on its own: the dialog disables submit on it, but the
    // action is the trust boundary, and a blank label draws a pen line with no text.
    expect(parse('').success).toBe(false)
    expect(parse('   ').success).toBe(false)
    expect(parse('\t\n').success).toBe(false)
  })

  // 40, not an arbitrary round number: past ~40 italic characters the label
  // ellipsises inside the roadmap's 300px materials lane, where the node is
  // pointer-events:none so no tooltip can reveal the rest.
  it('accepts 40 characters and rejects 41', () => {
    expect(parse('a'.repeat(40)).success).toBe(true)
    expect(parse('a'.repeat(41)).success).toBe(false)
  })

  it('rejects a missing or non-string label', () => {
    expect(moduleDividerSchema.safeParse({}).success).toBe(false)
    expect(parse(42).success).toBe(false)
  })
})

describe('reorderModuleListSchema', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const entry = (n: number, kind = 'module') => ({ id: uuid(n), kind })

  it('accepts a mixed module/divider order', () => {
    expect(reorderModuleListSchema.safeParse([entry(1), entry(2, 'divider')]).success).toBe(true)
    expect(reorderModuleListSchema.safeParse([]).success).toBe(true)
  })

  it('rejects a non-uuid id and an unknown kind', () => {
    expect(reorderModuleListSchema.safeParse([{ id: 'mod-1', kind: 'module' }]).success).toBe(false)
    expect(reorderModuleListSchema.safeParse([{ id: uuid(1), kind: 'lecture' }]).success).toBe(false)
  })

  // Each entry becomes its own UPDATE, so the cap is what stops one request from
  // fanning out into unbounded round trips.
  it('caps the list at 200 rows', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => entry(i))
    expect(reorderModuleListSchema.safeParse(rows(200)).success).toBe(true)
    expect(reorderModuleListSchema.safeParse(rows(201)).success).toBe(false)
  })
})
