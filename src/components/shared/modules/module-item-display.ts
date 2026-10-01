/**
 * module-item-display — pure presentation logic shared by the professor and
 * student Modules surfaces.
 *
 * Deliberately JSX-free so both role trees can import it without dragging each
 * other's client components (and server actions) into their bundles. The two
 * role surfaces render DIFFERENT markup; only these decisions are shared.
 *
 * On reuse: the per-file-type colour tints come from FILE_TYPE_COLORS
 * (@/lib/validations/warehouse) — the app's existing file-type palette, reused
 * so the Modules chips can never drift from the Library's. The icon map below
 * is NOT a duplicate of the warehouse one: it keys off `item_type` first (a
 * note is a StickyNote, a link is an ExternalLink — neither is a "file type"),
 * and only refines to a file-format icon for items that carry a file.
 */

import {
  BookOpen,
  ClipboardList,
  ExternalLink,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  ImageIcon,
  PlayCircle,
  StickyNote,
  type LucideIcon,
} from 'lucide-react'
import { FILE_TYPE_COLORS, type FileType } from '@/lib/validations/warehouse'
import type { ModuleItemType } from '@/lib/validations/module'
import type { MaterialViewerImage } from '@/components/ui/material-viewer'

/**
 * Focus ring for hand-rolled buttons on the Modules surfaces.
 *
 * shadcn `Button` ships this; bare `<button>`s don't, and the action clusters
 * are invisible at rest with `group-focus-within` revealing them — so the ring
 * is the only cue telling a keyboard user which of several adjacent circles
 * they are on. Mirrors button.tsx deliberately.
 */
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

/** A module item's `content` column is free-form JSONB. */
export type ItemContent = Record<string, unknown>

// ── JSONB narrowing ──────────────────────────────────────────────
// `content` is untyped JSONB written by several pipelines (upload, extraction,
// quiz-generation, roadmap). Read it defensively — never assume a shape.

function str(content: ItemContent, key: string): string | undefined {
  const value = content[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function num(content: ItemContent, key: string): number | undefined {
  const value = content[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function obj(content: ItemContent, key: string): ItemContent | undefined {
  const value = content[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as ItemContent)
    : undefined
}

// ── File-format classification ───────────────────────────────────

const EXTENSION_FILE_TYPES: Record<string, FileType> = {
  pdf: 'pdf',
  ppt: 'ppt',
  pptx: 'ppt',
  doc: 'doc',
  docx: 'doc',
  xls: 'doc',
  xlsx: 'doc',
  txt: 'doc',
  epub: 'doc',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  webm: 'video',
  mkv: 'video',
}

/** `content.fileType` values written by the upload path, mapped to our palette. */
const LECTURE_FILE_TYPES: Record<string, FileType> = {
  pdf: 'pdf',
  ppt: 'ppt',
  docx: 'doc',
  xlsx: 'doc',
  image: 'image',
  notes: 'other',
}

function fileTypeFromName(fileName: string | undefined): FileType | undefined {
  if (!fileName) return undefined
  const ext = fileName.split('.').pop()?.toLowerCase()
  return ext ? EXTENSION_FILE_TYPES[ext] : undefined
}

/**
 * Which slot of the shared file-type palette this item belongs to.
 * Items that aren't files ("note", "link", an assignment) resolve to `other`,
 * which is the neutral grey — colour stays reserved for real materials.
 */
export function itemFileType(itemType: ModuleItemType, content: ItemContent): FileType {
  switch (itemType) {
    case 'lecture': {
      const declared = str(content, 'fileType')
      return (
        (declared ? LECTURE_FILE_TYPES[declared] : undefined) ??
        fileTypeFromName(str(content, 'fileName')) ??
        'other'
      )
    }
    case 'video':
      return 'video'
    case 'reference':
      // A reference is either an uploaded reading or a bare URL.
      return fileTypeFromName(str(content, 'fileName')) ?? (str(content, 'fileUrl') ? 'doc' : 'other')
    default:
      return 'other'
  }
}

// ── Icon + tint ──────────────────────────────────────────────────

const FILE_TYPE_ICONS: Record<FileType, LucideIcon> = {
  pdf: FileText,
  ppt: FileSpreadsheet,
  doc: FileText,
  image: ImageIcon,
  video: PlayCircle,
  other: FileIcon,
}

/** Icons for item types that are never a file. */
const NON_FILE_ICONS: Partial<Record<ModuleItemType, LucideIcon>> = {
  note: StickyNote,
  link: ExternalLink,
  assignment: ClipboardList,
  reference: BookOpen,
}

export interface ItemVisual {
  Icon: LucideIcon
  /** Tailwind classes for the leading icon chip (semantic tokens only). */
  chip: string
}

/**
 * The leading chip for a row: what kind of thing this is, at a glance.
 * File type drives the colour; item type drives the glyph where the item
 * isn't a file at all.
 */
export function itemVisual(itemType: ModuleItemType, content: ItemContent): ItemVisual {
  const fileType = itemFileType(itemType, content)
  const nonFileIcon = fileType === 'other' ? NON_FILE_ICONS[itemType] : undefined
  return {
    Icon: nonFileIcon ?? FILE_TYPE_ICONS[fileType],
    chip: FILE_TYPE_COLORS[fileType].chip,
  }
}

// ── Time estimate ────────────────────────────────────────────────

/**
 * How much of the reader's time this asks for — the one piece of file
 * metadata people actually plan around. Replaces the raw extraction
 * telemetry ("26 images · 454 formulas") that used to sit on every row.
 * Returns null when we genuinely don't know; never guesses.
 */
export function itemTimeEstimate(itemType: ModuleItemType, content: ItemContent): string | null {
  if (itemType === 'video') {
    const minutes = num(content, 'duration')
    return minutes && minutes > 0 ? `${Math.round(minutes)} min` : null
  }

  const pageCount = num(obj(obj(content, 'extraction') ?? {}, 'metadata') ?? {}, 'pageCount')
  if (!pageCount || pageCount <= 0) return null
  return `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`
}

// ── Extraction state ─────────────────────────────────────────────

/**
 * Extraction state, surfaced ONLY when the professor can do something about
 * it. A finished extraction shows nothing — its useful output is the page
 * count above. Students never see any of this.
 */
export type ExtractionDisplay = 'processing' | 'failed' | null

export function itemExtractionDisplay(
  itemType: ModuleItemType,
  content: ItemContent,
): ExtractionDisplay {
  if (itemType !== 'lecture') return null
  const extraction = obj(content, 'extraction')
  if (!extraction) return null

  const status = str(extraction, 'status')
  if (status === 'processing' || status === 'pending') return 'processing'
  if (status === 'failed' || status === 'partial') return 'failed'
  return null
}

// ── Section contents summary ─────────────────────────────────────

interface SummarisableItem {
  item_type: string
  content: unknown
}

const SUMMARY_NOUNS: Record<string, [singular: string, plural: string]> = {
  reading: ['reading', 'readings'],
  deck: ['deck', 'decks'],
  video: ['video', 'videos'],
  note: ['note', 'notes'],
  link: ['link', 'links'],
  item: ['item', 'items'],
}

function summaryBucket(item: SummarisableItem): keyof typeof SUMMARY_NOUNS {
  const content = (item.content ?? {}) as ItemContent
  switch (item.item_type) {
    case 'video':
      return 'video'
    case 'note':
      return 'note'
    case 'link':
      return 'link'
    case 'lecture':
    case 'reference':
      return itemFileType(item.item_type, content) === 'ppt' ? 'deck' : 'reading'
    default:
      return 'item'
  }
}

/**
 * "8 readings, 2 decks, 1 video" — lets a collapsed section answer "what will
 * I find in here?" without being opened. Dividers aren't content, so they're
 * excluded. Returns '' for an empty section (the caller shows its own copy).
 */
export function sectionContentsSummary(items: SummarisableItem[]): string {
  const counts = new Map<string, number>()
  for (const item of items) {
    if (item.item_type === 'section_divider') continue
    const bucket = summaryBucket(item)
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  if (counts.size === 0) return ''

  // Stable, meaningful order rather than insertion order.
  const order: (keyof typeof SUMMARY_NOUNS)[] = ['reading', 'deck', 'video', 'note', 'link', 'item']
  return order
    .filter((bucket) => counts.has(bucket))
    .map((bucket) => {
      const count = counts.get(bucket) as number
      const [singular, plural] = SUMMARY_NOUNS[bucket]
      return `${count} ${count === 1 ? singular : plural}`
    })
    .join(', ')
}

// ── Filtering ────────────────────────────────────────────────────

/**
 * The type facets offered in the toolbar. Coarser than ModuleItemType on
 * purpose — students think "slides" and "readings", not "lecture" and
 * "reference".
 */
export const ITEM_FILTER_TYPES = ['all', 'reading', 'deck', 'video', 'note', 'link'] as const
export type ItemFilterType = (typeof ITEM_FILTER_TYPES)[number]

export const ITEM_FILTER_LABELS: Record<ItemFilterType, string> = {
  all: 'All',
  reading: 'Readings',
  deck: 'Slides',
  video: 'Video',
  note: 'Notes',
  link: 'Links',
}

interface FilterableItem {
  item_type: string
  /* Nullable to match the generated row types — these columns default to ''
     in Postgres but the generator still types them as nullable. */
  title: string | null
  description: string | null
  content: unknown
}

/**
 * Free-text + type match for one item.
 *
 * The text side matches title, description and filename. This is the seam
 * where server-side semantic search over file CONTENTS would replace the
 * local string match — callers pass items through here and nowhere else.
 */
export function itemMatches(
  item: FilterableItem,
  query: string,
  type: ItemFilterType,
): boolean {
  if (item.item_type === 'section_divider') return false

  if (type !== 'all' && summaryBucket(item) !== type) return false

  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return true

  const content = (item.content ?? {}) as ItemContent
  const haystack = [item.title, item.description, str(content, 'fileName'), str(content, 'url')]
    .filter((part): part is string => !!part)
    .join(' ')
    .toLowerCase()

  return haystack.includes(trimmed)
}

/** True when a filter is actually narrowing anything. */
export function isFiltering(query: string, type: ItemFilterType): boolean {
  return query.trim().length > 0 || type !== 'all'
}

/**
 * Only let http(s) URLs reach an `href` or `window.open`.
 *
 * `content` is free-form JSONB and `createModuleItemSchema` validates it as
 * `z.record(z.string(), z.unknown())` — the per-type `contentSchemaMap` is
 * never applied — so a professor-supplied `javascript:` value would otherwise
 * survive all the way to a student's browser. Returns undefined for anything
 * that isn't a well-formed http(s) URL, so the caller renders it as inert.
 */
export function safeExternalUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const protocol = new URL(url, 'https://invalid.local').protocol
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

// ── Attachments ──────────────────────────────────────────────────

/**
 * Turn a signed storage URL into one the browser will SAVE rather than render.
 *
 * The HTML `download` attribute is ignored for cross-origin hrefs, and
 * Supabase serves these with `Content-Type: application/pdf`, so clicking
 * "download" merely opened the PDF in a new tab. Supabase honours a
 * `download` query param by responding with `Content-Disposition: attachment`.
 */
export function toDownloadUrl(signedUrl: string, fileName: string): string {
  const separator = signedUrl.includes('?') ? '&' : '?'
  return `${signedUrl}${separator}download=${encodeURIComponent(fileName)}`
}


/**
 * Narrow `content.extraction.images[]` to the subset MaterialViewer needs.
 * Returns undefined when there's nothing to show so the viewer won't render
 * an empty Images tab. Type-only import — no runtime coupling to the viewer.
 */
export function toViewerImages(images: unknown): MaterialViewerImage[] | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined
  const usable = images
    .filter((img): img is ItemContent => typeof img === 'object' && img !== null)
    .filter((img) => typeof img.storageUrl === 'string' && typeof img.pageNumber === 'number')
    .map((img) => ({
      pageNumber: img.pageNumber as number,
      storageUrl: img.storageUrl as string,
      altText: typeof img.altText === 'string' ? img.altText : undefined,
      pixelWidth: num(img, 'pixelWidth'),
      pixelHeight: num(img, 'pixelHeight'),
    }))
  return usable.length > 0 ? usable : undefined
}
