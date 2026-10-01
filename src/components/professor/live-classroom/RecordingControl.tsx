// Record toggle pill for the live classroom control bar. Opt-in (default off);
// when active it shows a red dot + "Recording". Mirrors TranscriptionIndicator's
// styling so the status cluster stays consistent.

'use client'

import { Circle, AlertCircle } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface RecordingControlProps {
  isRecording: boolean
  error: string | null
  onToggle: () => void
  compact?: boolean
}

/** No theme prop: the `.lc-stage` scope re-points these tokens over the
 *  fullscreen stage (see globals.css), so one set of classes covers both surfaces. */
export function RecordingControl({
  isRecording,
  error,
  onToggle,
  compact = false,
}: RecordingControlProps) {
  if (error) {
    return (
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggle}
              className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-card px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/5"
            >
              <AlertCircle className="h-3.5 w-3.5" />
              <span className="font-medium">Recording error</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {error}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onToggle}
            aria-label={isRecording ? 'Stop recording' : 'Record this session'}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition duration-200 ease-out ${
              isRecording
                ? 'border-destructive/30 bg-destructive/10 text-foreground'
                : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            <Circle
              className={`h-3 w-3 ${isRecording ? 'animate-pulse motion-reduce:animate-none fill-destructive text-destructive' : ''}`}
            />
            {!compact && <span className="font-medium">{isRecording ? 'Recording' : 'Record'}</span>}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {isRecording ? 'Click to stop recording' : 'Record this session (audio + slides)'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
