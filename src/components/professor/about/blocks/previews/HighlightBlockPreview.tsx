// Highlight box preview — variants are distinguished by icon and uppercase
// label instead of color. Monochrome to match the rest of Scholera.

'use client'

import { Sparkles, Lightbulb, AlertCircle } from 'lucide-react'
import type { HighlightBoxBlock, HighlightVariant } from '@/lib/validations/course-about'
import { RichTextView } from '../../RichText'
import { isDocEmpty } from '../../block-editor'

const VARIANTS: Record<HighlightVariant, { icon: typeof Sparkles; label: string }> = {
  feature: { icon: Sparkles, label: 'Feature' },
  tip: { icon: Lightbulb, label: 'Tip' },
  important: { icon: AlertCircle, label: 'Important' },
}

interface Props {
  block: HighlightBoxBlock
}

export function HighlightBlockPreview({ block }: Props) {
  const variant = VARIANTS[block.data.variant]
  const Icon = variant.icon
  // See CalloutBlockPreview: a nested-aware emptiness check, not a flatten.
  const empty = isDocEmpty(block.data.content)

  if (!block.data.title && empty) return null

  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="flex gap-3">
        <Icon className="h-5 w-5 mt-0.5 shrink-0 text-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">
              {variant.label}
            </span>
            {block.data.title && (
              <p className="text-base font-semibold text-foreground">{block.data.title}</p>
            )}
          </div>
          {!empty && <RichTextView value={block.data.content} className="text-sm leading-relaxed" />}
        </div>
      </div>
    </div>
  )
}
