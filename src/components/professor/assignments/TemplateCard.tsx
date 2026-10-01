/**
 * TemplateCard: redesigned card for built-in marketplace templates.
 * - Live TemplateMiniPreview in a tinted top strip.
 * - Clicking anywhere EXCEPT the Preview / Heart buttons uses the template (create+navigate).
 * - "Preview" button (Eye icon) opens TemplateQuickLook.
 * - Heart button saves/unsaves.
 *
 * Used on both the AssignmentStudioEntry featured row and MarketplaceBrowser.
 *
 * Type: Client Component
 */
'use client'

import { useMemo, useState } from 'react'
import { Eye, Heart, Loader2, NotebookPen, Sigma } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TemplateMiniPreview } from './TemplateMiniPreview'
import { TemplateQuickLook } from './TemplateQuickLook'
import { getNotebookTemplate } from '@/lib/assignments/studio/notebook-templates'
import { subjectLabel, DEFAULT_STEM_QUESTIONS } from '@/lib/assignments/studio/marketplace-catalog'
import type { MarketplaceTemplate } from '@/lib/assignments/studio/marketplace-catalog'

interface TemplateCardProps {
  template: MarketplaceTemplate
  saved: boolean
  onToggleSave: () => void
  busy?: boolean
  disabled?: boolean
  onUse: () => void
}

export function TemplateCard({ template, saved, onToggleSave, busy, disabled, onUse }: TemplateCardProps) {
  const [quickLookOpen, setQuickLookOpen] = useState(false)

  const isStem = template.kind === 'stem'
  const typeLabel = isStem ? 'STEM Problem Set' : 'Notebook'
  const TypeIcon = isStem ? Sigma : NotebookPen
  const tint = isStem ? 'bg-warning-muted/50' : 'bg-primary/5'

  // Build once, memoized — pure function, no side effects.
  const notebook = useMemo(() => {
    return getNotebookTemplate(template.id)?.build(
      isStem ? { questionCount: DEFAULT_STEM_QUESTIONS } : undefined,
    )
  }, [template.id, isStem])

  function handleCardKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!disabled && !busy) onUse()
    }
  }

  return (
    <>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-busy={busy}
        aria-disabled={disabled}
        onClick={() => { if (!disabled && !busy) onUse() }}
        onKeyDown={handleCardKey}
        className={cn(
          'group relative rounded-2xl border border-border bg-card shadow-sm transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-300',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          busy || disabled
            ? 'cursor-not-allowed opacity-60'
            : 'cursor-pointer hover:-translate-y-1 hover:shadow-lg',
        )}
      >
        {/* Loading overlay */}
        {busy && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-card/70">
            <Loader2 className="h-6 w-6 animate-spin text-foreground" aria-hidden="true" />
          </div>
        )}

        {/* Heart button — top-right corner, over preview area */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleSave() }}
          onKeyDown={(e) => e.stopPropagation()}
          aria-pressed={saved}
          aria-label={saved ? 'Remove from saved' : 'Save template'}
          className={cn(
            'absolute right-2.5 top-2.5 z-10 flex h-8 w-8 items-center justify-center rounded-full shadow-sm backdrop-blur transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            saved ? 'bg-primary/10 text-primary' : 'bg-card/80 text-muted-foreground hover:text-primary',
          )}
        >
          <Heart className={cn('h-4 w-4', saved && 'fill-current')} aria-hidden="true" />
        </button>

        {/* Live mini-preview strip */}
        <div className="overflow-hidden rounded-t-2xl border-b border-border">
          <TemplateMiniPreview notebook={notebook} tint={tint} />
        </div>

        {/* Card body */}
        <div className="flex flex-col gap-2 p-4">
          {/* Badges row */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="gap-1">
              <TypeIcon className="h-3 w-3" aria-hidden="true" />
              {typeLabel}
            </Badge>
            <Badge variant="outline">{subjectLabel(template.subject)}</Badge>
          </div>

          {/* Title + description */}
          <div>
            <p className="text-sm font-semibold leading-tight text-foreground">{template.title}</p>
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{template.description}</p>
          </div>

          {/* Preview button — full width, stops propagation */}
          <Button
            variant="outline"
            size="sm"
            className="mt-1 w-full gap-1.5"
            onClick={(e) => { e.stopPropagation(); setQuickLookOpen(true) }}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={disabled || busy}
            aria-label={`Preview ${template.title}`}
          >
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            Preview
          </Button>
        </div>
      </div>

      <TemplateQuickLook
        template={template}
        notebook={notebook}
        open={quickLookOpen}
        onOpenChange={setQuickLookOpen}
        onUse={() => { setQuickLookOpen(false); onUse() }}
        busy={busy}
      />
    </>
  )
}
