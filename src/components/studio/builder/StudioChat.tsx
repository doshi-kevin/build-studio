'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Bot, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ApprovalCard, EndingCard, ProgressLines, QuestionCard } from './RunCards'
import { ACTIVE_STATUSES, type ConversationTurn, type ProgressRead } from './types'

interface StudioChatProps {
  turns: ConversationTurn[]
  /** Whether `turns` has loaded. A failed load offers a retry instead of an empty chat. */
  conversation: 'loading' | 'ready' | 'failed'
  onReloadConversation: () => void
  /** The run this pane follows, usually the newest. */
  current: { runId: string; progress: ProgressRead | null; events: ProgressRead['events']; unreachable: boolean } | null
  /** Send a request. Resolves to a refusal message, or a waiting run the professor must confirm replacing. */
  onSend: (text: string, replaceRunId?: string) => Promise<{ error?: string; waitingRunId?: string } | null>
  onStop: () => Promise<void>
  onDecide: (approve: boolean) => Promise<string | null>
  onAnswer: (answer: string) => Promise<string | null>
  onPreview: () => void
  onSave: () => Promise<{ ok: boolean; message: string }>
  /** Approve or skip a decision Athena suggests remembering. Resolves to a message when it failed. */
  onDecideMemory: (memoryId: string, approve: boolean) => Promise<string | null>
  canSave: boolean
  /** Save would keep the current draft, not the one this build made (it was undone). */
  savesOtherDraft?: boolean
}

function Athena({ children }: { children: React.ReactNode }) {
  return (
    <div className="mr-4 flex gap-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
        <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 space-y-2 text-sm">{children}</div>
    </div>
  )
}

/** Within this many pixels of the bottom, new messages keep the log scrolled down. */
const PINNED_PX = 96

export function StudioChat({ turns, conversation, onReloadConversation, current, onSend, onStop, onDecide, onAnswer, onPreview, onSave, onDecideMemory, canSave, savesOtherDraft = false }: StudioChatProps) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // `fromBox`: the text came from the chat box, so a successful send clears it.
  const [replace, setReplace] = useState<{ runId: string; text: string; fromBox: boolean } | null>(null)
  const end = useRef<HTMLDivElement>(null)
  // Follow new messages only while the professor is reading the bottom of the log.
  const pinned = useRef(true)
  const progress = current?.progress ?? null
  const working = !!progress && (progress.status === 'queued' || progress.status === 'running')
  const active = !!progress && (ACTIVE_STATUSES as readonly string[]).includes(progress.status)
  // While Athena waits on a question, the chat box answers it rather than starting over.
  const answering = !!progress?.question

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
      return
    }
    setReplace(null)
    if (fromBox) setDraft('')
  }
  const submit = () => {
    const text = draft.trim()
    if (text && !sending && !working) void send(text)
  }

  const placeholder = working
    ? 'Athena is working on your last request'
    : answering
      ? 'Type your answer to Athena'
      : progress?.approval
        ? 'Approve, or choose Build without this, above. Or describe a different request'
        : 'Describe what to add or change'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        role="log"
        aria-label="Conversation with Athena"
        // Focusable, so a keyboard user can scroll a long conversation.
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_PX
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
        {conversation === 'loading' && turns.length === 0 && <Skeleton className="ml-8 h-11 rounded-2xl" />}
        {conversation === 'ready' && turns.length === 0 && !current && (
          <EmptyState icon={MessageSquare} title="Nothing built yet" description="Describe what this tool should do in the box below, and Athena builds a first draft." />
        )}
        {turns.map((t) => (
          <div key={t.runId} className="space-y-3">
            <div className="ml-8 whitespace-pre-wrap rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">{t.request}</div>
            {t.runId !== current?.runId && (t.ending || t.summary) && (
              <Athena>
                {t.ending && <p className="rounded-2xl bg-muted px-4 py-2.5">{t.ending}</p>}
                {t.summary && <p className="whitespace-pre-wrap px-1 text-muted-foreground">{t.summary}</p>}
              </Athena>
            )}
          </div>
        ))}

        {current && (
          <Athena>
            {(!progress || active) && (
              <ProgressLines events={current.events} loaded={!!progress} unreachable={current.unreachable} working={working} stopping={stopping} onStop={stop} />
            )}
            {progress?.approval && <ApprovalCard approval={progress.approval} onDecide={onDecide} />}
            {progress?.question && <QuestionCard question={progress.question} />}
            {active && !working && (
              <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={stop} disabled={stopping}>
                {stopping ? 'Cancelling…' : 'Cancel this request'}
              </Button>
            )}
            {progress && !active && (
              <EndingCard
                progress={progress}
                canSave={canSave}
                savesOtherDraft={savesOtherDraft}
                onPreview={onPreview}
                onSave={onSave}
                onDecideMemory={onDecideMemory}
                onRetry={currentRequest ? () => void send(currentRequest, undefined, false) : undefined}
                retrying={sending}
              />
            )}
          </Athena>
        )}
        <div ref={end} />
      </div>

      <form
        className="shrink-0 space-y-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {replace && (
          <div role="alert" className="space-y-2 rounded-2xl bg-muted p-3 text-sm">
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
        {notice && <p role="alert" className="text-sm text-destructive">{notice}</p>}
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
          <Textarea
            aria-label={answering ? 'Your answer to Athena' : 'Describe a change'}
            placeholder={placeholder}
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            className="min-h-0 resize-none border-0 shadow-none focus-visible:ring-0"
          />
          <Button type="submit" size="icon" className="h-11 w-11 shrink-0" disabled={sending || working || !draft.trim()} aria-label={answering ? 'Send answer' : 'Send'}>
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </form>
    </div>
  )
}
