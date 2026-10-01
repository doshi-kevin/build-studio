/**
 * Warehouse state reducer — manages all file operations and UI state.
 */

import type { WarehouseFile, WarehouseCourse, WarehouseTerm, FileType } from '@/lib/validations/warehouse'

// ── State ───────────────────────────────────────────────────

export type ViewMode = 'warehouse' | 'folder' | 'timeline'

export interface WarehouseState {
  files: Record<string, WarehouseFile>
  courses: Record<string, WarehouseCourse>
  terms: Record<string, WarehouseTerm>
  // UI state
  viewMode: ViewMode
  searchQuery: string
  filterFileType: FileType | null
  filterCourseId: string | null
  filterTermId: string | null
  selectedFileId: string | null
  expandedShelfId: string | null
  expandedBoxId: string | null
  isDirty: boolean
}

// ── Actions ─────────────────────────────────────────────────

export type WarehouseAction =
  // File operations
  | { type: 'ADD_FILE'; payload: { file: WarehouseFile } }
  | { type: 'UPDATE_FILE'; payload: { file: WarehouseFile } }
  | { type: 'REMOVE_FILE'; payload: { fileId: string } }
  | { type: 'DUPLICATE_FILE'; payload: { originalId: string; newFile: WarehouseFile } }
  | { type: 'MOVE_FILE'; payload: { fileId: string; courseId: string | null; week: number | null; topic?: string } }
  | { type: 'TOGGLE_FAVORITE'; payload: { fileId: string } }
  | { type: 'UPDATE_NOTE'; payload: { fileId: string; note: string } }
  // Course operations
  | { type: 'ADD_COURSE'; payload: { course: WarehouseCourse } }
  | { type: 'REMOVE_COURSE'; payload: { courseId: string } }
  | { type: 'CLEAR_SHELF'; payload: { courseId: string | null } } // remove all files for a course (null = unsorted)
  // Term operations
  | { type: 'ADD_TERM'; payload: { term: WarehouseTerm } }
  // UI state
  | { type: 'SET_VIEW_MODE'; payload: { mode: ViewMode } }
  | { type: 'SET_SEARCH'; payload: { query: string } }
  | { type: 'SET_FILTER_TYPE'; payload: { fileType: FileType | null } }
  | { type: 'SET_FILTER_COURSE'; payload: { courseId: string | null } }
  | { type: 'SET_FILTER_TERM'; payload: { termId: string | null } }
  | { type: 'SELECT_FILE'; payload: { fileId: string | null } }
  | { type: 'EXPAND_SHELF'; payload: { shelfId: string | null } }
  | { type: 'EXPAND_BOX'; payload: { boxId: string | null } }
  // Bulk
  | { type: 'SET_DATA'; payload: { files: WarehouseFile[]; courses: WarehouseCourse[]; terms: WarehouseTerm[] } }
  | { type: 'MARK_SAVED' }

// ── Reducer ─────────────────────────────────────────────────

export function warehouseReducer(
  state: WarehouseState,
  action: WarehouseAction,
): WarehouseState {
  switch (action.type) {
    // ── File Operations ───────────────────────────────────
    case 'ADD_FILE': {
      const { file } = action.payload
      return {
        ...state,
        files: { ...state.files, [file.id]: file },
        isDirty: true,
      }
    }
    case 'UPDATE_FILE': {
      const { file } = action.payload
      return {
        ...state,
        files: { ...state.files, [file.id]: file },
        isDirty: true,
      }
    }
    case 'REMOVE_FILE': {
      const { fileId } = action.payload
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [fileId]: _removed, ...rest } = state.files
      return {
        ...state,
        files: rest,
        selectedFileId: state.selectedFileId === fileId ? null : state.selectedFileId,
        isDirty: true,
      }
    }
    case 'DUPLICATE_FILE': {
      const { newFile } = action.payload
      return {
        ...state,
        files: { ...state.files, [newFile.id]: newFile },
        isDirty: true,
      }
    }
    case 'MOVE_FILE': {
      const { fileId, courseId, week, topic } = action.payload
      const existing = state.files[fileId]
      if (!existing) return state
      const now = new Date().toISOString()
      return {
        ...state,
        files: {
          ...state.files,
          [fileId]: {
            ...existing,
            courseId,
            week,
            topic: topic ?? existing.topic,
            updatedAt: now,
          },
        },
        isDirty: true,
      }
    }
    case 'TOGGLE_FAVORITE': {
      const { fileId } = action.payload
      const existing = state.files[fileId]
      if (!existing) return state
      return {
        ...state,
        files: {
          ...state.files,
          [fileId]: { ...existing, favorite: !existing.favorite, updatedAt: new Date().toISOString() },
        },
        isDirty: true,
      }
    }
    case 'UPDATE_NOTE': {
      const { fileId, note } = action.payload
      const existing = state.files[fileId]
      if (!existing) return state
      return {
        ...state,
        files: {
          ...state.files,
          [fileId]: { ...existing, note, updatedAt: new Date().toISOString() },
        },
        isDirty: true,
      }
    }

    // ── Course Operations ─────────────────────────────────
    case 'ADD_COURSE': {
      const { course } = action.payload
      return {
        ...state,
        courses: { ...state.courses, [course.id]: course },
        isDirty: true,
      }
    }
    case 'REMOVE_COURSE': {
      const { courseId } = action.payload
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [courseId]: _removed, ...rest } = state.courses
      // Unassign files from this course
      const updatedFiles = { ...state.files }
      for (const [id, file] of Object.entries(updatedFiles)) {
        if (file.courseId === courseId) {
          updatedFiles[id] = { ...file, courseId: null }
        }
      }
      return {
        ...state,
        courses: rest,
        files: updatedFiles,
        isDirty: true,
      }
    }

    case 'CLEAR_SHELF': {
      const { courseId } = action.payload
      const updatedFiles = { ...state.files }
      for (const [id, file] of Object.entries(updatedFiles)) {
        if (courseId === null ? !file.courseId : file.courseId === courseId) {
          delete updatedFiles[id]
        }
      }
      return {
        ...state,
        files: updatedFiles,
        isDirty: true,
      }
    }

    // ── Term Operations ───────────────────────────────────
    case 'ADD_TERM': {
      const { term } = action.payload
      return {
        ...state,
        terms: { ...state.terms, [term.id]: term },
        isDirty: true,
      }
    }

    // ── UI State ──────────────────────────────────────────
    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.payload.mode }
    case 'SET_SEARCH':
      return { ...state, searchQuery: action.payload.query }
    case 'SET_FILTER_TYPE':
      return { ...state, filterFileType: action.payload.fileType }
    case 'SET_FILTER_COURSE':
      return { ...state, filterCourseId: action.payload.courseId }
    case 'SET_FILTER_TERM':
      return { ...state, filterTermId: action.payload.termId }
    case 'SELECT_FILE':
      return { ...state, selectedFileId: action.payload.fileId }
    case 'EXPAND_SHELF':
      return { ...state, expandedShelfId: action.payload.shelfId }
    case 'EXPAND_BOX':
      return { ...state, expandedBoxId: action.payload.boxId }

    // ── Bulk ──────────────────────────────────────────────
    case 'SET_DATA': {
      const { files, courses, terms } = action.payload
      const filesMap: Record<string, WarehouseFile> = {}
      for (const f of files) filesMap[f.id] = f
      const coursesMap: Record<string, WarehouseCourse> = {}
      for (const c of courses) coursesMap[c.id] = c
      const termsMap: Record<string, WarehouseTerm> = {}
      for (const t of terms) termsMap[t.id] = t
      return {
        ...state,
        files: filesMap,
        courses: coursesMap,
        terms: termsMap,
      }
    }
    case 'MARK_SAVED':
      return { ...state, isDirty: false }

    default:
      return state
  }
}

// ── Initial State ───────────────────────────────────────────

export const initialWarehouseState: WarehouseState = {
  files: {},
  courses: {},
  terms: {},
  viewMode: 'warehouse',
  searchQuery: '',
  filterFileType: null,
  filterCourseId: null,
  filterTermId: null,
  selectedFileId: null,
  expandedShelfId: null,
  expandedBoxId: null,
  isDirty: false,
}
