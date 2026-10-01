/**
 * StudioRightPalette — a collapsible left rail for the document studio that expands on hover
 * (or pins open). It gives the professor, at a glance:
 *   • Outline — the document's headings, click to jump.
 *   • Insert — every block from the slash menu, grouped by category (Basic / Media / Math & data /
 *     Questions), so authors who prefer clicking get the same catalogue as the "/" menu.
 *   • Stats — word count + estimated read time.
 *
 * Collapsed it's a slim icon rail; hovering slides the full panel over the page (no reflow); the pin
 * keeps it open. Reads the live doc JSON for the outline/stats and drives the editor for inserts.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { JSONContent } from 'novel'
import { List, Plus, PanelLeftClose, PanelLeftOpen, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  groupedDocumentSlashItems, insertCategoryOf, CATEGORY_CHART, type SlashItem,
} from './document-slash-command'

interface OutlineItem { level: number; text: string }

function docOutline(doc: JSONContent): OutlineItem[] {
  const out: OutlineItem[] = []
  const walk = (node?: JSONContent) => {
    if (!node) return
    if (node.type === 'heading') {
      const level = (node.attrs?.level as number) ?? 1
      const text = (node.content ?? []).map((c) => c.text ?? '').join('').trim()
      out.push({ level, text: text || 'Untitled heading' })
    }
    ;(node.content ?? []).forEach(walk)
  }
  ;(doc.content ?? []).forEach(walk)
  return out
}

function wordCount(doc: JSONContent): number {
  let s = ''
  const walk = (node?: JSONContent) => {
    if (!node) return
    if (node.text) s += `${node.text} `
    ;(node.content ?? []).forEach(walk)
  }
  ;(doc.content ?? []).forEach(walk)
  return s.trim() ? s.trim().split(/\s+/).length : 0
}

/** A section header with a 2px primary left-rail accent (the palette's indigo identity). */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 border-l-2 border-primary pl-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  )
}

/** An Insert row with a category-tinted identity tile so each block type is recognizable at a glance. */
function InsertRow({
  icon, label, description, chart, disabled, onClick,
}: {
  icon: React.ReactNode
  label: string
  description?: string
  chart: number
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={description}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50"
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg [&_svg]:h-4 [&_svg]:w-4"
        style={{ background: `color-mix(in oklch, var(--chart-${chart}) 12%, transparent)`, color: `var(--chart-${chart})` }}
      >
        {icon}
      </span>
      {label}
    </button>
  )
}

export function StudioRightPalette({ editor, doc }: { editor: Editor | null; doc: JSONContent }) {
  // Docked by default so the panel sits beside the document instead of sliding over it
  // (an absolute hover-overlay covered the doc). Unpin to collapse to the slim rail.
  const [pinned, setPinned] = useState(true)
  const outline = docOutline(doc)
  const words = wordCount(doc)
  const readMin = Math.max(1, Math.round(words / 200))
  const groups = groupedDocumentSlashItems()

  function scrollToHeading(index: number) {
    const dom = editor?.view.dom
    if (!dom) return
    const headings = dom.querySelectorAll('h1, h2, h3')
    headings[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Insert a block at the current selection by reusing the slash item's command with an empty range.
  const runInsert = (item: SlashItem) => {
    if (!editor) return
    const { from, to } = editor.state.selection
    item.command?.({ editor, range: { from, to } })
  }

  return (
    <aside className={cn('hidden shrink-0 border-r border-border bg-muted/20 transition-[width] duration-200 lg:block', pinned ? 'w-72' : 'w-12')}>
      {/* Slim rail — click to reopen the full panel. */}
      {!pinned && (
        <button
          type="button"
          onClick={() => setPinned(true)}
          aria-label="Open page panel"
          className="flex w-full flex-col items-center gap-4 py-4 text-muted-foreground hover:text-foreground"
        >
          <List className="h-4 w-4" />
          <Plus className="h-4 w-4" />
          <Clock className="h-4 w-4" />
        </button>
      )}

      {/* Full panel — in normal flow when pinned (document sits beside it), hidden when
          collapsed to the slim rail. A plain toggle: no hover-overlay, so collapse actually collapses. */}
      <div
        className={cn(
          'w-72 overflow-y-auto bg-card p-3',
          pinned ? 'block h-full' : 'hidden',
        )}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Page</span>
          <button
            type="button"
            onClick={() => setPinned((p) => !p)}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={pinned ? 'Unpin panel' : 'Pin panel open'}
          >
            {pinned ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
          </button>
        </div>

        {/* Outline */}
        <div className="mb-4">
          <SectionLabel>On this page</SectionLabel>
          {outline.length ? (
            <div className="space-y-0.5">
              {outline.map((h, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => scrollToHeading(i)}
                  className="block w-full truncate rounded-md py-1 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  style={{ paddingLeft: `${0.5 + (h.level - 1) * 0.75}rem` }}
                >
                  {h.text}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground/70">Add headings to build an outline.</p>
          )}
        </div>

        {/* Insert — every slash block, grouped by category */}
        <div className="mb-4 space-y-3">
          {groups.map((group) => (
            <div key={group.category}>
              <SectionLabel>{group.category}</SectionLabel>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <InsertRow
                    key={item.title}
                    icon={item.icon}
                    label={item.title}
                    description={item.description}
                    chart={CATEGORY_CHART[insertCategoryOf(item.title)]}
                    disabled={!editor}
                    onClick={() => runInsert(item)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Stats */}
        <div className="border-t border-border pt-3 text-xs text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>{words} {words === 1 ? 'word' : 'words'}</span>
            <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {readMin} min read</span>
          </div>
        </div>
      </div>
    </aside>
  )
}
