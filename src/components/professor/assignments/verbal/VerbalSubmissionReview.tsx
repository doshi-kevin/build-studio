/**
 * Professor's view of a submitted Verbal Assessment: the recorded video plus the per-question
 * transcript and MCQ selection. Clicking a question seeks the video to where that question
 * began. The professor grades from this (no AI grading).
 *
 * Type: Client Component
 */
'use client'

import { useRef } from 'react'
import { MessageSquare, ListChecks, Play } from 'lucide-react'
import { StudioMarkdown } from '@/components/professor/assignments/studio/shared/StudioMarkdown'
import type { VerbalSubmissionAnswer } from '@/lib/validations/assignment'

export function VerbalSubmissionReview({
  videoUrl, answers,
}: {
  videoUrl: string | null
  answers: VerbalSubmissionAnswer[]
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  function seekTo(seconds: number | undefined) {
    const v = videoRef.current
    if (!v) return
    if (typeof seconds === 'number') v.currentTime = seconds
    v.play().catch(() => undefined)
    v.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  function fmt(s: number) {
    const m = Math.floor(s / 60)
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  }

  return (
    <div className="space-y-4">
      {videoUrl ? (
        <video ref={videoRef} controls src={videoUrl} className="aspect-video w-full rounded-xl border border-border bg-foreground/5" />
      ) : (
        <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">Recording unavailable.</p>
      )}

      <div className="space-y-3">
        {answers.length === 0 && <p className="text-sm text-muted-foreground">No transcribed answers were captured.</p>}
        {answers.map((a, i) => {
          const canSeek = videoUrl != null && typeof a.videoOffset === 'number'
          return (
            <div key={a.cellId + i} className="rounded-xl border border-border p-3">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  {a.type === 'mcq' ? <ListChecks className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
                  Question {i + 1}
                </span>
                {canSeek && (
                  <button
                    type="button"
                    onClick={() => seekTo(a.videoOffset)}
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    <Play className="h-3 w-3" /> Jump to {fmt(a.videoOffset!)}
                  </button>
                )}
              </div>
              <div className="text-sm text-foreground"><StudioMarkdown content={a.prompt} /></div>
              {a.type === 'mcq' && a.selectedOptionText && (
                <p className="mt-2 text-sm"><span className="text-muted-foreground">Selected:</span> <span className="font-medium text-foreground">{a.selectedOptionText}</span></p>
              )}
              <div className="mt-2 rounded-lg bg-muted/50 p-2.5">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Transcript</p>
                <p className="whitespace-pre-wrap text-sm text-foreground">{a.transcript?.trim() || <span className="text-muted-foreground">No speech transcribed (review the recording).</span>}</p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
