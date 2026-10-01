// Student-facing Q&A list. Shows everyone's questions sorted by upvotes,
// lets the student upvote (idempotent server-side). Visual layer only.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronUp, MessageCircle, Check, Loader2, EyeOff, User, GraduationCap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { upvoteQuestion } from '@/lib/live-classroom/interactions/actions'
import type { SnapshotInteraction } from '@/lib/live-classroom/snapshot'
import { SPRING } from '@/lib/motion'

interface Props {
  questions: SnapshotInteraction[]
  currentUserId: string
}

export function QuestionList({ questions, currentUserId }: Props) {
  return (
    <TooltipProvider delayDuration={250}>
      <section className="rounded-3xl ring-1 ring-border/50 shadow-sm bg-background overflow-hidden">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <MessageCircle className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
              Questions
            </h3>
            {questions.length > 0 && (
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                {questions.length}
              </span>
            )}
          </div>
          {questions.length > 0 && (
            <span className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
              By upvotes
            </span>
          )}
        </header>
        <div className="p-4">
          {questions.length === 0 ? (
            <div className="flex flex-col items-center text-center py-10 px-4 rounded-2xl border border-dashed border-border bg-muted/10">
              <div className="rounded-full bg-background border border-border p-3 mb-3">
                <ChevronUp className="h-5 w-5 text-muted-foreground" strokeWidth={2.5} />
              </div>
              <p className="text-sm font-medium mb-1">Be the first to ask</p>
              <p className="text-xs text-muted-foreground max-w-[260px] leading-relaxed">
                Questions from the room will show up here. Upvote the ones you want answered most so they rise to the top.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <AnimatePresence initial={false}>
                {questions.map((q) => (
                  <QuestionRow key={q.id} question={q} currentUserId={currentUserId} />
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </section>
    </TooltipProvider>
  )
}

function QuestionRow({
  question,
  currentUserId,
}: {
  question: SnapshotInteraction
  currentUserId: string
}) {
  const [pending, setPending] = useState(false)
  const text = (question.payload.text as string | undefined) ?? ''
  const upvotes = (question.payload.upvotes as number | undefined) ?? 0
  const upvotedBy = (question.payload.upvotedBy as string[] | undefined) ?? []
  // A question counts as "answered" if either the payload says so OR the
  // interaction's status flipped to 'closed' — both signals can arrive
  // independently because the DB trigger only fans out one event per UPDATE.
  const answered =
    ((question.payload.answered as boolean | undefined) ?? false) || question.status === 'closed'
  const anonymous = (question.payload.anonymous as boolean | undefined) ?? false
  const authorName = question.payload.authorName as string | undefined
  // The instructor's written answer, if they replied instead of (or as well as)
  // answering aloud. Arrives live via the room broadcast.
  const reply = (question.payload.reply as string | undefined) ?? ''
  const replyAuthorName = (question.payload.replyAuthorName as string | undefined) ?? 'Instructor'
  const isMine = question.created_by === currentUserId
  const hasUpvoted = upvotedBy.includes(currentUserId)

  const handleUpvote = async () => {
    if (hasUpvoted || pending) return
    setPending(true)
    try {
      const result = await upvoteQuestion({ interactionId: question.id })
      if (result.error) toast.error(result.error)
    } finally {
      setPending(false)
    }
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={SPRING}
      className={`group rounded-2xl border p-3 transition-colors ${
        answered && !reply
          ? 'border-border bg-muted/20 opacity-60'
          : 'border-border bg-background hover:border-foreground/25'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Upvote pill — Slido-style */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleUpvote}
              disabled={hasUpvoted || pending || answered}
              className={`flex flex-col items-center justify-center min-w-[44px] py-1.5 rounded-xl border transition-colors duration-200 ease-out ${
                hasUpvoted
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background hover:border-foreground/50 disabled:opacity-50'
              }`}
              aria-label={hasUpvoted ? 'You upvoted this' : 'Upvote'}
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ChevronUp className="h-4 w-4" strokeWidth={2.5} />
              )}
              <span className="text-xs font-semibold tabular-nums leading-tight">
                {upvotes}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {hasUpvoted ? 'You upvoted this' : answered ? 'Answered' : 'Upvote'}
          </TooltipContent>
        </Tooltip>

        {/* Body */}
        <div className="flex-1 min-w-0">
          {/* A replied question keeps its full-strength styling — the written
              answer below is the resolution signal, and striking the question
              through would bury the thing students actually want to read. */}
          <p className={`text-sm break-words leading-snug ${answered && !reply ? 'line-through text-muted-foreground' : ''}`}>
            {text}
          </p>
          {/* Author attribution + answered badge in a single tidy row */}
          <div className="flex items-center justify-between gap-2 mt-1.5">
            <div className="flex items-center gap-1.5 text-xs min-w-0">
              {anonymous ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-muted-foreground">
                      <EyeOff className="h-2.5 w-2.5" aria-hidden />
                      Anonymous
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">Asker chose to stay anonymous</TooltipContent>
                </Tooltip>
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground min-w-0">
                  <User className="h-2.5 w-2.5 shrink-0" aria-hidden />
                  <span className="truncate max-w-[140px]">
                    {isMine ? 'You' : (authorName ?? 'A student')}
                  </span>
                </span>
              )}
            </div>
            {answered && (
              <Badge variant="outline" className="text-xs gap-1 rounded-full border-border shrink-0">
                <Check className="h-2.5 w-2.5" />
                Answered
              </Badge>
            )}
          </div>

          {/* Instructor's written answer */}
          {reply && (
            <div className="mt-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
              <p className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
                <GraduationCap className="h-2.5 w-2.5" aria-hidden />
                {replyAuthorName} replied
              </p>
              <p className="text-[13px] break-words leading-snug mt-1 whitespace-pre-wrap">{reply}</p>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}
