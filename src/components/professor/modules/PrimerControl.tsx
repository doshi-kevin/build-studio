/**
 * PrimerControl — the pre-class primer for one lecture, as a single control.
 *
 * Previously five widgets competed for space on every lecture row (a label, an
 * info tooltip, a preview button, a regenerate button and a large switch), and
 * the switch ended up the loudest thing on a row whose subject is the lecture.
 * Now it's one headphones button whose tint carries the state; everything else
 * lives in the popover behind it.
 *
 * This is still the ONLY place a primer is generated — students never trigger
 * one. Generation happens once: switching ON the first time generates it, OFF
 * only stops offering it to students (the audio is kept), and a later ON
 * serves the same file. Only Regenerate re-generates, picking up lecture edits.
 *
 * Type: Client Component
 */
'use client'

import { useState, useEffect, useRef } from 'react'
import { AudioLines, FileText, Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import {
  makePrimerAvailable,
  disablePrimer,
  getPrimerStatusForItem,
  getPrimerPreview,
} from '@/app/(dashboard)/professor/courses/[sectionId]/modules/actions'

export type PrimerStatus = 'ready' | 'generating' | 'failed' | 'none'

export interface PrimerState {
  status: PrimerStatus
  available: boolean
}

const PRIMER_POLL_MS = 3000
const PRIMER_MAX_POLLS = 40 // ~2 min, then stop polling (a refresh shows truth)

export function PrimerControl({
  sectionId,
  moduleItemId,
  initialState,
}: {
  sectionId: string
  moduleItemId: string
  initialState: PrimerState
}) {
  const [status, setStatus] = useState<PrimerStatus>(initialState.status)
  const [available, setAvailable] = useState(initialState.available)
  const [busy, setBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [preview, setPreview] = useState<{ script: string; audioUrl: string } | null>(null)
  const pollCount = useRef(0)

  // While generating, poll until the primer flips to ready or failed.
  useEffect(() => {
    if (status !== 'generating') return
    pollCount.current = 0
    const id = setInterval(async () => {
      pollCount.current += 1
      if (pollCount.current > PRIMER_MAX_POLLS) {
        clearInterval(id)
        return
      }
      const res = await getPrimerStatusForItem(sectionId, moduleItemId)
      if (res.status === 'ready') setStatus('ready')
      else if (res.status === 'failed') {
        setStatus('none')
        setAvailable(false)
        toast.error('Primer generation failed. Try turning it on again.')
      }
      // 'none' can briefly appear before the claim row is written — keep waiting.
    }, PRIMER_POLL_MS)
    return () => clearInterval(id)
  }, [status, sectionId, moduleItemId])

  const generating = available && status === 'generating'

  const onToggle = async (next: boolean) => {
    setBusy(true)
    try {
      if (next) {
        setAvailable(true)
        // A primer that already exists is simply served again — no regeneration.
        if (status !== 'ready') setStatus('generating')
        const res = await makePrimerAvailable(moduleItemId, sectionId)
        if (res.error) {
          toast.error(res.error)
          setAvailable(false)
          if (status !== 'ready') setStatus('none')
        }
      } else {
        setAvailable(false)
        const res = await disablePrimer(moduleItemId, sectionId)
        if (res.error) {
          toast.error(res.error)
          setAvailable(true)
        }
      }
    } catch {
      toast.error('Could not update the primer')
    } finally {
      setBusy(false)
    }
  }

  const onRegenerate = async () => {
    setBusy(true)
    setStatus('generating') // old audio keeps serving students until the new one lands
    try {
      const res = await makePrimerAvailable(moduleItemId, sectionId, true)
      if (res.error) {
        toast.error(res.error)
        setStatus('ready')
      }
    } catch {
      toast.error('Could not regenerate the primer')
      setStatus('ready')
    } finally {
      setBusy(false)
    }
  }

  const openPreview = async () => {
    setPreviewLoading(true)
    try {
      const res = await getPrimerPreview(sectionId, moduleItemId)
      if (res.error || !res.audioUrl) {
        toast.error(res.error ?? 'Could not load preview')
        return
      }
      setPreview({ script: res.script ?? '', audioUrl: res.audioUrl })
      setPreviewOpen(true)
    } finally {
      setPreviewLoading(false)
    }
  }

  const triggerLabel = generating
    ? 'Primer is being prepared'
    : available
      ? 'Primer is available to students — open primer settings'
      : 'Primer is off — open primer settings'

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={triggerLabel}
            title={triggerLabel}
            className={cn(
              'flex shrink-0 items-center justify-center rounded-full transition-colors',
              'min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 p-2.5 sm:p-1.5',
              'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              /* Monochrome on purpose: colour on this surface means "what kind
                 of material is this". Availability reads from the filled glyph
                 and the label, not from a second hue competing with the chips. */
              available
                ? 'text-foreground hover:bg-muted'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {generating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <AudioLines
                className="h-3.5 w-3.5"
                /* AudioLines, not Headphones (#670). At 14px a FILLED Headphones loses the
                   interior detail that identifies it — the headband arch and two ear cups
                   collapse into a solid arch with two legs, which reads as a helmet. This
                   glyph's identity is the waveform strokes themselves, so it survives being
                   filled at that size. Filled vs outline still carries on/off instead of a
                   hue; only the glyph changed.
                   Stroke thickened while filled: at 14px the strokes merge into a block
                   otherwise, which is the same legibility trap one step along. */
                strokeWidth={available ? 2.5 : 2}
                aria-hidden
              />
            )}
          </button>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-72 space-y-3">
          <div>
            <p className="text-sm font-semibold">Pre-class primer</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              A 3–4 minute audio preview of this lecture. Students listen beforehand so they
              arrive already knowing what’s coming.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-3 py-2">
            <span className="text-xs font-medium">
              {generating ? 'Preparing…' : available ? 'On for students' : 'Off'}
            </span>
            <Switch
              checked={available}
              disabled={busy}
              onCheckedChange={onToggle}
              aria-label="Make this primer available to students"
            />
          </div>

          {available && status === 'ready' && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openPreview}
                disabled={previewLoading}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {previewLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                ) : (
                  <FileText className="h-3.5 w-3.5" aria-hidden />
                )}
                Preview
              </button>
              <button
                type="button"
                onClick={onRegenerate}
                disabled={busy}
                title="Regenerate (picks up lecture edits)"
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                Regenerate
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Exactly what students hear and can read. */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Primer preview</DialogTitle>
            <DialogDescription>This is exactly what students hear and can read.</DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-3">
              <audio src={preview.audioUrl} controls className="w-full" preload="metadata" />
              <div className="max-h-72 overflow-y-auto rounded-xl bg-muted/40 p-3">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {preview.script || 'No transcript available.'}
                </p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
