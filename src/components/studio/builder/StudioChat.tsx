'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, CornerDownRight, Sparkles, Square, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ApprovalCard, Chip, EndingCard, PlanCard, ProgressLines, QuestionCard, RunTimeline, StatusChip } from './RunCards'
import { ACTIVE_STATUSES, ENDED_UNBUILT, type ConversationTurn, type DraftHistoryEntry, type ProgressRead } from './types'

interface StudioChatProps {
  turns: ConversationTurn[]
  /** Whether `turns` has loaded. A failed load offers a retry instead of an empty chat. */
  conversation: 'loading' | 'ready' | 'failed'
  onReloadConversation: () => void
  /** The run this pane follows, usually the newest. */
  current: { runId: string; progress: ProgressRead | null; events: ProgressRead['events']; unreachable: boolean } | null
  /** The project's drafts, to mark which request made the current or a saved draft. Null while unknown. */
  drafts: DraftHistoryEntry[] | null
  /** Send a request. Resolves to a refusal message, or a waiting run the professor must confirm replacing. */
  onSend: (text: string, replaceRunId?: string) => Promise<{ error?: string; waitingRunId?: string } | null>
  onStop: () => Promise<void>
  onDecide: (approve: boolean) => Promise<string | null>
  onAnswer: (answer: string) => Promise<string | null>
  /** Approve or skip a decision Athena suggests remembering. Resolves to a message when it failed. */
  onDecideMemory: (memoryId: string, approve: boolean) => Promise<string | null>
  /** The header's Save is offered for the draft on screen. */
  saveAvailable?: boolean
  /** The step after Save (Add to this course), shown at the end of the conversation. */
  release?: React.ReactNode
  composerRef?: React.RefObject<HTMLTextAreaElement | null>
}

/** Within this many pixels of the bottom, new messages keep the log scrolled down. */
const PINNED_PX = 96

/** "3:40 PM" today, "Fri 3:40 PM" otherwise. Fixed text, so the log doesn't re-announce old turns. */
function sentLabel(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const sameDay = at.toDateString() === new Date().toDateString()
  return at.toLocaleString(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/** A note longer than this starts folded to three lines. */
const isLong = (text: string) => text.length > 200 || text.split('\n').length > 3

/** How an earlier request ended: its status, the draft it made, and Athena's note (plain text). */
function PastReply({ turn, entry }: { turn: ConversationTurn; entry: DraftHistoryEntry | undefined }) {
  const [open, setOpen] = useState(false)
  const summary = turn.summary
  const long = !!summary && isLong(summary)
  // Success endings are what the chip says; the others carry what happened.
  const showEnding = turn.ending && turn.status !== 'preview_ready' && turn.status !== 'completed'
  return (
    <div className="space-y-2 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={turn.status} />
        {entry?.current && <Chip tone="info">Current draft</Chip>}
        {entry?.savedVersion && (
          <Chip tone="success" icon={Check}>
            Saved as v{entry.savedVersion}
          </Chip>
        )}
      </div>
      {showEnding && <p className="text-muted-foreground">{turn.ending}</p>}
      {summary && (
        <>
          <p className={cn('whitespace-pre-wrap break-words text-foreground', long && !open && 'line-clamp-3')}>{summary}</p>
          {long && (
            <Button type="button" variant="ghost" size="sm" className="min-h-11 px-2 text-primary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? 'Show less' : 'Show more'}
            </Button>
          )}
        </>
      )}
    </div>
  )
}

export function StudioChat({ turns, conversation, onReloadConversation, current, drafts, onSend, onStop, onDecide, onAnswer, onDecideMemory, saveAvailable = false, release, composerRef }: StudioChatProps) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // The text a daily limit refused. Sending it again can't work until the draft changes.
  const [limitedDraft, setLimitedDraft] = useState<string | null>(null)
  // `fromBox`: the text came from the chat box, so a successful send clears it.
  const [replace, setReplace] = useState<{ runId: string; text: string; fromBox: boolean } | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const hintId = useId()
  // Follow new messages only while the professor is reading the bottom of the log.
  const pinned = useRef(true)
  const progress = current?.progress ?? null
  const working = !!progress && (progress.status === 'queued' || progress.status === 'running')
  const active = !!progress && (ACTIVE_STATUSES as readonly string[]).includes(progress.status)
  // While Athena waits on a question, the chat box answers it rather than starting over.
  const answering = !!progress?.question

  // "Jump to latest" shows when something new arrived while the professor reads further up.
  const contentKey = `${turns.length}:${current?.events.length ?? 0}:${progress?.status ?? ''}`
  const [atBottom, setAtBottom] = useState(true)
  const [seenKey, setSeenKey] = useState(contentKey)
  if (atBottom && seenKey !== contentKey) setSeenKey(contentKey)

  useEffect(() => {
    if (pinned.current) end.current?.scrollIntoView({ block: 'end' })
  }, [turns.length, current?.events.length, progress?.status])
  const currentRequest = current ? (turns.find((t) => t.runId === current.runId)?.request ?? null) : null

  const stop = async () => {
    setStopping(true)
    await onStop()
    setStopping(false)
  }

  const send = async (text: string, replaceRunId?: string, fromBox = true) => {
    pinned.current = true
    setSending(true)
    setNotice(null)
    if (answering && !replaceRunId) {
      const failure = await onAnswer(text)
      setSending(false)
      if (failure) setNotice(failure)
      else setDraft('')
      return
    }
    const r = await onSend(text, replaceRunId)
    setSending(false)
    if (r?.waitingRunId) {
      setReplace({ runId: r.waitingRunId, text, fromBox })
      return
    }
    if (r?.error) {
      setNotice(r.error)
      if (/try again tomorrow/i.test(r.error)) setLimitedDraft(text)
      return
    }
    setReplace(null)
    if (fromBox) setDraft('')
  }
  const submit = () => {
    const text = draft.trim()
    if (text && !sending && !working && !(notice && limitedDraft === text)) void send(text)
  }
  // Puts the request back in the box to reword it. Never overwrites what the professor typed.
  const editRequest = currentRequest
    ? () => {
        setDraft((d) => (d.trim() ? d : currentRequest))
        composerRef?.current?.focus()
      }
    : undefined

  const placeholder = working
    ? 'Athena is working. You can type your next change.'
    : answering
      ? 'Type your answer to Athena'
      : progress?.approval
        ? 'Or describe a different request'
        : 'Describe what to add or change'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={log}
          className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          role="log"
          aria-label="Conversation with Athena"
          // Focusable, so a keyboard user can scroll a long conversation.
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_PX
            pinned.current = near
            setAtBottom(near)
          }}
        >
          {conversation === 'failed' && (
            <div className="space-y-2 rounded-2xl bg-muted p-4 text-sm">
              <p>Couldn’t load your earlier messages for this tool.</p>
              <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={onReloadConversation}>
                Try again
              </Button>
            </div>
          )}
          {conversation === 'loading' && turns.length === 0 && <Skeleton className="ml-10 h-11 rounded-2xl" />}
          {conversation === 'ready' && turns.length === 0 && !current && (
            <div className="mx-auto flex max-w-xs flex-col items-center gap-3 py-16 text-center">
              <span className="flex size-10 items-center justify-center rounded-xl bg-accent text-primary">
                <Sparkles className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="font-display text-sm font-semibold text-ink">Nothing built yet</p>
              <p className="text-sm text-muted-foreground">Describe what this tool should do in the box below, and Athena builds a first draft.</p>
            </div>
          )}
          {turns.map((t) => (
            <div key={t.runId} className="space-y-3">
              <div className="ml-10 flex flex-col items-end gap-1">
                <div className="w-fit max-w-full whitespace-pre-wrap break-words rounded-2xl bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground">{t.request}</div>
                <time dateTime={t.createdAt} className="pr-1 text-xs text-muted-foreground">
                  {sentLabel(t.createdAt)}
                </time>
              </div>
              {t.runId !== current?.runId && (t.ending || t.summary) && <PastReply turn={t} entry={drafts?.find((e) => e.runId === t.runId)} />}
            </div>
          ))}

          {current && (
            <div key={current.runId} className="space-y-3">
              {progress?.plan && <PlanCard plan={progress.plan} notBuilt={!active && ENDED_UNBUILT.includes(progress.status)} />}
              {(!progress || active) && (
                <ProgressLines events={current.events} loaded={!!progress} unreachable={current.unreachable} working={working} phase={progress?.phase ?? null} queuedMs={progress?.queuedMs ?? null} />
              )}
              {progress?.approval && <ApprovalCard approval={progress.approval} onDecide={onDecide} />}
              {progress?.question && <QuestionCard question={progress.question} />}
              {active && !working && (
                <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={stop} disabled={stopping}>
                  {stopping ? 'Stopping…' : 'Stop this request'}
                </Button>
              )}
              {progress && !active && (
                <EndingCard
                  progress={progress}
                  saveAvailable={saveAvailable}
                  onDecideMemory={onDecideMemory}
                  onRetry={currentRequest ? () => void send(currentRequest, undefined, false) : undefined}
                  retrying={sending}
                  onEdit={editRequest}
                />
              )}
              {/* The steps stay, closed, under how the run ended. */}
              {progress && !active && <RunTimeline events={current.events} />}
            </div>
          )}
          {release}
          <div ref={end} />
        </div>
        {!atBottom && contentKey !== seenKey && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="absolute bottom-3 left-1/2 min-h-11 -translate-x-1/2 gap-1.5 rounded-full shadow-raised"
            onClick={() => {
              pinned.current = true
              end.current?.scrollIntoView({ block: 'end' })
              // The pill goes away once at the bottom: keep focus in the conversation.
              log.current?.focus({ preventScroll: true })
            }}
          >
            <ArrowDown className="h-4 w-4" aria-hidden="true" />
            Jump to latest
          </Button>
        )}
      </div>

      <form
        className="shrink-0 space-y-2 px-4 pt-2 pb-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {replace && (
          <div role="alert" className="space-y-2 rounded-2xl bg-warning-muted p-3 text-sm text-warning-muted-foreground">
            <p>Your last request is waiting for you. Replace it with this one? Nothing from the waiting request is kept.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" className="min-h-11" onClick={() => setReplace(null)}>
                Keep it
              </Button>
              <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={sending} onClick={() => void send(replace.text, replace.runId, replace.fromBox)}>
                Replace it
              </Button>
            </div>
          </div>
        )}
        {notice && (
          <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {notice}
          </p>
        )}
        {answering && (
          <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
            <CornerDownRight className="h-3.5 w-3.5" aria-hidden="true" />
            Answering Athena’s question
          </p>
        )}
        <div
          className={cn(
            'rounded-2xl border border-input bg-card shadow-card transition-[border-color,box-shadow] duration-200 focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/15',
            answering && 'border-primary ring-4 ring-primary/15',
          )}
        >
          <Textarea
            ref={composerRef}
            aria-label={answering ? 'Your answer to Athena' : 'Describe a change'}
            aria-describedby={hintId}
            placeholder={placeholder}
            rows={2}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setNotice(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.repeat) {
                e.preventDefault()
                submit()
              }
            }}
            className="max-h-48 min-h-11 resize-none border-0 bg-transparent px-3 pt-3 text-sm shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <p id={hintId} className="text-xs text-muted-foreground">
              {working ? 'You can send this once Athena finishes.' : 'Enter to send · Shift+Enter for a new line'}
            </p>
            {working ? (
              // A labelled Stop beside a disabled Send: a click in the send spot never stops a build.
              <div className="flex shrink-0 items-center gap-2">
                <Button type="button" variant="outline" className="min-h-11 gap-2 rounded-xl" onClick={stop} disabled={stopping}>
                  <Square className="h-4 w-4" aria-hidden="true" />
                  {stopping ? 'Stopping…' : 'Stop'}
                </Button>
                {draft.trim() && (
                  <Button type="button" size="icon" variant="secondary" className="h-11 w-11 shrink-0 rounded-xl" disabled aria-label="Send">
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </Button>
                )}
              </div>
            ) : (
              <Button
                type="submit"
                size="icon"
                variant={draft.trim() ? 'default' : 'secondary'}
                className="h-11 w-11 shrink-0 rounded-xl"
                disabled={sending || !draft.trim() || (!!notice && limitedDraft === draft.trim())}
                aria-label={answering ? 'Send answer' : 'Send'}
              >
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}
