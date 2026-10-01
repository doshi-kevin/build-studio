/**
 * Knowledge Warehouse Validation Schemas — Zod schemas for files, courses, and terms.
 *
 * Defines the data model for the professor's personal file warehouse.
 * Files are organized by Course → Term → Week → Topic.
 *
 * Used in:
 * 1. Client-side: react-hook-form resolver for form validation
 * 2. Storage layer: type-safe persistence
 */

import { z } from 'zod'

// ── File Types ───────────────────────────────────────────────

export const FILE_TYPES = ['pdf', 'ppt', 'video', 'image', 'doc', 'other'] as const
export type FileType = (typeof FILE_TYPES)[number]

export const FILE_TYPE_LABELS: Record<FileType, string> = {
  pdf: 'PDF',
  ppt: 'Presentation',
  video: 'Video',
  image: 'Image',
  doc: 'Document',
  other: 'Other',
}

/**
 * Per-file-type accent, expressed in semantic tokens only.
 * `chip` colors a leading icon chip, `dot` a small distribution dot.
 * File types are distinct categories (not status), so they map onto the
 * neutral chart palette; `other` falls back to muted grey.
 */
export const FILE_TYPE_COLORS: Record<FileType, { chip: string; dot: string }> = {
  pdf: { chip: 'bg-chart-5/15 text-chart-5', dot: 'bg-chart-5' },
  ppt: { chip: 'bg-chart-1/15 text-chart-1', dot: 'bg-chart-1' },
  video: { chip: 'bg-chart-3/15 text-chart-3', dot: 'bg-chart-3' },
  image: { chip: 'bg-chart-2/15 text-chart-2', dot: 'bg-chart-2' },
  doc: { chip: 'bg-chart-4/15 text-chart-4', dot: 'bg-chart-4' },
  other: { chip: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/50' },
}

// ── Semesters ────────────────────────────────────────────────

export const SEMESTERS = ['fall', 'spring', 'summer', 'winter'] as const
export type Semester = (typeof SEMESTERS)[number]

export const SEMESTER_LABELS: Record<Semester, string> = {
  fall: 'Fall',
  spring: 'Spring',
  summer: 'Summer',
  winter: 'Winter',
}

// ── Schemas ──────────────────────────────────────────────────

export const warehouseCourseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  code: z.string().max(20).default(''),
  sectionId: z.string().nullable().default(null), // Links to course_sections.id if auto-created
})

export type WarehouseCourse = z.infer<typeof warehouseCourseSchema>

export const warehouseTermSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(100), // e.g. "Fall 2024"
  semester: z.enum(SEMESTERS),
  year: z.number().int().min(2000).max(2100),
})

export type WarehouseTerm = z.infer<typeof warehouseTermSchema>

export const warehouseFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, 'File name is required').max(300),
  fileType: z.enum(FILE_TYPES),
  mimeType: z.string().default('application/octet-stream'),

  // Organization
  courseId: z.string().nullable().default(null),
  termId: z.string().nullable().default(null),
  week: z.number().int().min(1).max(52).nullable().default(null),
  topic: z.string().max(200).default(''),

  // Metadata
  tags: z.array(z.string().max(50)).max(20).default([]),
  note: z.string().max(2000).default(''), // Professor's sticky note
  size: z.number().int().min(0).default(0), // bytes
  favorite: z.boolean().default(false),
  usedInCourseIds: z.array(z.string()).default([]), // courses that used this file

  // Storage reference (null for legacy/metadata-only files)
  fileUrl: z.string().nullable().default(null),   // Public URL from Supabase Storage
  filePath: z.string().nullable().default(null),  // Storage path for deletion

  // Timestamps
  createdAt: z.string(),
  lastUsedAt: z.string(),
  updatedAt: z.string(),
})

export type WarehouseFile = z.infer<typeof warehouseFileSchema>
