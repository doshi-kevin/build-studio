/**
 * TemplateQuickLook: a full-height "Preview" dialog for a built-in marketplace template.
 * Renders the template's cells read-only (markdown + code) with a "Use this template" CTA.
 * Renders cells directly (not StudentNotebookView) so there's no "Download .ipynb" chrome.
 *
 * Type: Client Component
 */
'use client'

import { ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { StudioMarkdown } from '@/components/professor/assignments/studio/shared/StudioMarkdown'
import { CodeBlock } from '@/components/professor/assignments/studio/shared/CodeBlock'
import { subjectLabel } from '@/lib/assignments/studio/marketplace-catalog'
import type { StudioNotebook } from '@/lib/assignments/studio/notebook-model'
import type { MarketplaceTemplate } from '@/lib/assignments/studio/marketplace-catalog'

interface TemplateQuickLookProps {
  template: MarketplaceTemplate
  notebook: StudioNotebook | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onUse: () => void
  busy?: boolean
}

export function TemplateQuickLook({ template, notebook, open, onOpenChange, onUse, busy }: TemplateQuickLookProps) {
  const typeLabel = template.kind === 'stem' ? 'STEM Problem Set' : 'Notebook'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4 text-left">
          <DialogTitle className="text-base font-semibold">{template.title}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {typeLabel} · {subjectLabel(template.subject)}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {notebook && notebook.cells.length > 0 ? (
            <div className="space-y-3">
              {notebook.cells.map((c, i) => (
                <div key={c.id ?? i} className="rounded-xl border border-border bg-card p-3">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {c.cell_type === 'code' ? 'Code' : c.cell_type === 'markdown' ? 'Markdown' : 'Text'}
                  </p>
                  {c.cell_type === 'code' ? (
                    <CodeBlock code={c.source || ' '} />
                  ) : (
                    <StudioMarkdown content={c.source} />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-40 items-center justify-center rounded-xl border border-border bg-muted text-sm text-muted-foreground">
              Preview not available
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 flex-row gap-2 border-t border-border px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
          <Button onClick={onUse} disabled={busy} aria-busy={busy} className="gap-1.5">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            )}
            Use this template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
