/**
 * Warehouse sync utilities — add files from other features (e.g. module uploads) into the warehouse.
 *
 * Writes directly to localStorage. The warehouse context will pick up changes on next page load.
 */

import { warehouseStorage } from './storage'
import { generateId } from '@/lib/quiz/utils'
import { getFileTypeFromMime, getFileTypeFromExtension } from './utils'
import type { WarehouseFile } from '@/lib/validations/warehouse'
import type { UploadResult } from '@/lib/supabase/storage'

export interface SyncToWarehouseOptions {
  uploadResult: UploadResult
  courseId: string | null       // warehouse course ID (= sectionId for real courses)
  termId?: string | null
  week?: number | null
  topic?: string
  itemType?: string             // 'lecture', 'video', 'reference'
}

/**
 * Add an uploaded file to the warehouse (localStorage).
 * Idempotent: skips if a file with the same filePath already exists.
 */
export function syncFileToWarehouse(opts: SyncToWarehouseOptions): WarehouseFile | null {
  const { uploadResult, courseId, termId, week, topic, itemType } = opts

  // Idempotency check: don't duplicate if already synced
  const existing = warehouseStorage.getFiles()
  if (existing.some((f) => f.filePath === uploadResult.path)) {
    return null
  }

  const now = new Date().toISOString()
  const fileType = uploadResult.mimeType
    ? getFileTypeFromMime(uploadResult.mimeType)
    : getFileTypeFromExtension(uploadResult.fileName)

  const file: WarehouseFile = {
    id: generateId(),
    name: uploadResult.fileName,
    fileType,
    mimeType: uploadResult.mimeType,
    courseId: courseId ?? null,
    termId: termId ?? null,
    week: week ?? null,
    topic: topic ?? '',
    tags: itemType ? [itemType] : [],
    note: '',
    size: uploadResult.fileSize,
    favorite: false,
    usedInCourseIds: courseId ? [courseId] : [],
    fileUrl: uploadResult.url,
    filePath: uploadResult.path,
    createdAt: now,
    lastUsedAt: now,
    updatedAt: now,
  }

  warehouseStorage.saveFile(file)
  return file
}
