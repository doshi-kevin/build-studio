/**
 * EquationNode — a TipTap block node for a KaTeX equation, edited in a card (ChartNode pattern).
 *
 * Insert it, "Edit" to type LaTeX with a live preview and a categorized math palette
 * (Common templates · Greek · Operators · Functions · Structures) with search and recently-used.
 * Supports mhchem (`\ce{…}`) for chemistry. The rendered math uses a dark theme color, not pure
 * black. LaTeX is stored in the node's `latex` attribute.
 *
 * KaTeX output is set via dangerouslySetInnerHTML: the input is professor-authored LaTeX (trusted
 * staff), and KaTeX escapes its output with `trust: false` (default) so no raw HTML/script passes
 * through — this is KaTeX's rendered markup, not user HTML.
 */
'use client'

import { useState, useRef, useCallback } from 'react'
import katex from 'katex'
import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { cn } from '@/lib/utils'
import { BlockChrome } from './shared/BlockChrome'
import type { BlockAlign } from './shared/BlockChrome'
import { EquationPalette } from './shared/EquationPalette'

export const EQUATION_DEFAULT = 'E = mc^2'

function renderKatex(latex: string): string {
  try {
    return katex.renderToString(latex, { displayMode: true, throwOnError: false, output: 'html' })
  } catch {
    return ''
  }
}

function EquationNodeView({ node, updateAttributes, deleteNode, getPos, selected, editor }: NodeViewProps) {
  const latex = (node.attrs.latex as string) || ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(latex)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const width = (node.attrs.width as number | null) ?? 100
  const align = ((node.attrs.align as string | null) ?? 'center') as BlockAlign

  const startEdit = useCallback(() => {
    setDraft((node.attrs.latex as string) || '')
    setEditing(true)
  }, [node.attrs.latex])

  const commit = useCallback(() => {
    updateAttributes({ latex: draft.trim() || EQUATION_DEFAULT })
    setEditing(false)
  }, [draft, updateAttributes])

  const handleDuplicate = useCallback(() => {
    if (typeof getPos !== 'function') return
    editor.chain().insertContentAt(getPos() + node.nodeSize, node.toJSON()).run()
  }, [editor, getPos, node])

  // KaTeX output is set via dangerouslySetInnerHTML: the input is professor-authored LaTeX (trusted
  // staff), and KaTeX escapes its output with `trust: false` (default) so no raw HTML/script passes
  // through — this is KaTeX's rendered markup, not user HTML.
  const preview = renderKatex(editing ? draft : latex)

  return (
    <NodeViewWrapper>
      <BlockChrome
        editor={editor}
        selected={selected}
        onEdit={startEdit}
        onDelete={deleteNode}
        onDuplicate={handleDuplicate}
        editLabel="Edit equation"
        align={align}
        onAlign={(a) => updateAttributes({ align: a })}
        width={width}
        onResize={(pct) => updateAttributes({ width: pct })}
      >
        {/* Rendered equation (dark theme color, centered) */}
        <div className={cn('flex min-h-[2.5rem] items-center justify-center py-2 text-foreground')}>
          {preview ? (
            <span dangerouslySetInnerHTML={{ __html: preview }} />
          ) : (
            <span className="text-sm text-muted-foreground">Empty equation</span>
          )}
        </div>

        {editing && (
          <EquationPalette
            draft={draft}
            onChange={setDraft}
            textareaRef={taRef}
            onSave={commit}
            onCancel={() => setEditing(false)}
          />
        )}
      </BlockChrome>
    </NodeViewWrapper>
  )
}

export const EquationNode = Node.create({
  name: 'equation',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      latex: {
        default: EQUATION_DEFAULT,
        parseHTML: (el) => el.getAttribute('data-latex') ?? EQUATION_DEFAULT,
        renderHTML: (attrs) => ({ 'data-latex': attrs.latex as string }),
      },
      width: {
        default: 100,
        parseHTML: (el) => { const v = el.getAttribute('data-width'); return v ? Number(v) : 100 },
        renderHTML: (attrs) => ({ 'data-width': String(attrs.width ?? 100) }),
      },
      align: {
        default: 'center',
        parseHTML: (el) => el.getAttribute('data-align') ?? 'center',
        renderHTML: (attrs) => ({ 'data-align': (attrs.align as string) ?? 'center' }),
      },
    }
  },
  parseHTML() { return [{ tag: 'div[data-equation]' }] },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes({ 'data-equation': '' }, HTMLAttributes)] },
  addNodeView() { return ReactNodeViewRenderer(EquationNodeView) },
})
