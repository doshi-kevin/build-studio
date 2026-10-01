// Minimal mic toggle pill for the live classroom toolbar. When active,
// shows a simple mic icon with a subtle label — no distracting animations.
// TranscriptionMicMenu (below) is the companion device picker: a small caret
// beside the pill listing audio inputs (e.g. a wireless lav mic vs built-in).

'use client'

import { Mic, MicOff, AlertCircle, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAudioInputDevices, resolveMicDeviceId } from '@/lib/live-classroom/audio-devices'

interface TranscriptionIndicatorProps {
  isListening: boolean
  isConnected: boolean
  voiceLevel: number
  error: string | null
  onToggle: () => void
  /** Icon-only (drop the text label) when the control bar is tight — e.g. the
   *  Engage sidebar insets the stage. The tooltip retains the meaning. */
  compact?: boolean
}

export function TranscriptionIndicator({
  isListening,
  isConnected,
  error,
  onToggle,
  compact = false,
}: TranscriptionIndicatorProps) {
  if (error) {
    return (
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggle}
              className="inline-flex items-center gap-1.5 rounded-full bg-card border border-destructive/30 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/5 transition-colors"
            >
              <AlertCircle className="h-3.5 w-3.5" />
              <span className="font-medium">Error</span>
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
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs border transition duration-200 ease-out ${
              isListening
                ? 'bg-foreground/5 border-foreground/20 text-foreground'
                : 'bg-card border-border text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
          >
            {isListening ? (
              <>
                <Mic className="h-3.5 w-3.5" />
                {!compact && <span className="font-medium">Transcribing</span>}
                {!compact && !isConnected && (
                  <span className="text-xs text-muted-foreground">(reconnecting)</span>
                )}
              </>
            ) : (
              <>
                <MicOff className="h-3.5 w-3.5" />
                {!compact && <span className="font-medium">Transcribe</span>}
              </>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {isListening
            ? 'Click to stop transcription'
            : 'Start live transcription'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// Virtual entries some platforms inject; the explicit "System default"
// option covers them.
const VIRTUAL_DEVICE_IDS = new Set(['default', 'communications'])

interface TranscriptionMicMenuProps {
  /** Called after the professor picks a different device — the parent
   *  restarts any active capture on the new mic. */
  onDeviceChange?: () => void
}

export function TranscriptionMicMenu({ onDeviceChange }: TranscriptionMicMenuProps) {
  const { devices, hasLabels, pref, select, requestAccess } = useAudioInputDevices()
  const items = devices.filter((d) => !VIRTUAL_DEVICE_IDS.has(d.deviceId))
  const activeValue = resolveMicDeviceId(pref, items) ?? 'default'

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // Device labels are empty until mic permission is granted — prime it
        // on first open so the list shows real names. A deny needs feedback:
        // otherwise the empty list reads as "no microphones".
        if (open && !hasLabels) {
          void requestAccess().then((ok) => {
            if (!ok) toast.error('Microphone access blocked — allow it in your browser to choose a device.')
          })
        }
      }}
    >
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="Choose microphone"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Choose microphone</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel>Microphone</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={activeValue}
          onValueChange={(value) => {
            if (value === activeValue) return
            if (value === 'default') {
              select(null)
            } else {
              const device = items.find((d) => d.deviceId === value)
              if (!device) return
              select({ deviceId: device.deviceId, label: device.label })
            }
            onDeviceChange?.()
          }}
        >
          <DropdownMenuRadioItem value="default">System default</DropdownMenuRadioItem>
          {items.map((d) => (
            <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId}>
              {d.label || 'Microphone'}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {!hasLabels && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Allow microphone access to see your devices.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
