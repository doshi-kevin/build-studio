// Is a rich-content document actually empty? (#669)
//
// Clearing all text in the editor leaves ONE empty paragraph node behind, so
// `content.content?.length` is still 1 — truthy. Every "no body text" fallback was
// therefore unreachable: an empty block rendered instead of the message, on all three
// surfaces that test it.
//
// Shared rather than copied into each: the same wrong test appeared in three places, and
// a fourth reader would have written it a fourth time.

import type { JSONContent } from 'novel'

/** A node carries nothing a reader would see. */
function isBlankNode(node: JSONContent): boolean {
  // Leaf content — text, or a void node like an image/embed that IS the content.
  if (typeof node.text === 'string') return node.text.trim().length === 0
  if (node.type && VOID_NODE_TYPES.has(node.type)) return false
  // A container is blank only when everything inside it is.
  const children = node.content
  if (!children || children.length === 0) return true
  return children.every(isBlankNode)
}

/* Nodes that render something without carrying text. Treating one of these as blank
   would hide a body whose whole point is the image — worse than the bug being fixed. */
const VOID_NODE_TYPES = new Set([
  'image',
  'horizontalRule',
  'youtube',
  'video',
  'iframe',
  'courseMention',
  'file',
])

/**
 * True when a rich-content document has no visible body — no document, no nodes, or
 * only empty ones. Use instead of `content.content?.length`, which counts the empty
 * paragraph the editor leaves behind and so is true for a cleared document.
 */
export function isRichContentEmpty(content: JSONContent | null | undefined): boolean {
  if (!content) return true
  const nodes = content.content
  if (!nodes || nodes.length === 0) return true
  return nodes.every(isBlankNode)
}
