// The Athena composer — one box used by the docked dock, the greeting and the
// fullscreen surface (dock v2, prototype variant 01).
//
// Four things live in it beyond the textarea:
//   · the drive-mode pill — Co-pilot / Chat only, the ONE autonomy axis Athena
//     actually has (see the mode descriptions; she can't write anything either
//     way, so the only question is "may she move my screen?")
//   · attach — files upload to the private athena-attachments bucket and are
//     inlined into the prompt server-side; the same pipeline the professor
//     console uses (see use-athena-attachments)
//   · the round send / stop
//   · Athena mulling: when she has a suggestion, the box's border comes alive
//     with her own gradient, and hovering it condenses the vapour into the exact
//     prompt a click would send. ✕ or Escape waves it away.

'use client'

import { useEffect, useId, useMemo, useRef } from 'react'
import { ArrowUp, Loader2, Square, Paperclip, MousePointerClick, MessageCircle, Check } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AttachmentChip } from '@/components/shared/athena/AttachmentChip'
import { acceptAttribute, STUDENT_ATTACHMENTS } from '@/lib/ai/athena-attachments'
import { useAthenaAttachments, type AthenaFilePart } from '@/lib/hooks/use-athena-attachments'
import type { DriveMode } from '@/lib/hooks/use-athena-drive-mode'

/**
 * The Gemini mark, for the model attribution in the drive-mode popover.
 *
 * Source: "Google Gemini icon 2025" by Google LLC, public domain, via Wikimedia
 * Commons — https://commons.wikimedia.org/wiki/File:Google_Gemini_icon_2025.svg
 *
 * Redrawn from that file's silhouette + gradient rather than embedded verbatim:
 * the original builds its colour from ten blurred blobs behind a mask, which is
 * ~8KB of filters that render as mud at the 10px this appears at. The gradient id
 * is per-instance (useId) so two mounted composers can't collide on it.
 */
function GeminiMark({ className }: { className?: string }) {
  const gradientId = useId()
  return (
    <svg viewBox="0 0 65 65" className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id={gradientId} x1="18.4" y1="43.4" x2="52.2" y2="15" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4893FC" />
          <stop offset=".27" stopColor="#4893FC" />
          <stop offset=".777" stopColor="#969DFF" />
          <stop offset="1" stopColor="#BD99FE" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 001.999-5.905A1.485 1.485 0 0132.447 0z"
      />
    </svg>
  )
}

const MODES: { value: DriveMode; label: string; description: string }[] = [
  {
    value: 'copilot',
    label: 'Co-pilot',
    description: 'Athena opens pages and highlights what she’s explaining. She still can’t write anything',
  },
  {
    value: 'chat',
    label: 'Chat only',
    description: 'Athena answers and leaves your screen exactly where it is',
  },
]

export function AthenaComposer({
  /* Controls are h-11 (44px) on touch and revert to their compact sizes from sm: up
     (#664). Measured at 390px they were 28px (attach) and 32px (send, stop, mode pill)
     — under the 44px guideline. All were tappable, so this is reachability margin on the
     surface a student uses one-handed, not a broken control. */
  sectionId,
  value,
  onChange,
  onSend,
  onStop,
  isLoading,
  isStreaming,
  placeholder,
  driveMode,
  onDriveModeChange,
  mulling,
  onSendMulling,
  onDismissMulling,
  autoFocus = false,
}: {
  /** Scopes uploads — the route re-checks enrollment in this section. */
  sectionId: string
  value: string
  onChange: (v: string) => void
  /** Send the box's text (the parent owns it) plus any uploaded files. */
  onSend: (files: AthenaFilePart[]) => void
  onStop: () => void
  isLoading: boolean
  isStreaming: boolean
  placeholder: string
  driveMode: DriveMode
  onDriveModeChange: (mode: DriveMode) => void
  /** The prompt she's mulling over, or null when she has nothing to offer. */
  mulling: string | null
  onSendMulling: () => void
  onDismissMulling: () => void
  autoFocus?: boolean
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const {
    attachments,
    addFiles,
    removeAttachment,
    clear: clearAttachments,
    uploading,
    canAttach,
    readyFileParts,
  } = useAthenaAttachments({
    limits: STUDENT_ATTACHMENTS,
    endpoint: '/api/chat/upload',
    fields: useMemo(() => ({ sectionId }), [sectionId]),
  })

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  // A file on its own IS a question ("what's wrong with this?"), so send opens up
  // as soon as either the box or the chip row has something in it.
  const files = readyFileParts()
  const canSend = !!value.trim() || files.length > 0

  // The parent clears the value on send; collapse the auto-grown box with it, or
  // a multi-line message leaves a tall empty well behind.
  const send = () => {
    if (!canSend || isLoading) return
    if (uploading) {
      toast.error('Hold on — your file is still uploading')
      return
    }
    onSend(files)
    clearAttachments()
    if (fileRef.current) fileRef.current.value = ''
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const mode = MODES.find((m) => m.value === driveMode) ?? MODES[0]

  return (
    <div className="athena-composer-wrap relative shrink-0">
      {/* Her vapour, and the ghost prompt it condenses into on hover. The two are
          adjacent siblings on purpose — the reveal is a CSS `+` selector. */}
      <div
        className="athena-vapor"
        data-on={mulling ? 'true' : undefined}
        aria-hidden
        title="Athena is mulling something over — hover to see it"
      >
        <i />
      </div>
      <div className="athena-ghost">
        {mulling && (
          <>
            <button
              type="button"
              onClick={onSendMulling}
              className="rounded-2xl rounded-br-md border-[1.5px] border-dashed border-primary/45 bg-primary/10 px-3 py-2 text-left text-sm leading-relaxed text-foreground/80 transition-colors hover:border-primary/70 hover:text-foreground"
            >
              {/* Word-by-word condense: she's still forming the thought. */}
              {mulling.split(' ').map((word, i) => (
                <span key={`${word}-${i}`} data-athena-word style={{ animationDelay: `${i * 45 + 80}ms` }}>
                  {word}&nbsp;
                </span>
              ))}
            </button>
            <div className="flex items-center gap-2.5 pr-1">
              <button
                type="button"
                onClick={onDismissMulling}
                className="rounded-xl px-1.5 py-0.5 text-[10.5px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Dismiss
              </button>
              <span className="text-[10.5px] font-semibold text-primary">click to send ↵</span>
            </div>
          </>
        )}
      </div>

      <div className="athena-composer rounded-2xl border border-border/60 bg-card/70 px-2.5 py-2 shadow-sm transition focus-within:border-ring/50 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/20">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} data={a} onRemove={() => removeAttachment(a.id)} />
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={placeholder}
          rows={1}
          enterKeyHint="send"
          aria-label="Message Athena"
          className="max-h-40 min-h-8 w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60"
        />

        <div className="mt-1 flex items-center gap-2">
          <div className="mr-auto flex min-w-0 items-center gap-1.5">
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={acceptAttribute(STUDENT_ATTACHMENTS)}
              className="hidden"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? [])
                if (picked.length) addFiles(picked)
                // Reset, or re-picking the same file fires no change event.
                e.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={!canAttach || isLoading}
              aria-label="Attach a file"
              title={
                canAttach
                  ? 'Attach a file — a PDF, image, doc or slide deck'
                  : `You can attach up to ${STUDENT_ATTACHMENTS.maxFiles} files`
              }
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 sm:h-7 sm:w-7"
            >
              <Paperclip className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title="How Athena can act in the app"
                className={`flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-xs font-semibold transition hover:bg-accent hover:text-foreground sm:h-8 ${
                  driveMode === 'copilot' ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                {driveMode === 'copilot' ? (
                  <MousePointerClick className="h-3.5 w-3.5 text-primary" aria-hidden />
                ) : (
                  <MessageCircle className="h-3.5 w-3.5" aria-hidden />
                )}
                {mode.label}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-72">
              {MODES.map((m) => (
                <DropdownMenuItem
                  key={m.value}
                  onSelect={() => onDriveModeChange(m.value)}
                  className="items-start gap-2.5"
                >
                  {m.value === 'copilot' ? (
                    <MousePointerClick className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold">{m.label}</span>
                    <span className="block text-[11px] leading-snug text-muted-foreground">{m.description}</span>
                  </span>
                  <Check
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-primary ${driveMode === m.value ? '' : 'invisible'}`}
                    aria-hidden
                  />
                </DropdownMenuItem>
              ))}
              {/* Attribution, not a picker: student chats always run on Flash. */}
              <div
                className="flex items-center gap-1 px-2 pb-1 pt-1.5 text-[9.5px] text-muted-foreground"
                title="Student chats always run on Gemini Flash — the model can't be changed"
              >
                Powered by <GeminiMark className="h-2.5 w-2.5" /> Gemini Flash
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground transition hover:bg-secondary/80 sm:h-8 sm:w-8"
            >
              <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!canSend || isLoading}
              aria-label="Send"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40 sm:h-8 sm:w-8"
            >
              {/* The prototype's up-arrow, not a paper plane: the docked and
                  fullscreen composers are one component, so they were already
                  identical — this aligns both with the demo. */}
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ArrowUp className="h-4 w-4" strokeWidth={2.2} aria-hidden />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
