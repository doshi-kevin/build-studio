/**
 * Course Mention Suggestion — suggestion dropdown for @-mentions.
 *
 * Provides the suggestion configuration for TipTap's mention extension.
 * Renders a floating dropdown with icons matching the sidebar.
 *
 * Type: TipTap Suggestion Plugin
 */

import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion'

export interface CourseItem {
  id: string
  type: 'quiz' | 'module_item' | 'project'
  label: string
}

/**
 * Icon SVGs matching sidebar icons for consistency.
 * Using inline SVGs to avoid React render context issues in TipTap suggestion.
 */
const TYPE_ICONS: Record<string, string> = {
  quiz: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg>`,
  module_item: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>`,
  project: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M8 10v4"/><path d="M12 10v2"/><path d="M16 10v6"/></svg>`,
}

const TYPE_LABELS: Record<string, string> = {
  quiz: 'Quiz',
  module_item: 'Module Item',
  project: 'Project',
}

const TYPE_COLORS: Record<string, string> = {
  quiz: '#92400e',
  module_item: '#1e40af',
  project: '#5b21b6',
}

/**
 * Suggestion list component rendered in a vanilla DOM container.
 *
 * We use imperative DOM manipulation here because TipTap's suggestion plugin
 * needs a floating element that lives outside the React tree.
 */
class CourseMentionList {
  element: HTMLElement
  private items: CourseItem[] = []
  private selectedIndex = 0
  private command: ((item: CourseItem) => void) | null = null

  constructor() {
    this.element = document.createElement('div')
    this.element.className = 'course-mention-dropdown'
    this.element.style.cssText = `
      position: absolute;
      z-index: 9999;
      background: var(--background, #fff);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
      padding: 4px;
      max-height: 280px;
      overflow-y: auto;
      min-width: 260px;
    `
  }

  updateProps(props: { items: CourseItem[]; command: (item: CourseItem) => void }) {
    this.items = props.items
    this.command = props.command
    this.selectedIndex = 0
    this.render()
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (event.key === 'ArrowUp') {
      this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length
      this.render()
      return true
    }

    if (event.key === 'ArrowDown') {
      this.selectedIndex = (this.selectedIndex + 1) % this.items.length
      this.render()
      return true
    }

    if (event.key === 'Enter') {
      const item = this.items[this.selectedIndex]
      if (item) {
        this.command?.(item)
      }
      return true
    }

    return false
  }

  private render() {
    this.element.innerHTML = ''

    if (this.items.length === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = 'padding: 8px 12px; color: var(--muted-foreground, #6b7280); font-size: 13px;'
      empty.textContent = 'No items found'
      this.element.appendChild(empty)
      return
    }

    this.items.forEach((item, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      const isSelected = index === this.selectedIndex
      const iconColor = TYPE_COLORS[item.type] || '#374151'

      button.style.cssText = `
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 7px 10px;
        border: none;
        border-radius: 6px;
        background: ${isSelected ? 'var(--accent, #f3f4f6)' : 'transparent'};
        cursor: pointer;
        text-align: left;
        font-size: 13px;
        line-height: 1.4;
        color: var(--foreground, #111827);
        transition: background 0.1s;
      `

      button.addEventListener('mouseenter', () => {
        this.selectedIndex = index
        this.render()
      })

      button.addEventListener('click', () => {
        this.command?.(item)
      })

      // Icon
      const iconWrapper = document.createElement('span')
      iconWrapper.style.cssText = `display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex-shrink: 0; color: ${iconColor};`
      iconWrapper.innerHTML = TYPE_ICONS[item.type] || TYPE_ICONS.module_item

      // Label + type
      const textWrapper = document.createElement('div')
      textWrapper.style.cssText = 'flex: 1; min-width: 0;'

      const titleEl = document.createElement('div')
      titleEl.style.cssText = 'font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
      titleEl.textContent = item.label

      const typeEl = document.createElement('div')
      typeEl.style.cssText = `font-size: 11px; color: ${iconColor}; opacity: 0.8;`
      typeEl.textContent = TYPE_LABELS[item.type] || item.type

      textWrapper.appendChild(titleEl)
      textWrapper.appendChild(typeEl)
      button.appendChild(iconWrapper)
      button.appendChild(textWrapper)
      this.element.appendChild(button)
    })
  }

  destroy() {
    this.element.remove()
  }
}

/**
 * Build the TipTap suggestion configuration for course mentions.
 */
export function courseMentionSuggestion(
  items: CourseItem[],
): Partial<SuggestionOptions<CourseItem>> {
  return {
    char: '@',
    allowSpaces: true,
    items: ({ query }: { query: string }) => {
      const q = query.toLowerCase()
      return items
        .filter((item) => item.label.toLowerCase().includes(q))
        .slice(0, 10)
    },
    // Explicit command to insert mention node with all attrs.
    // We define this ourselves rather than relying on TipTap's default
    // getSuggestionOptions.command because novel's wrapper can interfere
    // with the default attr-spreading behavior.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    command: ({ editor, range, props }: { editor: any; range: any; props: any }) => {
      // Increase range.to by one when the next node is text starting with space
      const nodeAfter = editor.view.state.selection.$to.nodeAfter
      const overrideSpace = nodeAfter?.text?.startsWith(' ')
      if (overrideSpace) {
        range.to += 1
      }

      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: 'mention',
            attrs: {
              id: props.id,
              label: props.label,
              type: props.type,
            },
          },
          { type: 'text', text: ' ' },
        ])
        .run()

      editor.view.dom.ownerDocument.defaultView?.getSelection()?.collapseToEnd()
    },
    render: () => {
      let component: CourseMentionList | null = null
      let popup: HTMLElement | null = null

      return {
        onStart: (props: SuggestionProps<CourseItem>) => {
          component = new CourseMentionList()
          component.updateProps({
            items: props.items as CourseItem[],
            command: (item: CourseItem) => {
              props.command({
                id: item.id,
                label: item.label,
                type: item.type,
              } as never)
            },
          })

          // Position the dropdown near the cursor, flipping upward if needed
          const { view } = props.editor
          const { from } = props.range
          const coords = view.coordsAtPos(from)

          popup = component.element
          popup.style.position = 'fixed'
          popup.style.left = `${coords.left}px`
          document.body.appendChild(popup)

          // Measure rendered height and flip above cursor if it would overflow
          const dropdownHeight = popup.offsetHeight || 280
          const spaceBelow = window.innerHeight - coords.bottom - 8
          if (spaceBelow < dropdownHeight) {
            // Place above the cursor line
            popup.style.top = `${coords.top - dropdownHeight - 4}px`
            popup.style.maxHeight = `${Math.min(280, coords.top - 8)}px`
          } else {
            popup.style.top = `${coords.bottom + 4}px`
            popup.style.maxHeight = `${Math.min(280, spaceBelow)}px`
          }
        },

        onUpdate: (props: SuggestionProps<CourseItem>) => {
          component?.updateProps({
            items: props.items as CourseItem[],
            command: (item: CourseItem) => {
              props.command({
                id: item.id,
                label: item.label,
                type: item.type,
              } as never)
            },
          })

          // Re-position with viewport flip
          if (popup) {
            const { view } = props.editor
            const { from } = props.range
            const coords = view.coordsAtPos(from)
            popup.style.left = `${coords.left}px`

            const dropdownHeight = popup.offsetHeight || 280
            const spaceBelow = window.innerHeight - coords.bottom - 8
            if (spaceBelow < dropdownHeight) {
              popup.style.top = `${coords.top - dropdownHeight - 4}px`
              popup.style.maxHeight = `${Math.min(280, coords.top - 8)}px`
            } else {
              popup.style.top = `${coords.bottom + 4}px`
              popup.style.maxHeight = `${Math.min(280, spaceBelow)}px`
            }
          }
        },

        onKeyDown: ({ event }: { event: KeyboardEvent }) => {
          if (event.key === 'Escape') {
            popup?.remove()
            popup = null
            return true
          }
          return component?.onKeyDown(event) ?? false
        },

        onExit: () => {
          popup?.remove()
          popup = null
          component?.destroy()
          component = null
        },
      }
    },
  }
}
