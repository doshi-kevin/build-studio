/**
 * StudentPrimerButton — inline "Listen before class" control shown on a lecture
 * item in the student Modules view when the professor has made a primer
 * available. Clicking fetches the shared audio and opens a small player with the
 * transcript. Students only listen — nothing is generated here.
 *
 * Type: Client Component.
 */
'use client'

import { useEffect, useRef, useState } from 'react'
import { AudioLines, Loader2, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { getPrimer } from '@/app/(dashboard)/student/courses/[sectionId]/modules/primer-actions'

const SPEEDS = [1, 1.25, 1.5, 2] as const

interface StudentPrimerButtonProps {
  sectionId: string
  moduleItemId: string
}

export function StudentPrimerButton({ sectionId, moduleItemId }: StudentPrimerButtonProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<{ audioUrl: string; script: string } | null>(null)
  const [showScript, setShowScript] = useState(false)
  const [speed, setSpeed] = useState(1)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed
  }, [speed, data])

  const onListen = async (e: React.MouseEvent) => {
    e.stopPropagation() // the row itself is clickable (opens the file) — don't trigger that
    setLoading(true)
    try {
      const res = await getPrimer(sectionId, moduleItemId)
      if (res.status !== 'ready' || !res.audioUrl) {
        toast.error(res.error ?? 'This primer isn’t available right now.')
        return
      }
      setData({ audioUrl: res.audioUrl, script: res.script ?? '' })
      setShowScript(false)
      setSpeed(1)
      setOpen(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onListen}
        disabled={loading}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-50"
        title="Listen to this before your next class"
      >
        {/* AudioLines, matching PrimerControl: a filled Headphones at 14px reads as a
            helmet (#670). Not filled here, but kept identical so the two surfaces name
            the same feature with the same glyph. */}
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AudioLines className="h-3.5 w-3.5" />}
        Listen before class
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Listen before your next class</DialogTitle>
            <DialogDescription>
              A quick primer on what this lecture covers — it helps you get more out of class.
            </DialogDescription>
          </DialogHeader>
          {data && (
            <div className="space-y-3">
              <audio ref={audioRef} src={data.audioUrl} controls autoPlay className="w-full" preload="auto" />
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Speed</span>
                <div className="flex items-center gap-1">
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setSpeed(s)}
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-medium tabular-nums transition-colors',
                        speed === s
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
              </div>
              {data.script && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowScript((v) => !v)}
                    className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                    aria-expanded={showScript}
                  >
                    <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showScript && 'rotate-180')} />
                    {showScript ? 'Hide script' : 'Show script'}
                  </button>
                  {showScript && (
                    <div className="mt-2 max-h-72 overflow-y-auto rounded-xl bg-muted/40 p-3">
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                        {data.script}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
