'use client'

import type { QuoteBlock } from '@/lib/validations/course-about'

interface Props {
  block: QuoteBlock
}

export function QuoteBlockPreview({ block }: Props) {
  if (!block.data.text) return null

  return (
    <blockquote className="border-l-2 border-foreground/40 pl-5 py-1">
      <p className="font-[family-name:var(--font-instrument-serif)] text-2xl italic text-foreground leading-snug">
        {block.data.text}
      </p>
      {block.data.attribution && (
        <footer className="text-xs uppercase tracking-[0.15em] text-muted-foreground mt-2">
          — {block.data.attribution}
        </footer>
      )}
    </blockquote>
  )
}
