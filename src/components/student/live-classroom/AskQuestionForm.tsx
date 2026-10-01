// Student Q&A input. Submits a question to the room; the broadcast
// trigger fires interaction_created and every other client + the prof
// see the new question appear. Visual layer only.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Send, EyeOff, MessageCirclePlus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { askQuestion } from '@/lib/live-classroom/interactions/actions'
import { useAthenaPrefill } from '@/lib/hooks/use-athena-prefill'

const MAX_LEN = 500

interface Props {
  roomId: string
}

export function AskQuestionForm({ roomId }: Props) {
  const [text, setText] = useState('')
  const [anonymous, setAnonymous] = useState(false)
  const [pending, setPending] = useState(false)
  const [focused, setFocused] = useState(false)

  /* C11 — a question Athena drafted from something this student actually got
     wrong (design doc §14). It arrives as a plain string through the pre-fill
     handoff and lands here as an ordinary controlled value: it is rendered as
     text in a textarea, never as markup, and nothing is sent until the student
     presses Send. They can edit it, clear it, or ignore it.

     It NEVER overwrites what they were already typing — asking "what should I
     ask?" half-way through composing a question is an ordinary thing to do, and
     losing their words to a suggestion would be a bad trade. But dropping the
     draft silently was the wrong other half of that: the dock has already told
     them it's "ready in the question box". So a non-empty box keeps its words
     and the draft is offered above it instead, to take or dismiss. */
  const draft = useAthenaPrefill('lc_question')
  const [appliedDraft, setAppliedDraft] = useState<string | null>(null)
  const [offered, setOffered] = useState<string | null>(null)
  if (draft && draft !== appliedDraft) {
    setAppliedDraft(draft)
    // Clamped like any typed input: setState bypasses the textarea's own
    // maxLength, and an over-limit value would land the student in a form whose
    // Send button is already disabled.
    if (text.trim()) setOffered(draft.slice(0, MAX_LEN))
    else setText(draft.slice(0, MAX_LEN))
  }

  const handleSubmit = async () => {
    if (!text.trim()) return
    setPending(true)
    try {
      const result = await askQuestion({ roomId, text: text.trim(), anonymous })
      if (result.error) toast.error(result.error)
      else {
        setText('')
        setOffered(null)
        toast.success('Question sent')
      }
    } finally {
      setPending(false)
    }
  }

  const remaining = MAX_LEN - text.length
  const canSubmit = text.trim().length > 0 && remaining >= 0 && !pending
  const overLimit = remaining < 0
  const nearLimit = remaining < 50 && remaining >= 0

  return (
    <TooltipProvider delayDuration={250}>
      <section className="rounded-3xl ring-1 ring-border/50 shadow-sm bg-background overflow-hidden">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <MessageCirclePlus className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
              Ask a question
            </h3>
          </div>
        </header>
        <div className="p-4 space-y-3">
          {/* Her draft, when the student already had words of their own. Same
              dashed-outline treatment the dock uses for a suggestion she's
              mulling over, so it reads as the same kind of object in both
              places. Rendered as text, never markup. */}
          {offered && (
            <div className="rounded-2xl border border-dashed border-primary/45 bg-primary/10 p-3">
              <p className="text-sm text-foreground/80">{offered}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Athena drafted this from a question you missed. You can ask anonymously below.
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  onClick={() => {
                    setText(offered)
                    setOffered(null)
                  }}
                >
                  Use this instead
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="rounded-full"
                  onClick={() => setOffered(null)}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          )}
          <div
            className={`rounded-2xl border transition-colors ${
              focused ? 'border-foreground/50 bg-muted/10' : 'border-border'
            }`}
          >
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX_LEN))}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="What didn't quite click? Ask anything…"
              rows={3}
              className="border-0 resize-none focus-visible:ring-0 focus-visible:border-0 rounded-2xl bg-transparent text-sm leading-relaxed"
              maxLength={MAX_LEN}
            />
            <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <label
                    htmlFor="anon"
                    className="flex items-center gap-2 cursor-pointer select-none rounded-full px-2 py-1 hover:bg-muted/40 transition-colors"
                  >
                    <Checkbox
                      id="anon"
                      checked={anonymous}
                      onCheckedChange={(v) => setAnonymous(!!v)}
                      className="h-3.5 w-3.5"
                    />
                    <Label htmlFor="anon" className="text-xs cursor-pointer flex items-center gap-1 text-muted-foreground">
                      <EyeOff className="h-3 w-3" />
                      Ask anonymously
                    </Label>
                  </label>
                </TooltipTrigger>
                <TooltipContent side="top">Hide your name from peers</TooltipContent>
              </Tooltip>

              <span
                className={`text-xs tabular-nums transition-colors ${
                  overLimit
                    ? 'text-foreground font-semibold'
                    : nearLimit
                      ? 'text-foreground'
                      : 'text-muted-foreground'
                }`}
              >
                {remaining}
              </span>
            </div>
          </div>

          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full rounded-full h-11 font-semibold"
          >
            {pending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                Sending…
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5 mr-2" />
                Send question
              </>
            )}
          </Button>
        </div>
      </section>
    </TooltipProvider>
  )
}
