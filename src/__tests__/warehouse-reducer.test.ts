// Tests for warehouseReducer — professor knowledge warehouse state machine.
// Covers file CRUD, course/term management, UI state, and bulk operations.

import { describe, it, expect } from 'vitest'
import {
  warehouseReducer,
  initialWarehouseState,
  type WarehouseState,
} from '@/components/professor/warehouse/warehouse-context/use-warehouse-reducer'
import type { WarehouseFile, WarehouseCourse, WarehouseTerm } from '@/lib/validations/warehouse'

// ── Helpers ──────────────────────────────────────────────────

function buildFile(overrides: Partial<WarehouseFile> = {}): WarehouseFile {
  return {
    id: 'file-1',
    name: 'lecture-notes.pdf',
    fileType: 'pdf',
    mimeType: 'application/pdf',
    courseId: null,
    termId: null,
    week: null,
    topic: '',
    tags: [],
    note: '',
    size: 1024,
    favorite: false,
    usedInCourseIds: [],
    fileUrl: null,
    filePath: null,
    createdAt: '2026-01-01T00:00:00Z',
    lastUsedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function buildCourse(overrides: Partial<WarehouseCourse> = {}): WarehouseCourse {
  return {
    id: 'course-1',
    name: 'Data Structures',
    code: 'CS201',
    sectionId: null,
    ...overrides,
  }
}

function buildTerm(overrides: Partial<WarehouseTerm> = {}): WarehouseTerm {
  return {
    id: 'term-1',
    label: 'Fall 2026',
    semester: 'fall',
    year: 2026,
    ...overrides,
  }
}

function stateWith(overrides: Partial<WarehouseState> = {}): WarehouseState {
  return { ...initialWarehouseState, ...overrides }
}

// ── File Operations ──────────────────────────────────────────

describe('ADD_FILE', () => {
  it('adds a file and sets isDirty', () => {
    const file = buildFile({ id: 'f-new' })
    const result = warehouseReducer(initialWarehouseState, {
      type: 'ADD_FILE',
      payload: { file },
    })
    expect(result.files['f-new']).toEqual(file)
    expect(result.isDirty).toBe(true)
  })
})

describe('UPDATE_FILE', () => {
  it('replaces a file entry', () => {
    const state = stateWith({ files: { 'f-1': buildFile({ name: 'old.pdf' }) } })
    const updated = buildFile({ name: 'new.pdf' })
    const result = warehouseReducer(state, {
      type: 'UPDATE_FILE',
      payload: { file: updated },
    })
    expect(result.files['file-1'].name).toBe('new.pdf')
    expect(result.isDirty).toBe(true)
  })
})

describe('REMOVE_FILE', () => {
  it('removes a file by id', () => {
    const state = stateWith({
      files: {
        'f-1': buildFile({ id: 'f-1' }),
        'f-2': buildFile({ id: 'f-2' }),
      },
    })
    const result = warehouseReducer(state, {
      type: 'REMOVE_FILE',
      payload: { fileId: 'f-1' },
    })
    expect(result.files['f-1']).toBeUndefined()
    expect(result.files['f-2']).toBeDefined()
    expect(result.isDirty).toBe(true)
  })

  it('clears selectedFileId when removing the selected file', () => {
    const state = stateWith({
      files: { 'f-1': buildFile({ id: 'f-1' }) },
      selectedFileId: 'f-1',
    })
    const result = warehouseReducer(state, {
      type: 'REMOVE_FILE',
      payload: { fileId: 'f-1' },
    })
    expect(result.selectedFileId).toBeNull()
  })

  it('preserves selectedFileId when removing a different file', () => {
    const state = stateWith({
      files: {
        'f-1': buildFile({ id: 'f-1' }),
        'f-2': buildFile({ id: 'f-2' }),
      },
      selectedFileId: 'f-2',
    })
    const result = warehouseReducer(state, {
      type: 'REMOVE_FILE',
      payload: { fileId: 'f-1' },
    })
    expect(result.selectedFileId).toBe('f-2')
  })
})

describe('DUPLICATE_FILE', () => {
  it('adds the new file to state', () => {
    const original = buildFile({ id: 'f-orig' })
    const newFile = buildFile({ id: 'f-copy', name: 'lecture-notes (copy).pdf' })
    const state = stateWith({ files: { 'f-orig': original } })

    const result = warehouseReducer(state, {
      type: 'DUPLICATE_FILE',
      payload: { originalId: 'f-orig', newFile },
    })
    expect(result.files['f-copy']).toEqual(newFile)
    expect(result.files['f-orig']).toEqual(original)
    expect(result.isDirty).toBe(true)
  })
})

describe('MOVE_FILE', () => {
  it('updates courseId and week', () => {
    const file = buildFile({ id: 'f-1', courseId: null, week: null })
    const state = stateWith({ files: { 'f-1': file } })

    const result = warehouseReducer(state, {
      type: 'MOVE_FILE',
      payload: { fileId: 'f-1', courseId: 'course-1', week: 3 },
    })
    expect(result.files['f-1'].courseId).toBe('course-1')
    expect(result.files['f-1'].week).toBe(3)
    expect(result.isDirty).toBe(true)
  })

  it('preserves existing topic when topic is not provided', () => {
    const file = buildFile({ id: 'f-1', topic: 'existing topic' })
    const state = stateWith({ files: { 'f-1': file } })

    const result = warehouseReducer(state, {
      type: 'MOVE_FILE',
      payload: { fileId: 'f-1', courseId: 'course-1', week: 1 },
    })
    expect(result.files['f-1'].topic).toBe('existing topic')
  })

  it('overrides topic when provided', () => {
    const file = buildFile({ id: 'f-1', topic: 'old' })
    const state = stateWith({ files: { 'f-1': file } })

    const result = warehouseReducer(state, {
      type: 'MOVE_FILE',
      payload: { fileId: 'f-1', courseId: null, week: null, topic: 'new topic' },
    })
    expect(result.files['f-1'].topic).toBe('new topic')
  })

  it('returns state unchanged when file not found', () => {
    const state = stateWith()
    const result = warehouseReducer(state, {
      type: 'MOVE_FILE',
      payload: { fileId: 'nonexistent', courseId: null, week: null },
    })
    expect(result).toBe(state)
  })
})

describe('TOGGLE_FAVORITE', () => {
  it('toggles favorite from false to true', () => {
    const file = buildFile({ id: 'f-1', favorite: false })
    const state = stateWith({ files: { 'f-1': file } })

    const result = warehouseReducer(state, {
      type: 'TOGGLE_FAVORITE',
      payload: { fileId: 'f-1' },
    })
    expect(result.files['f-1'].favorite).toBe(true)
    expect(result.isDirty).toBe(true)
  })

  it('toggles favorite from true to false', () => {
    const file = buildFile({ id: 'f-1', favorite: true })
    const state = stateWith({ files: { 'f-1': file } })

    const result = warehouseReducer(state, {
      type: 'TOGGLE_FAVORITE',
      payload: { fileId: 'f-1' },
    })
    expect(result.files['f-1'].favorite).toBe(false)
  })

  it('returns state unchanged when file not found', () => {
    const state = stateWith()
    const result = warehouseReducer(state, {
      type: 'TOGGLE_FAVORITE',
      payload: { fileId: 'nonexistent' },
    })
    expect(result).toBe(state)
  })
})

describe('UPDATE_NOTE', () => {
  it('updates file note', () => {
    const file = buildFile({ id: 'f-1', note: '' })
    const state = stateWith({ files: { 'f-1': file } })

    const result = warehouseReducer(state, {
      type: 'UPDATE_NOTE',
      payload: { fileId: 'f-1', note: 'Important file' },
    })
    expect(result.files['f-1'].note).toBe('Important file')
    expect(result.isDirty).toBe(true)
  })

  it('returns state unchanged when file not found', () => {
    const state = stateWith()
    const result = warehouseReducer(state, {
      type: 'UPDATE_NOTE',
      payload: { fileId: 'nonexistent', note: 'test' },
    })
    expect(result).toBe(state)
  })
})

// ── Course Operations ────────────────────────────────────────

describe('ADD_COURSE', () => {
  it('adds a course and sets isDirty', () => {
    const course = buildCourse({ id: 'c-new' })
    const result = warehouseReducer(initialWarehouseState, {
      type: 'ADD_COURSE',
      payload: { course },
    })
    expect(result.courses['c-new']).toEqual(course)
    expect(result.isDirty).toBe(true)
  })
})

describe('REMOVE_COURSE', () => {
  it('removes course and unassigns files from it', () => {
    const course = buildCourse({ id: 'c-1' })
    const assignedFile = buildFile({ id: 'f-1', courseId: 'c-1' })
    const unassignedFile = buildFile({ id: 'f-2', courseId: null })
    const otherCourseFile = buildFile({ id: 'f-3', courseId: 'c-other' })
    const state = stateWith({
      courses: { 'c-1': course },
      files: { 'f-1': assignedFile, 'f-2': unassignedFile, 'f-3': otherCourseFile },
    })

    const result = warehouseReducer(state, {
      type: 'REMOVE_COURSE',
      payload: { courseId: 'c-1' },
    })
    expect(result.courses['c-1']).toBeUndefined()
    expect(result.files['f-1'].courseId).toBeNull() // unassigned
    expect(result.files['f-2'].courseId).toBeNull() // unchanged
    expect(result.files['f-3'].courseId).toBe('c-other') // unchanged
    expect(result.isDirty).toBe(true)
  })
})

describe('CLEAR_SHELF', () => {
  it('removes all files for a specific course', () => {
    const state = stateWith({
      files: {
        'f-1': buildFile({ id: 'f-1', courseId: 'c-1' }),
        'f-2': buildFile({ id: 'f-2', courseId: 'c-1' }),
        'f-3': buildFile({ id: 'f-3', courseId: 'c-2' }),
      },
    })
    const result = warehouseReducer(state, {
      type: 'CLEAR_SHELF',
      payload: { courseId: 'c-1' },
    })
    expect(result.files['f-1']).toBeUndefined()
    expect(result.files['f-2']).toBeUndefined()
    expect(result.files['f-3']).toBeDefined()
    expect(result.isDirty).toBe(true)
  })

  it('removes unsorted files when courseId is null', () => {
    const state = stateWith({
      files: {
        'f-1': buildFile({ id: 'f-1', courseId: null }),
        'f-2': buildFile({ id: 'f-2', courseId: 'c-1' }),
      },
    })
    const result = warehouseReducer(state, {
      type: 'CLEAR_SHELF',
      payload: { courseId: null },
    })
    expect(result.files['f-1']).toBeUndefined() // unsorted → deleted
    expect(result.files['f-2']).toBeDefined() // assigned → kept
  })
})

// ── Term Operations ──────────────────────────────────────────

describe('ADD_TERM', () => {
  it('adds a term and sets isDirty', () => {
    const term = buildTerm({ id: 't-new' })
    const result = warehouseReducer(initialWarehouseState, {
      type: 'ADD_TERM',
      payload: { term },
    })
    expect(result.terms['t-new']).toEqual(term)
    expect(result.isDirty).toBe(true)
  })
})


// ── Bulk Operations ──────────────────────────────────────────

describe('SET_DATA', () => {
  it('converts arrays to records', () => {
    const result = warehouseReducer(initialWarehouseState, {
      type: 'SET_DATA',
      payload: {
        files: [buildFile({ id: 'f-1' }), buildFile({ id: 'f-2' })],
        courses: [buildCourse({ id: 'c-1' })],
        terms: [buildTerm({ id: 't-1' })],
      },
    })
    expect(Object.keys(result.files)).toEqual(['f-1', 'f-2'])
    expect(Object.keys(result.courses)).toEqual(['c-1'])
    expect(Object.keys(result.terms)).toEqual(['t-1'])
  })

  it('does not set isDirty (bulk load from storage)', () => {
    const result = warehouseReducer(initialWarehouseState, {
      type: 'SET_DATA',
      payload: { files: [], courses: [], terms: [] },
    })
    expect(result.isDirty).toBe(false)
  })
})

