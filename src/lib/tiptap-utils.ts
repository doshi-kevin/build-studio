/**
 * TipTap Utilities — helper functions for working with TipTap JSONContent.
 *
 * Used by announcement form (extract plain text fallback, extract mention IDs).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JSONContent = { type?: string; text?: string; content?: JSONContent[]; attrs?: Record<string, any> }

/**
 * Recursively extract plain text from TipTap JSONContent.
 * Used as a fallback for the `content` column (backward compat + search).
 */
export function extractPlainText(json: JSONContent | null | undefined): string {
  if (!json) return ''
  if (json.text) return json.text
  if (!json.content) return ''
  return json.content
    .map((node) => {
      const text = extractPlainText(node)
      // Add newlines between block-level nodes
      if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock' || node.type === 'blockquote') {
        return text + '\n'
      }
      if (node.type === 'listItem' || node.type === 'taskItem') {
        return '- ' + text + '\n'
      }
      if (node.type === 'horizontalRule') {
        return '---\n'
      }
      return text
    })
    .join('')
    .trim()
}

/**
 * Extract all @-mentioned student IDs from TipTap JSONContent.
 * Mention nodes have `type: 'mention'` with `attrs.id` being the student UUID.
 */
export function extractMentionIds(json: JSONContent | null | undefined): string[] {
  if (!json) return []
  const ids: string[] = []

  function walk(node: JSONContent) {
    if (node.type === 'mention' && node.attrs?.id) {
      ids.push(node.attrs.id as string)
    }
    if (node.content) {
      node.content.forEach(walk)
    }
  }

  walk(json)
  return [...new Set(ids)]
}

/**
 * Extract all course-item @-mention data from TipTap JSONContent.
 * Mention nodes have `type: 'mention'` with `attrs.type` being the item type.
 * Returns deduplicated array of linked items for the `linked_items` column.
 */
export function extractLinkedItems(json: JSONContent | null | undefined): { id: string; type: string; label: string }[] {
  if (!json) return []

  // Deep-clone to convert Next.js server action client references into plain objects.
  // Without this, dotting into nested properties throws:
  // "Cannot access id on the server. You cannot dot into a temporary client reference"
  let plainJson: JSONContent
  try {
    plainJson = JSON.parse(JSON.stringify(json))
  } catch {
    return []
  }

  const items: { id: string; type: string; label: string }[] = []
  const seen = new Set<string>()

  function walk(node: JSONContent) {
    if (node.type === 'mention' && node.attrs?.id && node.attrs?.type) {
      const key = `${node.attrs.type}:${node.attrs.id}`
      if (!seen.has(key)) {
        seen.add(key)
        items.push({
          id: node.attrs.id as string,
          type: node.attrs.type as string,
          label: (node.attrs.label as string) || 'Unknown',
        })
      }
    }
    if (node.content) {
      node.content.forEach(walk)
    }
  }

  walk(plainJson)
  return items
}

/**
 * Convert plain text to a minimal TipTap JSONContent document.
 * Used when editing old announcements that only have plain text.
 */
export function plainTextToJsonContent(text: string): JSONContent {
  if (!text) {
    return { type: 'doc', content: [{ type: 'paragraph' }] }
  }

  const paragraphs = text.split('\n').map((line) => ({
    type: 'paragraph' as const,
    content: line ? [{ type: 'text' as const, text: line }] : [],
  }))

  return { type: 'doc', content: paragraphs }
}
