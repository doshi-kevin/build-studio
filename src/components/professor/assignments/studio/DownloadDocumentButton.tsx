/**
 * Download the document assignment as a PDF: render it to a printable HTML page in a new tab and
 * open the browser's print dialog (Save as PDF). Mirrors the notebook student view's Download PDF.
 * No new dependency — TipTap's generateHTML + the browser print path.
 *
 * Type: Client Component
 */
'use client'

import { Download } from 'lucide-react'
import { toast } from 'sonner'
import type { JSONContent } from 'novel'
import { Button } from '@/components/ui/button'
import { documentToHtml } from './shared/document-html'

export function DownloadDocumentButton({
  doc, title, variant = 'outline',
}: {
  doc: JSONContent
  title: string
  variant?: 'outline' | 'default' | 'ghost'
}) {
  function download() {
    const html = documentToHtml(doc, title)
    const w = window.open('', '_blank')
    if (!w) { toast.error('Allow pop-ups for this site to download the PDF.'); return }
    w.document.write(html)
    w.document.close()
    // The generated HTML's inline script handles the print trigger: it waits for KaTeX
    // auto-render + image decode before calling window.print(). No setTimeout needed here.
  }

  return (
    <Button type="button" size="sm" variant={variant} onClick={download}>
      <Download className="h-4 w-4" />
      Download PDF
    </Button>
  )
}
