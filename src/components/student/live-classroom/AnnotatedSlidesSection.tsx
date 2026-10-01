// Post-class "Annotated slides" for Student Class Insights. Deliberately minimal:
// a single slim row with a Download button (the professor's ink burned onto each
// slide, one PDF per deck) — no inline preview, so it doesn't dominate the page.
// The server page loads + authorizes the data and only mounts this when
// annotations exist, so there's no fetch/empty state here.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Download, Loader2, PenLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { downloadAnnotatedDeckPdf } from '@/lib/live-classroom/insights/annotated-slides-pdf'
import type { AnnotatedDeck, AnnotatedSlidesData } from '@/lib/live-classroom/insights/annotated-slides'
import { logger } from '@/lib/logger'

export function AnnotatedSlidesSection({ data }: { data: AnnotatedSlidesData }) {
  const multiDeck = data.decks.length > 1
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-5 py-4">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        <PenLine className="h-3.5 w-3.5" aria-hidden />
        Annotated slides
      </p>
      <div className="flex flex-wrap gap-2">
        {data.decks.map((deck) => (
          // One button per deck: just "Download" for a single deck, or the deck
          // title when a session spanned more than one.
          <DeckDownloadButton
            key={deck.deckId}
            deck={deck}
            label={multiDeck ? deck.title || 'Deck' : 'Download'}
          />
        ))}
      </div>
    </section>
  )
}

function DeckDownloadButton({ deck, label }: { deck: AnnotatedDeck; label: string }) {
  const [downloading, setDownloading] = useState(false)

  const onDownload = async () => {
    setDownloading(true)
    try {
      await downloadAnnotatedDeckPdf(deck, deck.title || 'Annotated slides')
    } catch (err) {
      logger.error('AnnotatedSlidesSection.download', err)
      toast.error('Couldn’t build the download. Please try again.')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={onDownload} disabled={downloading} className="shrink-0">
      {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      {downloading ? 'Preparing…' : label}
    </Button>
  )
}
