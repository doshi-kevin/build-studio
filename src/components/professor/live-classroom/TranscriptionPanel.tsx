'use client'

import { useRef, useEffect, memo } from 'react'
import { Mic, MicOff } from 'lucide-react'

interface TranscriptionPanelProps {
  transcriptByPage: Map<number, string>
  partialText: string
  currentSlide: number
  isListening: boolean
}

const PageBlock = memo(function PageBlock({
  pageNumber,
  text,
  isCurrent,
}: {
  pageNumber: number
  text: string
  isCurrent: boolean
}) {
  return (
    <div className={`rounded-2xl p-4 space-y-2 ${isCurrent ? 'ring-1 ring-border/50 bg-muted/20' : ''}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
          Slide {pageNumber + 1}
        </span>
        {isCurrent && (
          <span className="lc-live-dot h-1.5 w-1.5 text-success" aria-hidden />
        )}
      </div>
      <p className="text-sm leading-relaxed text-foreground/80">{text}</p>
    </div>
  )
})

export function TranscriptionPanel({
  transcriptByPage,
  partialText,
  currentSlide,
  isListening,
}: TranscriptionPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      const parent = scrollRef.current.closest('[class*="overflow-y-auto"]')
      if (parent) {
        parent.scrollTop = parent.scrollHeight
      }
    }
  }, [transcriptByPage, partialText])

  const hasTranscript = transcriptByPage.size > 0 || partialText.length > 0

  const sortedPages = Array.from(transcriptByPage.entries()).sort(
    ([a], [b]) => a - b,
  )

  if (!isListening && !hasTranscript) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
        <div className="rounded-full bg-muted/40 p-4 mb-4 ring-1 ring-border/50">
          <MicOff className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium mb-1">No transcript yet</p>
        <p className="text-xs text-muted-foreground max-w-[240px]">
          Start transcribing from the bottom dock to see a live transcript of your lecture here.
        </p>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="space-y-3">
      {isListening && !hasTranscript && (
        <div className="flex items-center gap-3 rounded-2xl bg-muted/20 ring-1 ring-border/50 p-4">
          <span className="lc-live-dot h-3 w-3 shrink-0 text-success" aria-hidden />
          <p className="text-sm text-muted-foreground">Listening… Transcript will appear as you speak.</p>
        </div>
      )}

      {sortedPages.map(([pageNumber, text]) => (
        <PageBlock
          key={pageNumber}
          pageNumber={pageNumber}
          text={text}
          isCurrent={pageNumber === currentSlide}
        />
      ))}

      {partialText && (
        <div className="rounded-2xl p-4 bg-muted/10">
          <div className="flex items-center gap-2 mb-2">
            <Mic className="h-3 w-3 text-success" />
            <span className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
              Live
            </span>
          </div>
          <p className="text-sm text-muted-foreground/70 italic">{partialText}</p>
        </div>
      )}
    </div>
  )
}
