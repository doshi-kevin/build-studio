/**
 * ImageNode — a TipTap image node with alignment + resize chrome.
 *
 * Replaces Novel's plain `TiptapImage` in the document studio. The node extends the same
 * base (name: 'image') so existing `{ type: 'image', attrs: { src, alt } }` insertions keep
 * working — width and align default in automatically.
 *
 * Chrome (BlockChrome): align left / center / right, plus drag-handle resize. Images are inserted
 * small and centered by default (see DocumentStudio.insertImageFromFile).
 * Security: src is a Supabase Storage URL from the existing upload flow; no dangerouslySetInnerHTML.
 */
'use client'

import { useCallback } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { BlockChrome } from './shared/BlockChrome'
import type { BlockAlign } from './shared/BlockChrome'

function ImageNodeView({ node, updateAttributes, deleteNode, getPos, selected, editor }: NodeViewProps) {
  const src = node.attrs.src as string
  const alt = (node.attrs.alt as string | null) ?? ''
  const width = (node.attrs.width as number | null) ?? 50
  const align = ((node.attrs.align as string | null) ?? 'center') as BlockAlign

  const handleDuplicate = useCallback(() => {
    if (typeof getPos !== 'function') return
    editor.chain().insertContentAt(getPos() + node.nodeSize, node.toJSON()).run()
  }, [editor, getPos, node])

  return (
    <NodeViewWrapper>
      <BlockChrome
        editor={editor}
        selected={selected}
        onDelete={deleteNode}
        onDuplicate={handleDuplicate}
        align={align}
        onAlign={(a) => updateAttributes({ align: a })}
        width={width}
        onResize={(pct) => updateAttributes({ width: pct })}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className="max-w-full rounded-lg border border-muted"
          style={{ display: 'block', width: '100%' }}
          draggable={false}
        />
      </BlockChrome>
    </NodeViewWrapper>
  )
}

export const ImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => el.getAttribute('src'),
        renderHTML: (attrs) => ({ src: attrs.src as string }),
      },
      alt: {
        default: null,
        parseHTML: (el) => el.getAttribute('alt'),
        renderHTML: (attrs) => (attrs.alt ? { alt: attrs.alt as string } : {}),
      },
      title: {
        default: null,
        parseHTML: (el) => el.getAttribute('title'),
        renderHTML: (attrs) => (attrs.title ? { title: attrs.title as string } : {}),
      },
      width: {
        default: 50,
        parseHTML: (el) => {
          const v = el.getAttribute('data-width')
          return v ? Number(v) : 50
        },
        renderHTML: (attrs) => ({ 'data-width': String(attrs.width ?? 50) }),
      },
      align: {
        default: 'center',
        parseHTML: (el) => el.getAttribute('data-align') ?? 'center',
        renderHTML: (attrs) => ({ 'data-align': (attrs.align as string) ?? 'center' }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'img[src]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView)
  },
})
