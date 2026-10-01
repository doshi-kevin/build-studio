/**
 * Knowledge Warehouse utility functions.
 */

import type { FileType, WarehouseFile, WarehouseTerm } from '@/lib/validations/warehouse'

/** Format bytes into human-readable size string */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const size = bytes / Math.pow(1024, i)
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

/** Infer file type from MIME type */
export function getFileTypeFromMime(mime: string): FileType {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf') return 'pdf'
  if (
    mime.includes('presentation') ||
    mime.includes('powerpoint') ||
    mime === 'application/vnd.ms-powerpoint'
  )
    return 'ppt'
  if (
    mime.includes('document') ||
    mime.includes('msword') ||
    mime.includes('text/')
  )
    return 'doc'
  return 'other'
}

/** Infer file type from file name extension */
export function getFileTypeFromExtension(name: string): FileType {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, FileType> = {
    pdf: 'pdf',
    ppt: 'ppt',
    pptx: 'ppt',
    mp4: 'video',
    mov: 'video',
    avi: 'video',
    webm: 'video',
    mkv: 'video',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    svg: 'image',
    doc: 'doc',
    docx: 'doc',
    txt: 'doc',
    rtf: 'doc',
    md: 'doc',
    xls: 'other',
    xlsx: 'other',
    csv: 'other',
    zip: 'other',
  }
  return map[ext] ?? 'other'
}

/** Format ISO date string as relative time ("3 days ago", "just now") */
export function getRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr = Math.floor(diffMin / 60)
  const diffDays = Math.floor(diffHr / 24)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffWeeks < 5) return `${diffWeeks}w ago`
  return `${diffMonths}mo ago`
}

/** Group files by courseId. null courseId → 'unsorted' key */
export function groupFilesByCourse(
  files: WarehouseFile[],
): Map<string, WarehouseFile[]> {
  const map = new Map<string, WarehouseFile[]>()
  for (const f of files) {
    const key = f.courseId ?? 'unsorted'
    const arr = map.get(key) ?? []
    arr.push(f)
    map.set(key, arr)
  }
  return map
}

/** Group files by termId. null termId → 'unassigned' key */
export function groupFilesByTerm(
  files: WarehouseFile[],
): Map<string, WarehouseFile[]> {
  const map = new Map<string, WarehouseFile[]>()
  for (const f of files) {
    const key = f.termId ?? 'unassigned'
    const arr = map.get(key) ?? []
    arr.push(f)
    map.set(key, arr)
  }
  return map
}

/** Group files by week within a course. null week → 0 key */
export function groupFilesByWeek(
  files: WarehouseFile[],
): Map<number, WarehouseFile[]> {
  const map = new Map<number, WarehouseFile[]>()
  for (const f of files) {
    const key = f.week ?? 0
    const arr = map.get(key) ?? []
    arr.push(f)
    map.set(key, arr)
  }
  return map
}

/** Calculate total mock storage used */
export function getTotalStorageBytes(files: WarehouseFile[]): number {
  return files.reduce((sum, f) => sum + f.size, 0)
}

/** Generate a random mock file size between minKB and maxKB */
export function randomFileSize(minKB = 100, maxKB = 50000): number {
  return Math.floor((Math.random() * (maxKB - minKB) + minKB) * 1024)
}

/** Sort terms chronologically (most recent first) */
export function sortTerms(terms: WarehouseTerm[]): WarehouseTerm[] {
  const semesterOrder = { winter: 0, spring: 1, summer: 2, fall: 3 }
  return [...terms].sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year
    return semesterOrder[b.semester] - semesterOrder[a.semester]
  })
}
