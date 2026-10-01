/**
 * PlanningEditor — TipTap rich text editor that behaves like a word processor.
 *
 * Content sits on sheets over a gray canvas. Text stops at the bottom margin of
 * one page and resumes below the top margin of the next, and a page appears or
 * disappears as content is typed or deleted. A formatting toolbar sits above the
 * pages on mobile and to the left on desktop.
 *
 * The page breaking comes from `tiptap-pagination-plus`, NOT from our own layout.
 * That is deliberate, and the reason is worth keeping: a page break has to move
 * ProseMirror's line boxes, and nothing in CSS can do that to a single continuous
 * flow. Both cheap tricks were built and measured before this was adopted.
 * Full-width cleared floats DO push line boxes correctly, but floats stack
 * against each other rather than sitting at independent offsets, so all the
 * spacers pile into one column and the text starts below the whole pile.
 * `shape-outside` excludes text approximately but corrupts line widths. The
 * extension does it the only way that works: ProseMirror widget decorations,
 * placed by measurement. Decorations are view-only, so nothing it draws reaches
 * `editor.getHTML()` and autosaved content stays clean.
 *
 * This component must be loaded with ssr: false since TipTap requires the DOM.
 * Type: Client Component (no 'use client' needed — caller uses dynamic import)
 */

import { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TextStyle from '@tiptap/extension-text-style'
import Underline from '@tiptap/extension-underline'
import TextAlign from '@tiptap/extension-text-align'
import CharacterCount from '@tiptap/extension-character-count'
import Placeholder from '@tiptap/extension-placeholder'
import { PaginationPlus } from 'tiptap-pagination-plus'
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Undo2,
  Redo2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const MAX_CHARS = 20_000
const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48]
const DEFAULT_SIZE = 16

// ── Page layout constants ─────────────────────────────────────────────────────
/* A page is sized to fit on screen rather than to match US Letter. The document
   is read and written here, not printed from here, and a Letter-proportioned page
   is taller than most laptop viewports — so it never sits in view as a whole page.
   Export handles print fidelity. */
const PAGE_WIDTH = 816
/* Below this a page stops being readable; the sheet scrolls sideways instead. */
const MIN_PAGE_WIDTH = 320
/* Tailwind's `sm`. Under it there are no pages at all, just a scrolling document. */
const PAGED_MIN_VIEWPORT = 640
const NARROW_MARGIN_X = 24
const PAGE_HEIGHT = 720
const PAGE_MARGIN_Y = 48
const PAGE_MARGIN_X = 64
/* The canvas showing between two sheets. */
const PAGE_GAP = 28
/* The canvas colour, at full strength. `bg-muted/30` was tried first to match the
   surrounding canvas exactly, but against the sheet that is a 0.5% lightness
   difference — the gap was invisible and the break read as two hairlines inside
   one continuous sheet, which is the conventional look of a divider WITHIN a
   document, the opposite of a page boundary. The canvas below is `bg-muted` for
   the same reason, so the two still match. */
const PAGE_GAP_COLOR = 'var(--muted)'

// ── Custom FontSize extension (inline style via TextStyle mark) ────────────

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (size: string) => ReturnType
      unsetFontSize: () => ReturnType
    }
  }
}

const FontSize = Extension.create({
  name: 'fontSize',
  addOptions() {
    return { types: ['textStyle'] }
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el: HTMLElement) => el.style.fontSize || null,
            renderHTML: (attrs: Record<string, string>) =>
              attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {},
          },
        },
      },
    ]
  },
  addCommands() {
    return {
      setFontSize:
        (size: string) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: size }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: null }).run(),
    }
  },
})

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert plain text (legacy) to minimal HTML so TipTap loads it correctly */
function plainTextToHtml(text: string): string {
  if (!text.trim()) return ''
  if (/<[a-z][\s\S]*>/i.test(text)) return text
  return text
    .split('\n\n')
    .map((para) =>
      `<p>${para
        .split('\n')
        .map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
        .join('<br>')}</p>`
    )
    .join('')
}

// ── Component ──────────────────────────────────────────────────────────────

interface PlanningEditorProps {
  initialContent: string
  editable: boolean
  onUpdate?: (html: string) => void
}

export function PlanningEditor({ initialContent, editable, onUpdate }: PlanningEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const paperRef = useRef<HTMLDivElement>(null)
  /* Last page width pushed to the extension; null forces the next pass to re-push. */
  const appliedWidthRef = useRef<number | null>(null)

  const editor = useEditor({
    extensions: [
      StarterKit,
      TextStyle,
      FontSize,
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      CharacterCount.configure({ limit: MAX_CHARS }),
      Placeholder.configure({ placeholder: 'Start writing your plan here...' }),
      PaginationPlus.configure({
        pageHeight: PAGE_HEIGHT,
        pageWidth: PAGE_WIDTH,
        marginTop: PAGE_MARGIN_Y,
        marginBottom: PAGE_MARGIN_Y,
        marginLeft: PAGE_MARGIN_X,
        marginRight: PAGE_MARGIN_X,
        contentMarginTop: 0,
        contentMarginBottom: 0,
        pageGap: PAGE_GAP,
        pageBreakBackground: PAGE_GAP_COLOR,
        /* The extension writes this straight into an inline `border` style, where
           no class can reach it, and its default is a hardcoded hex. */
        pageGapBorderColor: 'var(--border)',
        /* No page numbers, no header, no footer. A number in a page margin is a
           promise that the page matches a sheet of paper, and this one does not:
           816x720 is sized to fit a screen, not Letter, so a student writing to a
           "maximum 5 pages" brief would read it and be wrong. Google Docs shows no
           page number on screen either unless you insert one. Print fidelity is
           export's job, and export reflows from scratch. */
        footerRight: '',
        footerLeft: '',
        headerLeft: '',
        headerRight: '',
      }),
    ],
    content: plainTextToHtml(initialContent) || (editable ? '' : ''),
    editable,
    editorProps: {
      attributes: {
        class: [
          // break-words: a pasted URL or long token must wrap, not push the
          // text column out past the paper's right edge.
          'outline-none break-words',
          'prose prose-sm max-w-none',
          'prose-p:my-1.5 prose-li:my-0.5 [&_ul]:list-disc [&_ul>li::marker]:text-foreground [&_ol>li::marker]:text-foreground',
          editable ? 'cursor-text' : '',
        ].join(' '),
      },
    },
    onUpdate({ editor: e }) {
      if (onUpdate) {
        const html = e.isEmpty ? '' : e.getHTML()
        onUpdate(html)
      }
    },
  })

  // Keep editable state in sync
  useEffect(() => {
    if (editor && editor.isEditable !== editable) {
      editor.setEditable(editable)
    }
  }, [editor, editable])

  /* Two jobs, both keyed off how much width the sheet actually has.

     Pages: below `sm` the paper metaphor is dropped and the document just
     scrolls, the way Google Docs behaves on a phone. A phone-width page spends
     96px of every 720 on margin on the shortest screen there is, and produces
     about 10 pages for a document that is 7 on a desktop. When pagination is off
     the extension swaps its fixed page height for `auto` and pads the top and
     bottom instead, so the text keeps its margins without the page frames.

     Width: the page is at most 816px, but a phone is narrower and the extension
     writes a fixed pixel width inline, so this has to be set either way — when
     paginated it is the page, and when not it is the column the text fills.
     Skipping it is what left an 814px sheet inside a 347px column. `paperRef` is
     `flex-1 min-w-0` with a max width, so its own width is the space available
     rather than anything derived from the page width; measuring it cannot feed
     back into what it measures. */
  useEffect(() => {
    const el = paperRef.current
    if (!el || !editor) return

    const paged = window.matchMedia(`(min-width: ${PAGED_MIN_VIEWPORT}px)`)

    const apply = () => {
      const available = el.clientWidth
      if (available <= 0) return

      /* The extension records this as an attribute on its own element, and only
         acts on the flag when its plugin next runs, so read the attribute rather
         than tracking the intent separately. */
      const isPaged = !editor.view.dom.hasAttribute('rm-pagination-disabled')
      const dom = editor.view.dom

      if (!paged.matches) {
        /* Continuous. Once pagination is off the extension skips its update pass
           altogether, so `updatePageWidth` is silently dropped and the last paged
           width stays behind — an 816px column inside a 347px sheet, with the
           text clipped. These are the two custom properties its own inline width
           and padding read, so set them directly instead. */
        dom.style.setProperty('--rm-page-width', '100%')
        dom.style.setProperty('--rm-margin-left', `${NARROW_MARGIN_X}px`)
        dom.style.setProperty('--rm-margin-right', `${NARROW_MARGIN_X}px`)
        if (isPaged) editor.commands.disablePagination()
        /* So the width is pushed again on the way back, even if it is unchanged:
           re-enabling has to make the extension rewrite the properties above. */
        appliedWidthRef.current = null
        return
      }

      if (!isPaged) editor.commands.enablePagination()

      const width = Math.max(MIN_PAGE_WIDTH, Math.min(PAGE_WIDTH, available))
      if (width === appliedWidthRef.current) return
      appliedWidthRef.current = width
      editor.commands.updatePageWidth(width)
      const marginX = width >= PAGED_MIN_VIEWPORT ? PAGE_MARGIN_X : NARROW_MARGIN_X
      editor.commands.updateMargins({
        top: PAGE_MARGIN_Y,
        bottom: PAGE_MARGIN_Y,
        left: marginX,
        right: marginX,
      })
    }

    apply()
    const obs = new ResizeObserver(apply)
    obs.observe(el)
    paged.addEventListener('change', apply)
    return () => {
      obs.disconnect()
      paged.removeEventListener('change', apply)
    }
  }, [editor])

  // Clicking the paper margins, or the canvas around it, focuses the editor
  const handleContainerClick = (e: React.MouseEvent) => {
    if (!editable || !editor) return
    const target = e.target as HTMLElement
    // Clicks that land on the text layer are ProseMirror's — it places the caret.
    if (editor.view.dom.contains(target)) return
    if (target === containerRef.current || target.closest('[data-paper]')) {
      editor.commands.focus('end')
    }
  }

  // Read current font size from selection
  const currentFontSize = editor
    ? parseInt(editor.getAttributes('textStyle').fontSize ?? `${DEFAULT_SIZE}px`, 10)
    : DEFAULT_SIZE

  const handleFontSizeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const size = parseInt(e.target.value, 10)
    if (!editor) return
    if (size === DEFAULT_SIZE) {
      editor.chain().focus().unsetFontSize().run()
    } else {
      editor.chain().focus().setFontSize(`${size}px`).run()
    }
  }

  const charCount = editor?.storage.characterCount?.characters() ?? 0
  const isNearLimit = charCount > MAX_CHARS * 0.9

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Document area */}
      <div
        ref={containerRef}
        className="flex-1 bg-muted rounded-xl overflow-y-auto px-4 sm:px-6 py-6 sm:py-8 cursor-text"
        onClick={handleContainerClick}
      >
        {/* On mobile: toolbar above paper (row). On sm+: toolbar left of paper (col). */}
        <div className="flex flex-col sm:flex-row gap-3 mx-auto max-w-5xl items-start">

          {/* ── Formatting toolbar ──────────────────────────────────── */}
          {editable && editor && (
            <div className="sm:sticky sm:top-0 sm:self-start flex flex-row flex-wrap sm:flex-col gap-1 bg-background border border-border rounded-xl p-1.5 shadow-sm sm:shrink-0 z-20">

              {/* Font size selector */}
              <div className="px-0.5 py-0.5">
                <select
                  title="Font size"
                  value={FONT_SIZES.includes(currentFontSize) ? currentFontSize : DEFAULT_SIZE}
                  onChange={handleFontSizeChange}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="w-full text-[11px] text-center bg-muted/60 border border-border rounded-xl px-1 py-1 text-foreground cursor-pointer appearance-none focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {FONT_SIZES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              <div className="hidden sm:block h-px bg-border my-0.5 mx-1" />
              <div className="sm:hidden w-px bg-border mx-0.5 self-stretch" />

              {/* Undo / Redo */}
              <ToolbarButton
                title="Undo (Ctrl+Z)"
                active={false}
                disabled={!editor.can().undo()}
                onClick={() => editor.chain().focus().undo().run()}
              >
                <Undo2 className="h-3.5 w-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title="Redo (Ctrl+Y)"
                active={false}
                disabled={!editor.can().redo()}
                onClick={() => editor.chain().focus().redo().run()}
              >
                <Redo2 className="h-3.5 w-3.5" />
              </ToolbarButton>

              <div className="hidden sm:block h-px bg-border my-0.5 mx-1" />
              <div className="sm:hidden w-px bg-border mx-0.5 self-stretch" />

              <ToolbarButton
                title="Bold (Ctrl+B)"
                active={editor.isActive('bold')}
                onClick={() => editor.chain().focus().toggleBold().run()}
              >
                <Bold className="h-3.5 w-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title="Italic (Ctrl+I)"
                active={editor.isActive('italic')}
                onClick={() => editor.chain().focus().toggleItalic().run()}
              >
                <Italic className="h-3.5 w-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title="Underline (Ctrl+U)"
                active={editor.isActive('underline')}
                onClick={() => editor.chain().focus().toggleUnderline().run()}
              >
                <UnderlineIcon className="h-3.5 w-3.5" />
              </ToolbarButton>

              <div className="hidden sm:block h-px bg-border my-0.5 mx-1" />
              <div className="sm:hidden w-px bg-border mx-0.5 self-stretch" />

              <ToolbarButton
                title="Bullet list"
                active={editor.isActive('bulletList')}
                onClick={() => editor.chain().focus().toggleBulletList().run()}
              >
                <List className="h-3.5 w-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title="Numbered list"
                active={editor.isActive('orderedList')}
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
              >
                <ListOrdered className="h-3.5 w-3.5" />
              </ToolbarButton>

              <div className="hidden sm:block h-px bg-border my-0.5 mx-1" />
              <div className="sm:hidden w-px bg-border mx-0.5 self-stretch" />

              <ToolbarButton
                title="Align left"
                active={editor.isActive({ textAlign: 'left' })}
                onClick={() => editor.chain().focus().setTextAlign('left').run()}
              >
                <AlignLeft className="h-3.5 w-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title="Align center"
                active={editor.isActive({ textAlign: 'center' })}
                onClick={() => editor.chain().focus().setTextAlign('center').run()}
              >
                <AlignCenter className="h-3.5 w-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title="Align right"
                active={editor.isActive({ textAlign: 'right' })}
                onClick={() => editor.chain().focus().setTextAlign('right').run()}
              >
                <AlignRight className="h-3.5 w-3.5" />
              </ToolbarButton>
            </div>
          )}

          {/* ── Paged document area ─────────────────────────────────── */}
          {/* `min-w-0` lets this flex child shrink to the row instead of pushing
              the sheet past the container on narrow viewports. The sheet is one
              element; PaginationPlus draws the breaks inside it, so there is no
              per-page frame to keep aligned here.

              The arbitrary variants theme the extension's own markup, which ships
              unstyled: the page number in the bottom margin, and the rule at each
              break. Done here rather than in a stylesheet because this codebase
              has no custom CSS files. */}
          <div
            data-paper
            ref={paperRef}
            className={cn(
              'w-full flex-1 min-w-0 bg-background shadow-md border border-border/40 rounded-xl overflow-x-auto',
              '[&_.rm-pagination-gap]:border-y [&_.rm-pagination-gap]:border-border',
            )}
            style={{ maxWidth: PAGE_WIDTH }}
          >
            <EditorContent editor={editor} />
          </div>

        </div>
      </div>

      {/* Footer: character count. The page count used to live here too; each page
          now carries its own number, and two counts that can disagree is worse
          than one. */}
      {editable && (
        <div className="flex justify-end text-xs text-muted-foreground shrink-0 px-1">
          <span className={isNearLimit ? 'text-warning-muted-foreground' : ''}>
            {charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()} characters
          </span>
        </div>
      )}
    </div>
  )
}

// ── Toolbar button ─────────────────────────────────────────────────────────

function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void
  active?: boolean
  disabled?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => {
        // Prevent editor losing focus when clicking toolbar
        e.preventDefault()
        if (!disabled) onClick()
      }}
      className={cn(
        'p-2.5 rounded-xl transition-colors cursor-pointer',
        active
          ? 'bg-primary text-primary-foreground'
          : disabled
            ? 'text-muted-foreground/30 cursor-not-allowed'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
