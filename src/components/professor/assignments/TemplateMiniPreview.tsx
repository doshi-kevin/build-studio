/**
 * TemplateMiniPreview: a live, scaled-down, non-interactive snapshot of a built StudioNotebook.
 * Renders the actual first cells of the template content (markdown + code) directly — no
 * StudentNotebookView chrome (its "Download .ipynb" header would otherwise fill the crop), no
 * screenshots, no images. Cropped from the top with a bottom fade.
 *
 * Type: Client Component
 */
'use client'

import { cn } from '@/lib/utils'
import { StudioMarkdown } from '@/components/professor/assignments/studio/shared/StudioMarkdown'
import { CodeBlock } from '@/components/professor/assignments/studio/shared/CodeBlock'
import type { StudioNotebook } from '@/lib/assignments/studio/notebook-model'

interface TemplateMiniPreviewProps {
  notebook: StudioNotebook | undefined
  /** Tinted background class for the preview area, e.g. 'bg-primary/5' or 'bg-warning-muted/50' */
  tint?: string
  className?: string
}

// Only the first few cells are visible in the crop; rendering the whole notebook is wasted work.
const PREVIEW_CELLS = 4

export function TemplateMiniPreview({ notebook, tint = 'bg-primary/5', className }: TemplateMiniPreviewProps) {
  const cells = notebook?.cells.slice(0, PREVIEW_CELLS) ?? []

  return (
    <div className={cn('relative h-28 overflow-hidden', tint, className)} aria-hidden="true">
      {cells.length > 0 ? (
        <div className="pointer-events-none w-[250%] origin-top-left scale-[0.4] space-y-3 p-3">
          {cells.map((c, i) =>
            c.cell_type === 'code' ? (
              <CodeBlock key={c.id ?? i} code={c.source || ' '} />
            ) : (
              <StudioMarkdown key={c.id ?? i} content={c.source} />
            ),
          )}
        </div>
      ) : (
        /* Fallback: plain tinted area when there's no content to render */
        <div className="h-full w-full" />
      )}
      {/* Bottom fade to blend the crop boundary */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" aria-hidden="true" />
    </div>
  )
}
