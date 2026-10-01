'use client'

// The student's side of the attendance join code (#82).
//
// Deliberately a BANNER, not a modal. The code gates the attendance tick, not the room, so
// blocking the slides behind a dialog would take away the thing the student came for — and a
// student who is legitimately remote, or whose network dropped, should still be able to follow
// the class. The banner sits above the deck and can be dismissed for the session.
//
// It only ever appears on a first heartbeat. Once a student is marked present the server stops
// asking, so a browser crash mid-class costs them nothing.

import { useState } from 'react'
import { KeyRound, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { JOIN_CODE_LENGTH, isWellFormedJoinCode } from '@/lib/live-classroom/join-code'

interface AttendanceCodePromptProps {
  /** Resolves to an error message, or null when the code was accepted. */
  onSubmit: (code: string) => Promise<string | null>
  onDismiss: () => void
}

export function AttendanceCodePrompt({ onSubmit, onDismiss }: AttendanceCodePromptProps) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /* Checked here as well as on the server, for the student's benefit rather than security:
     the server counts every attempt before comparing, so submitting an obvious typo (a letter
     O, which is not in the alphabet) would spend one of their ten tries on nothing. */
  const wellFormed = isWellFormedJoinCode(code)

  async function submit() {
    if (busy || !wellFormed) return
    setBusy(true)
    setError(null)
    try {
      const message = await onSubmit(code)
      if (message) setError(message)
      // No success branch: the parent marks the student present and unmounts this banner.
    } finally {
      setBusy(false)
    }
  }

  return (
    /* `pointer-events-auto`: the wrapper in StudentClassroomView is
       pointer-events-none so its padding region stops swallowing clicks aimed
       at the stage controls behind it. This card is the part that must stay
       interactive. */
    <div className="pointer-events-auto rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-foreground">
          Enter the code on screen to be marked present
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={code}
            onChange={(e) => {
              setCode(e.target.value)
              // Clear the red text on the first correcting keystroke, not on submit — it
              // otherwise sits there accusing them through the whole retype.
              if (error) setError(null)
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
            maxLength={JOIN_CODE_LENGTH + 2}
            placeholder="••••"
            aria-label="Attendance code"
            aria-invalid={!!error}
            /* Uppercase + wide tracking so what they type looks like what is on the wall.
               autoCapitalize/autoCorrect off: phone keyboards otherwise "helpfully" turn a
               4-character code into a word. */
            /* 44px on a phone, the app's usual h-9 from sm up. A student taps this once,
               one-handed, in a lecture hall — the one place in the flow where the standard
               control size is genuinely too small to hit. Sized here rather than by changing
               the shared button, which would move every control in the app. */
            className="h-11 w-24 text-center font-mono text-base uppercase tracking-[0.2em] sm:h-9"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <Button
            size="sm"
            className="h-11 sm:h-8"
            onClick={() => void submit()}
            disabled={busy || !wellFormed}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Check in'}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-11 sm:size-9"
            onClick={onDismiss}
            aria-label="Dismiss attendance check-in"
            /* Dismissal stopped being permanent — the parent lapses it after
               DISMISS_MINUTES and the next heartbeat asks again — but this copy
               still threatened the old consequence, which is worse than saying
               nothing: it tells a student the mis-tap they just made cost them
               their attendance mark when it did not. */
            title="Hide this for now. We'll ask again shortly — you can still check in."
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-1.5 pl-6 text-xs text-destructive">{error}</p>
      )}
    </div>
  )
}
