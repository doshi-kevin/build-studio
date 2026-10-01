'use client'

import { useEffect, useState } from 'react'
import { MessageSquareReply, Copy, Check, Quote } from 'lucide-react'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CardShell, type DraftToolOutput } from './CardShell'
import { approveReplyDraft, getAssistantChannels } from '../actions'
import type { ReplyDraft } from '@/lib/ai/professor-assistant/schemas'

export function ReplyDraftCard({
  input,
  sectionId,
  onResolve,
}: {
  input: ReplyDraft
  sectionId: string
  onResolve: (output: DraftToolOutput) => void
}) {
  const [reply, setReply] = useState(input.reply)
  // The student's message is CONTEXT only (never posted) and not something the
  // professor would edit — so it's read-only. Present only for a genuine reply;
  // proactive outreach (check-ins) leaves it empty, and we show nothing.
  const studentQuestion = input.studentQuestion?.trim() ?? ''
  const isReply = studentQuestion.length > 0
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([])
  const [channelId, setChannelId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    getAssistantChannels(sectionId).then((res) => {
      if (!active) return
      setChannels(res.data)
      if (res.data.length > 0) setChannelId(res.data[0].id)
    })
    return () => {
      active = false
    }
  }, [sectionId])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(reply)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Failed to copy')
    }
  }

  const handleApprove = async () => {
    setSubmitting(true)
    const res = await approveReplyDraft(sectionId, channelId, { reply: reply.trim(), studentQuestion: studentQuestion || undefined })
    setSubmitting(false)
    if (res.error) {
      toast.error(res.error)
      return
    }
    onResolve({ approved: true, note: res.note, href: res.href })
  }

  return (
    <CardShell
      icon={MessageSquareReply}
      title={isReply ? 'Draft reply' : 'Draft message'}
      approveLabel={isReply ? 'Post reply' : 'Post message'}
      submitting={submitting}
      approveDisabled={!reply.trim() || !channelId}
      onApprove={handleApprove}
      onDiscard={() => onResolve({ approved: false })}
    >
      {/* Read-only quote of the student's message being answered — context only,
          never posted, and not editable (you don't change a student's words).
          Shown ONLY for a genuine reply; proactive outreach has nothing to quote. */}
      {isReply && (
        <blockquote className="flex gap-2 rounded-xl border-l-2 border-primary/40 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/60" />
          <p className="line-clamp-4 leading-relaxed">{studentQuestion}</p>
        </blockquote>
      )}

      <div className="relative">
        <Textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          rows={5}
          placeholder="Your reply"
          className="resize-none pr-9 text-sm leading-relaxed"
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={handleCopy}
          aria-label="Copy reply"
          className="absolute right-1.5 top-1.5 h-7 w-7 text-muted-foreground hover:text-foreground"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Post to</span>
        {channels.length > 0 ? (
          <Select value={channelId} onValueChange={setChannelId}>
            <SelectTrigger className="h-8 flex-1 text-sm">
              <SelectValue placeholder="Choose a channel" />
            </SelectTrigger>
            <SelectContent>
              {channels.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-xs text-muted-foreground">No discussion channels yet — use Copy instead.</span>
        )}
      </div>
    </CardShell>
  )
}
