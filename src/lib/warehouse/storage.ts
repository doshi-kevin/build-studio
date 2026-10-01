/**
 * Knowledge Warehouse mock persistence layer — localStorage-backed repository.
 *
 * Provides a WarehouseRepository interface that can be swapped for Supabase later.
 * Professor-global storage (not scoped by course/section).
 */

import type {
  WarehouseFile,
  WarehouseCourse,
  WarehouseTerm,
} from '@/lib/validations/warehouse'

// ── Repository Interface ────────────────────────────────────

export interface WarehouseRepository {
  // Files
  getFiles(): WarehouseFile[]
  getFileById(id: string): WarehouseFile | null
  saveFile(file: WarehouseFile): void
  saveFiles(files: WarehouseFile[]): void
  deleteFile(id: string): void

  // Courses (professor's course labels for organizing files)
  getCourses(): WarehouseCourse[]
  saveCourse(course: WarehouseCourse): void
  saveCourses(courses: WarehouseCourse[]): void
  deleteCourse(id: string): void

  // Terms
  getTerms(): WarehouseTerm[]
  saveTerm(term: WarehouseTerm): void
  saveTerms(terms: WarehouseTerm[]): void

  // Bulk check
  hasData(): boolean
}

// ── Storage Keys ────────────────────────────────────────────

const KEYS = {
  files: 'scholera_warehouse_files',
  courses: 'scholera_warehouse_courses',
  terms: 'scholera_warehouse_terms',
} as const

// ── Helpers ─────────────────────────────────────────────────

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJSON(key: string, value: unknown): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // localStorage full or unavailable — fail silently
  }
}

// ── LocalStorage Implementation ─────────────────────────────

class LocalStorageWarehouseRepository implements WarehouseRepository {
  // ── Files ─────────────────────────────────────────────────

  getFiles(): WarehouseFile[] {
    return readJSON<WarehouseFile[]>(KEYS.files, [])
  }

  getFileById(id: string): WarehouseFile | null {
    return this.getFiles().find((f) => f.id === id) ?? null
  }

  saveFile(file: WarehouseFile): void {
    const files = this.getFiles()
    const index = files.findIndex((f) => f.id === file.id)
    if (index >= 0) {
      files[index] = file
    } else {
      files.push(file)
    }
    writeJSON(KEYS.files, files)
  }

  saveFiles(files: WarehouseFile[]): void {
    writeJSON(KEYS.files, files)
  }

  deleteFile(id: string): void {
    const files = this.getFiles().filter((f) => f.id !== id)
    writeJSON(KEYS.files, files)
  }

  // ── Courses ───────────────────────────────────────────────

  getCourses(): WarehouseCourse[] {
    return readJSON<WarehouseCourse[]>(KEYS.courses, [])
  }

  saveCourse(course: WarehouseCourse): void {
    const courses = this.getCourses()
    const index = courses.findIndex((c) => c.id === course.id)
    if (index >= 0) {
      courses[index] = course
    } else {
      courses.push(course)
    }
    writeJSON(KEYS.courses, courses)
  }

  saveCourses(courses: WarehouseCourse[]): void {
    writeJSON(KEYS.courses, courses)
  }

  deleteCourse(id: string): void {
    const courses = this.getCourses().filter((c) => c.id !== id)
    writeJSON(KEYS.courses, courses)
  }

  // ── Terms ─────────────────────────────────────────────────

  getTerms(): WarehouseTerm[] {
    return readJSON<WarehouseTerm[]>(KEYS.terms, [])
  }

  saveTerm(term: WarehouseTerm): void {
    const terms = this.getTerms()
    const index = terms.findIndex((t) => t.id === term.id)
    if (index >= 0) {
      terms[index] = term
    } else {
      terms.push(term)
    }
    writeJSON(KEYS.terms, terms)
  }

  saveTerms(terms: WarehouseTerm[]): void {
    writeJSON(KEYS.terms, terms)
  }

  // ── Bulk ──────────────────────────────────────────────────

  hasData(): boolean {
    return this.getFiles().length > 0 || this.getCourses().length > 0
  }
}

// ── Singleton Export ─────────────────────────────────────────

export const warehouseStorage: WarehouseRepository = new LocalStorageWarehouseRepository()
