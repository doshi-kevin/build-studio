// Block-level utilities. readFileAsBase64 used to live here for inline data
// URI image embedding — removed once Hero/Image editors switched to proper
// Supabase Storage uploads.

import type { AboutBlock, TiptapDoc } from '@/lib/validations/course-about'

/* How many rows a block puts on the canvas when it is open. A populated course
   page opens edit mode at ~6,800px with 91 input fields, most of that one long
   syllabus; folding the big ones by default is what keeps the canvas readable.
   Thresholds are deliberately generous — a short block is never worth hiding. */
function blockRowCount(block: AboutBlock): number {
  switch (block.type) {
    case 'syllabus': return block.data.weeks.length
    case 'learning-outcomes': return block.data.outcomes.length
    case 'faq': return block.data.items.length
    case 'table': return block.data.rows.length
    default: return 0
  }
}

export function isLongBlock(block: AboutBlock): boolean {
  switch (block.type) {
    case 'syllabus': return block.data.weeks.length > 3
    case 'learning-outcomes': return block.data.outcomes.length > 4
    case 'faq': return block.data.items.length > 3
    // Rows x columns: a 6-row grading table is 18 fields on its own, the single
    // biggest cluster on a typical page.
    case 'table': return block.data.rows.length > 3
    default: return false
  }
}

/** The one line a folded block shows, e.g. "Weekly Schedule · 14 weeks". */
export function blockSummaryLine(block: AboutBlock, label: string): string {
  const title = 'title' in block.data && block.data.title ? block.data.title : label
  const n = blockRowCount(block)
  if (n === 0) return title
  const noun =
    block.type === 'syllabus' ? 'week'
      : block.type === 'learning-outcomes' ? 'outcome'
        : block.type === 'faq' ? 'question'
          : 'row'
  return `${title} · ${n} ${noun}${n === 1 ? '' : 's'}`
}

/** Extract plain text from a TiptapDoc, one line per top-level node.
 *
 *  Walks NESTED nodes. It used to read only the direct text children of each
 *  top-level node, so a bulletList (whose children are listItems, which hold
 *  paragraphs, which hold the text) came out as an empty line. That mattered in
 *  two places: the student-facing previews, and the snapshot Athena reads — the
 *  model was told a callout holding a list was empty, and could overwrite it. */
export function docToText(doc: TiptapDoc): string {
  const textOf = (node: unknown): string => {
    if (!node || typeof node !== 'object') return ''
    const n = node as { text?: string; content?: unknown[] }
    if (typeof n.text === 'string') return n.text
    return (n.content ?? []).map(textOf).join('')
  }
  return (doc.content ?? []).map(textOf).join('\n')
}

/** Convert plain text to a TiptapDoc (one paragraph per line). */
export function textToDoc(text: string): TiptapDoc {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  }
}

/** Parse a YouTube or Vimeo URL and return an embeddable URL */
export function parseVideoUrl(url: string): { provider: 'youtube' | 'vimeo' | null; embedUrl: string | null } {
  if (!url) return { provider: null, embedUrl: null }

  // YouTube: various URL formats
  const ytMatch = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|v\/)|youtu\.be\/)([\w-]{11})/
  )
  if (ytMatch) {
    return { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${ytMatch[1]}` }
  }

  // Vimeo
  const vimeoMatch = url.match(/(?:vimeo\.com\/)(\d+)/)
  if (vimeoMatch) {
    return { provider: 'vimeo', embedUrl: `https://player.vimeo.com/video/${vimeoMatch[1]}` }
  }

  return { provider: null, embedUrl: null }
}

/** Does this document hold anything a reader would see? Previews use it to
 *  decide whether to render at all, and it must look INSIDE nested nodes. The
 *  checks it replaced only inspected direct text children, so a bulleted list
 *  counted as empty — and an untitled callout holding one disappeared from the
 *  student's page entirely. */
export function isDocEmpty(doc: TiptapDoc): boolean {
  const hasText = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false
    const n = node as { text?: string; content?: unknown[] }
    if (typeof n.text === 'string' && n.text.trim()) return true
    return Array.isArray(n.content) && n.content.some(hasText)
  }
  return !(doc.content ?? []).some(hasText)
}
