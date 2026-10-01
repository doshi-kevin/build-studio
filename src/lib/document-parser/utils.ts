// Utility functions for transforming officeparser AST nodes into
// structured extraction data — page/slide text, word counting, etc.

import type { OfficeContentNode } from 'officeparser'

/**
 * Extract text from an AST node and all its children recursively.
 * Falls back to concatenating children text if node.text is empty.
 */
export function extractNodeText(node: OfficeContentNode): string {
  if (node.text) return node.text
  if (!node.children?.length) return ''
  return node.children.map(extractNodeText).join('\n')
}

/**
 * Count words in a string. Splits on whitespace and filters empties.
 */
export function countWords(text: string): number {
  if (!text.trim()) return 0
  return text.trim().split(/\s+/).length
}

/**
 * Extract headings from an array of content nodes.
 * Returns the text of all heading-type nodes.
 */
export function extractHeadings(nodes: OfficeContentNode[]): string[] {
  const headings: string[] = []
  for (const node of nodes) {
    if (node.type === 'heading' && node.text) {
      headings.push(node.text)
    }
    if (node.children?.length) {
      headings.push(...extractHeadings(node.children))
    }
  }
  return headings
}

/** Max file size for extraction (100 MB). */
export const MAX_EXTRACTION_SIZE = 100 * 1024 * 1024

/** File types supported for extraction. docx/xlsx are OOXML-native (Phase 5b);
 * 'image' goes straight to the gated vision tier (Phase 5c) — no native floor.
 * All but pdf/ppt are worker/v2-only (the legacy officeparser path can't read them). */
export const EXTRACTABLE_FILE_TYPES = ['pdf', 'ppt', 'docx', 'xlsx', 'image'] as const
export type ExtractableFileType = (typeof EXTRACTABLE_FILE_TYPES)[number]

/**
 * Check if a file type is supported for extraction.
 */
export function isSupportedFileType(fileType: string): fileType is ExtractableFileType {
  return EXTRACTABLE_FILE_TYPES.includes(fileType as ExtractableFileType)
}
