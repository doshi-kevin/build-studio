// Formula sheet reference shown during quiz attempts. A compact preview card
// (image thumbnail, or a tile for PDFs) that opens an enlarged popup on click —
// the same lightbox pattern used for image-based questions (see ImageLightbox
// in QuestionDisplay.tsx).

'use client'

import { useState } from 'react'
import { FileText, Expand } from 'lucide-react'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { VisuallyHidden } from 'radix-ui'

interface FormulaSheetPanelProps {
  url: string
}

export function FormulaSheetPanel({ url }: FormulaSheetPanelProps) {
  const [open, setOpen] = useState(false)

  // Match the extension before any query string — signed URLs end with `?token=…`.
  const isImage = /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Formula Sheet</span>
      </div>

      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group block w-full border-t border-border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        aria-label="Open formula sheet"
      >
        <div className="relative bg-muted/30 p-3">
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt="Formula sheet provided by your professor"
              className="mx-auto block max-h-56 w-auto rounded-xl object-contain"
            />
          ) : (
            <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground">
              <FileText className="h-8 w-8" />
              <span className="text-xs">PDF formula sheet</span>
            </div>
          )}
          <div className="absolute bottom-4 right-4 flex h-7 w-7 items-center justify-center rounded-xl border border-border bg-background/90 text-muted-foreground shadow-sm transition duration-200 ease-out group-hover:scale-110">
            <Expand className="h-3.5 w-3.5" />
          </div>
        </div>
        <div className="border-t border-border px-4 py-2 text-center text-xs text-muted-foreground transition-colors group-hover:text-foreground">
          Click to enlarge
        </div>
      </button>

      {/* Enlarged popup — same lightbox treatment as image questions */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[90vh] max-w-[90vw] overflow-auto border-border bg-background p-2 sm:max-w-4xl sm:p-4"
          showCloseButton
        >
          <VisuallyHidden.Root>
            <DialogTitle>Formula sheet (enlarged)</DialogTitle>
          </VisuallyHidden.Root>
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt="Formula sheet provided by your professor"
              className="mx-auto block max-h-[80vh] w-auto rounded-xl object-contain"
            />
          ) : (
            <iframe
              src={url}
              title="Formula Sheet PDF"
              className="h-[80vh] w-full rounded-xl border-0"
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
