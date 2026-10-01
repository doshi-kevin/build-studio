/**
 * Pure text-editing transforms for the studio's Insert / Format toolbar.
 *
 * Each takes a textarea's value + selection and returns the new value plus the selection
 * to restore. The shell applies these to the active cell's source. Pure + testable; no DOM.
 */

export interface EditResult {
  value: string
  selStart: number
  selEnd: number
}

/** Insert `text` at the cursor (replacing any selection). Cursor lands after it. */
export function insertAt(value: string, start: number, end: number, text: string): EditResult {
  const v = value.slice(0, start) + text + value.slice(end)
  const pos = start + text.length
  return { value: v, selStart: pos, selEnd: pos }
}

/**
 * Wrap the selection with `pre`/`suf` (e.g. `**`…`**`). With no selection, inserts
 * `placeholder` between the markers. Either way the inner text ends up selected so the
 * professor can type over it.
 */
export function wrapAt(
  value: string, start: number, end: number, pre: string, suf: string, placeholder = '',
): EditResult {
  const selected = value.slice(start, end)
  const inner = selected || placeholder
  const text = pre + inner + suf
  const v = value.slice(0, start) + text + value.slice(end)
  const selStart = start + pre.length
  const selEnd = selStart + inner.length
  return { value: v, selStart, selEnd }
}

/** Prepend `prefix` at the start of the line the cursor is on (headings, lists, quotes). */
export function linePrefixAt(value: string, start: number, prefix: string): EditResult {
  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const v = value.slice(0, lineStart) + prefix + value.slice(lineStart)
  const pos = start + prefix.length
  return { value: v, selStart: pos, selEnd: pos }
}

/**
 * Build a markdown image tag for an uploaded cell image. The alt text is derived
 * from the filename (extension dropped, separators spaced) so the inserted image
 * is described, not left with a placeholder. Falls back to "Image" for blank names.
 * `]` in the alt would break the `![...]()` syntax, so it is stripped.
 */
export function imageMarkdown(fileName: string, url: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\]/g, '').trim()
  return `![${base || 'Image'}](${url})`
}
