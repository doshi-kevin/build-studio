/**
 * Course Mention Extension — TipTap mention extension for course items.
 *
 * Extends @tiptap/extension-mention with custom attrs for course item linking.
 * Renders as colored inline pills in the editor and clickable links when read-only.
 *
 * Type: TipTap Extension
 */

import Mention from '@tiptap/extension-mention'
import { mergeAttributes } from '@tiptap/core'
import type { CourseItem } from './course-mention-suggestion'

export type { CourseItem }

/**
 * Color config per item type — maps to Tailwind classes for dark mode support.
 */
const TYPE_CLASSES: Record<string, string> = {
  quiz: 'bg-amber-100 text-amber-900 border-amber-300',
  module_item: 'bg-blue-100 text-blue-900 border-blue-300',
  project: 'bg-purple-100 text-purple-900 border-purple-300',
}

const DEFAULT_CLASS = 'bg-muted text-foreground border-border'

/**
 * Build the href for a mention based on its type and sectionId.
 */
function buildMentionHref(itemType: string, itemId: string, sectionId: string, basePath = '/student'): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  switch (itemType) {
    case 'quiz':
      return `${base}/courses/${sectionId}/quizzes/${itemId}`
    case 'project':
      return `${base}/courses/${sectionId}/projects/${itemId}`
    case 'module_item':
    default:
      return `${base}/courses/${sectionId}/modules?highlight=${itemId}`
  }
}

export interface CourseMentionOptions {
  HTMLAttributes: Record<string, string>
  suggestion: unknown
  courseItems: CourseItem[]
  sectionId?: string
  basePath?: string
}

export const CourseMentionExtension = Mention.extend<CourseMentionOptions>({
  name: 'mention',

  addOptions() {
    return {
      ...this.parent?.(),
      courseItems: [],
      sectionId: undefined,
      basePath: undefined,
    }
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-id'),
        renderHTML: (attributes: Record<string, string>) => {
          if (!attributes.id) return {}
          return { 'data-id': attributes.id }
        },
      },
      label: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-label'),
        renderHTML: (attributes: Record<string, string>) => {
          if (!attributes.label) return {}
          return { 'data-label': attributes.label }
        },
      },
      type: {
        default: 'module_item',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-mention-type') || 'module_item',
        renderHTML: (attributes: Record<string, string>) => ({
          'data-mention-type': attributes.type,
        }),
      },
      mentionSuggestionChar: {
        default: '@',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-mention-suggestion-char'),
        renderHTML: (attributes: Record<string, string>) => {
          if (!attributes.mentionSuggestionChar) return {}
          return { 'data-mention-suggestion-char': attributes.mentionSuggestionChar }
        },
      },
    }
  },

  renderHTML({ node, HTMLAttributes }) {
    const itemType = (node.attrs.type as string) || 'module_item'
    const itemClasses = TYPE_CLASSES[itemType] || DEFAULT_CLASS
    const label = (node.attrs.label as string) || 'Unknown Item'
    const itemId = node.attrs.id as string
    const sectionId = this.options.sectionId
    const basePath = this.options.basePath

    const baseClasses = 'inline-block px-1.5 py-0 mx-0.5 rounded-md text-[0.85em] border font-medium whitespace-nowrap align-baseline no-underline shadow-sm transition-colors'

    if (sectionId && itemId) {
      const href = buildMentionHref(itemType, itemId, sectionId, basePath)
      return [
        'a',
        mergeAttributes(HTMLAttributes, {
          href,
          'data-mention-type': itemType,
          'data-mention-id': itemId,
          class: `course-mention-link ${baseClasses} ${itemClasses} hover:opacity-80`,
        }),
        `@${label}`,
      ]
    }

    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-mention-type': itemType,
        'data-mention-id': itemId,
        class: `${baseClasses} ${itemClasses}`,
      }),
      `@${label}`,
    ]
  },
})
