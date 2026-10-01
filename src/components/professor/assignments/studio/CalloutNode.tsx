/**
 * CalloutNode — a Notion-style callout: an icon + a tinted, border-accented box holding editable
 * content. Click the icon to cycle the variant (info → tip → warning). Inserted via `/callout`.
 *
 * Unlike the chart/equation atoms this is a CONTENT block (`content: 'block+'`), so its body renders
 * normally in the PDF/HTML export via generateHTML — no static-export shim needed, just CSS.
 */
'use client'

import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { Info, Lightbulb, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

type Variant = 'info' | 'tip' | 'warning'
const ORDER: Variant[] = ['info', 'tip', 'warning']

const STYLE: Record<Variant, { box: string; icon: typeof Info }> = {
  info: { box: 'border-primary bg-primary/5 text-primary', icon: Info },
  tip: { box: 'border-success-muted-foreground bg-success-muted-foreground/10 text-success-muted-foreground', icon: Lightbulb },
  warning: { box: 'border-destructive bg-destructive/5 text-destructive', icon: AlertTriangle },
}

function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const variant = (node.attrs.variant as Variant) in STYLE ? (node.attrs.variant as Variant) : 'info'
  const { box, icon: Icon } = STYLE[variant]
  const cycle = () => updateAttributes({ variant: ORDER[(ORDER.indexOf(variant) + 1) % ORDER.length] })

  return (
    <NodeViewWrapper>
      <div className={cn('my-3 flex gap-3 rounded-xl border-l-4 p-3', box)}>
        <button
          type="button"
          contentEditable={false}
          onClick={editor.isEditable ? cycle : undefined}
          title={editor.isEditable ? 'Change callout style' : undefined}
          className="mt-0.5 shrink-0"
          aria-label="Callout icon"
        >
          <Icon className="h-5 w-5" />
        </button>
        <NodeViewContent className="min-w-0 flex-1 text-foreground [&_p]:my-0" />
      </div>
    </NodeViewWrapper>
  )
}

export const CalloutNode = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: 'info',
        parseHTML: (el) => el.getAttribute('data-variant') ?? 'info',
        renderHTML: (attrs) => ({ 'data-variant': attrs.variant as string }),
      },
    }
  },
  parseHTML() { return [{ tag: 'div[data-callout]' }] },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes({ 'data-callout': '' }, HTMLAttributes), 0] },
  addNodeView() { return ReactNodeViewRenderer(CalloutView) },
})
