// The AI-provenance badge on generated quiz questions. Two kinds:
//  - SOURCE ("✨ <file>", ai-muted violet): drawn from a real source page;
//    clicking peeks that page in the studio's right-hand preview panel.
//  - AI-EXTENDED ("🪄 AI-extended · <topic>", warning amber): generated on-topic
//    from the model's own knowledge ("beyond the document") — NOT verbatim from
//    a source, so amber flags it for a harder review and it isn't peekable.
// Professor-only authoring aid.
'use client'

import { Wand2, Bot } from 'lucide-react'

import type { SourceCitation } from '@/lib/validations/quiz'

// ai-muted pair (not chart-3 on its own tint): text-on-tint clears WCAG AA
const chipBase = 'inline-flex h-7 max-w-full items-center gap-1 rounded-full px-3 text-xs font-medium'
const sourceChipClass = `${chipBase} bg-ai-muted text-ai-muted-foreground`
// warning-muted amber pair (WCAG AA on its tint) — signals "review harder".
const extendedChipClass = `${chipBase} bg-warning-muted text-warning-muted-foreground`

export function QuestionSourceChip({
  citation,
  onOpen,
}: {
  citation: SourceCitation
  onOpen: (citation: SourceCitation) => void
}) {
  // AI-extended: no source page to peek — provenance-only, amber, non-clickable.
  if (citation.kind === 'ai_extended') {
    return (
      <span
        title="Generated from the AI's own knowledge on this topic (beyond your source material) — review it carefully."
        className={`${extendedChipClass} cursor-default`}
      >
        <Wand2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">AI-extended · {citation.topic}</span>
      </span>
    )
  }

  const label = (
    <>
      {/* lucide Bot — monochrome + theme-aware, renders consistently
          across platforms (emoji glyphs don't). */}
      <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{citation.title}</span>
      {/* Page stays outside the truncating span so a long file name can never
          swallow it — it's the half of the citation the professor peeks at. */}
      {typeof citation.page === 'number' && citation.page > 0 && (
        <span className="shrink-0 whitespace-nowrap">· Page {citation.page}</span>
      )}
    </>
  )
  // The peek endpoint renders PDF/PPT pages only; for other source types the
  // chip is provenance-only — no click affordance that would dead-end in an
  // error pane. Absent flag (older citations) = clickable.
  if (citation.renderable === false) {
    return (
      <span
        title="Page preview is only available for PDF and PowerPoint files"
        className={`${sourceChipClass} cursor-default`}
      >
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(citation)}
      title="View the source page this question was generated from"
      className={`${sourceChipClass} transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
    >
      {label}
    </button>
  )
}
