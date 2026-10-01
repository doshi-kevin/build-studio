// Q&A panel for the professor view — shows student questions sorted by
// upvotes, lets the prof answer one in writing or mark it answered aloud.
// Visual layer only.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronUp, Check, MessageCircle, Loader2, EyeOff, User, Reply, Send, GraduationCap, Lightbulb } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { markQuestionAnswered, replyToQuestion } from '@/lib/live-classroom/interactions/actions'
import type { SnapshotInteraction } from '@/lib/live-classroom/snapshot'
import { SPRING } from '@/lib/motion'

/** Matches replyToQuestionSchema — keep the two in step. */
const MAX_REPLY_LEN = 1000

interface Props {
  questions: SnapshotInteraction[]
}

// A question counts as "answered" if either the payload says so OR the
// interaction's status flipped to 'closed' — markQuestionAnswered does both
// but the DB broadcast trigger only fan-outs one of them per UPDATE, so
// either signal can arrive first.
function isAnswered(q: SnapshotInteraction): boolean {
  return ((q.payload.answered as boolean | undefined) ?? false) || q.status === 'closed'
}

export function QuestionPanel({ questions }: Props) {
  const [showAnswered, setShowAnswered] = useState(false)
  const openCount = questions.filter((q) => !isAnswered(q)).length
  const answeredCount = questions.length - openCount
  const visibleQuestions = showAnswered ? questions : questions.filter((q) => !isAnswered(q))

  return (
    <TooltipProvider delayDuration={250}>
      <section className="rounded-3xl ring-1 ring-border/50 shadow-sm bg-background overflow-hidden">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <MessageCircle className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
              Q&amp;A
            </h3>
            {openCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                {openCount}
              </span>
            )}
          </div>
          {answeredCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setShowAnswered((s) => !s)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showAnswered ? (
                    <>Hide answered</>
                  ) : (
                    <>
                      Answered
                      <span className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full bg-muted text-foreground text-xs font-semibold normal-case tracking-normal">
                        {answeredCount}
                      </span>
                    </>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {showAnswered ? 'Hide already-answered questions' : `Show ${answeredCount} answered`}
              </TooltipContent>
            </Tooltip>
          )}
        </header>

        <div className="p-4">
          {questions.length === 0 ? (
            <div className="flex flex-col items-center text-center py-10 px-4 rounded-2xl border border-dashed border-border bg-muted/10">
              <div className="rounded-full bg-background border border-border p-3 mb-3">
                <MessageCircle className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium mb-1">Quiet for now</p>
              <p className="text-xs text-muted-foreground max-w-[260px] leading-relaxed">
                Student questions will land here, ranked by upvotes. Answer aloud and mark them done, or reply in writing when a link or a number does the job.
              </p>
              <div className="mt-4 inline-flex items-center gap-1.5 text-xs uppercase tracking-widest font-semibold text-muted-foreground/70">
                <Lightbulb className="h-3 w-3" />
                Tip — pause for questions every few slides
              </div>
            </div>
          ) : visibleQuestions.length === 0 ? (
            <div className="flex flex-col items-center text-center py-10 px-4 rounded-2xl border border-dashed border-border bg-muted/10">
              <div className="rounded-full bg-background border border-border p-3 mb-3">
                <Check className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium mb-1">All caught up</p>
              <p className="text-xs text-muted-foreground max-w-[240px] leading-relaxed">
                Every question has been marked answered. Toggle &ldquo;Show all&rdquo; to revisit them.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <AnimatePresence initial={false}>
                {visibleQuestions.map((q) => (
                  <QuestionRow key={q.id} question={q} />
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </section>
    </TooltipProvider>
  )
}

function QuestionRow({ question }: { question: SnapshotInteraction }) {
  const [pending, setPending] = useState(false)
  const [composingReply, setComposingReply] = useState(false)
  const [replyDraft, setReplyDraft] = useState('')
  const [replyPending, setReplyPending] = useState(false)
  const text = (question.payload.text as string | undefined) ?? ''
  const upvotes = (question.payload.upvotes as number | undefined) ?? 0
  const answered = isAnswered(question)
  const anonymous = (question.payload.anonymous as boolean | undefined) ?? false
  const authorName = question.payload.authorName as string | undefined
  // The prof's written answer. Arrives back through the room broadcast, so the
  // row re-renders with it — no local echo needed.
  const reply = (question.payload.reply as string | undefined) ?? ''
  const replyAuthorName = (question.payload.replyAuthorName as string | undefined) ?? 'You'

  const handleMarkAnswered = async () => {
    setPending(true)
    try {
      const result = await markQuestionAnswered({ interactionId: question.id })
      if (result.error) toast.error(result.error)
    } finally {
      setPending(false)
    }
  }

  const handleSendReply = async () => {
    const body = replyDraft.trim()
    if (!body || replyPending) return
    setReplyPending(true)
    try {
      const result = await replyToQuestion({ interactionId: question.id, text: body })
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Reply sent to the room')
        setComposingReply(false)
        setReplyDraft('')
      }
    } finally {
      setReplyPending(false)
    }
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={SPRING}
      className={`rounded-2xl border p-3 transition-colors ${
        answered && !reply
          ? 'border-border bg-muted/20 opacity-60'
          : 'border-border bg-background hover:border-foreground/25'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Upvote count column — Slido-style stacked pill */}
        <div
          className={`flex flex-col items-center justify-center min-w-[40px] py-1.5 rounded-xl border ${
            upvotes > 0 ? 'border-foreground/30 bg-muted/40' : 'border-border bg-background'
          }`}
          aria-label={`${upvotes} upvotes`}
        >
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2.5} />
          <span className="text-sm font-semibold tabular-nums leading-none mt-0.5">
            {upvotes}
          </span>
        </div>

        {/* Question text + actions */}
        <div className="flex-1 min-w-0">
          {/* A replied question isn't struck through — the written answer below
              is the resolution signal, and it has to stay readable. */}
          <p className={`text-sm break-words leading-snug ${answered && !reply ? 'line-through text-muted-foreground' : ''}`}>
            {text}
          </p>
          {/* Author attribution — anonymous gets a calm hidden-eye badge,
              named asks get a discreet "— Name" suffix. */}
          <div className="flex items-center gap-1.5 mt-1.5 text-xs">
            {anonymous ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-muted-foreground">
                    <EyeOff className="h-2.5 w-2.5" aria-hidden />
                    Anonymous
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Asker chose to stay anonymous
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <User className="h-2.5 w-2.5" aria-hidden />
                <span className="truncate max-w-[180px]">{authorName ?? 'A student'}</span>
              </span>
            )}
          </div>
          {/* The written answer, once sent — every student in the room sees
              this same text under the question. */}
          {reply && !composingReply && (
            <div className="mt-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
              <p className="inline-flex items-center gap-1 text-xs uppercase tracking-widest font-semibold text-muted-foreground">
                <GraduationCap className="h-2.5 w-2.5" aria-hidden />
                {replyAuthorName} replied
              </p>
              <p className="text-sm break-words leading-snug mt-1 whitespace-pre-wrap">{reply}</p>
            </div>
          )}

          {composingReply ? (
            <div className="mt-2 space-y-2">
              <Textarea
                value={replyDraft}
                onChange={(e) => setReplyDraft(e.target.value.slice(0, MAX_REPLY_LEN))}
                placeholder="Answer in writing — a link, a number, a quick clarification…"
                rows={2}
                maxLength={MAX_REPLY_LEN}
                autoFocus
                aria-label="Your reply"
                className="rounded-xl text-sm resize-none"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setComposingReply(false)
                    setReplyDraft('')
                  }}
                  disabled={replyPending}
                  className="h-7 px-3 text-xs rounded-full border flex-1"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSendReply}
                  disabled={replyPending || replyDraft.trim().length === 0}
                  className="h-7 px-3 text-xs rounded-full flex-1 font-semibold"
                >
                  {replyPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <>
                      <Send className="h-3 w-3 mr-1" />
                      Send reply
                    </>
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-2 mt-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setReplyDraft(reply)
                      setComposingReply(true)
                    }}
                    className="h-7 px-3 text-xs rounded-full text-muted-foreground hover:text-foreground"
                  >
                    <Reply className="h-3 w-3 mr-1" />
                    {reply ? 'Edit reply' : 'Reply'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {reply ? 'Rewrite your written answer' : 'Answer in writing — students see it under the question'}
                </TooltipContent>
              </Tooltip>
              {answered ? (
                <Badge variant="outline" className="text-xs gap-1 rounded-full border-border">
                  <Check className="h-2.5 w-2.5" />
                  Answered
                </Badge>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleMarkAnswered}
                      disabled={pending}
                      className="h-7 px-3 text-xs rounded-full border hover:bg-primary hover:text-primary-foreground hover:border-primary transition-colors"
                    >
                      {pending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          <Check className="h-3 w-3 mr-1" strokeWidth={2.5} />
                          Mark answered
                        </>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Hide from active list</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}
