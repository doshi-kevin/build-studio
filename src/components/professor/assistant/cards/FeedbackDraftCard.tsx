'use client'

import { useEffect, useState } from 'react'
import { MessageSquareHeart, Copy, Check } from 'lucide-react'
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
import { approveFeedbackDraft, getAssistantChannels } from '../actions'
import type { FeedbackDraft } from '@/lib/ai/professor-assistant/schemas'

export function FeedbackDraftCard({
  input,
  sectionId,
  onResolve,
}: {
  input: FeedbackDraft
  sectionId: string
  onResolve: (output: DraftToolOutput) => void
}) {
  const [feedback, setFeedback] = useState(input.feedback)
  const studentName = input.studentName?.trim() ?? ''
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
      await navigator.clipboard.writeText(feedback)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Failed to copy')
    }
  }

  const handleApprove = async () => {
    setSubmitting(true)
    const res = await approveFeedbackDraft(sectionId, channelId, { feedback: feedback.trim(), studentName: studentName || undefined })
    setSubmitting(false)
    if (res.error) {
      toast.error(res.error)
      return
    }
    onResolve({ approved: true, note: res.note, href: res.href })
  }

  return (
    <CardShell
      icon={MessageSquareHeart}
      title={studentName ? `Draft feedback · ${studentName}` : 'Draft feedback'}
      approveLabel="Post feedback"
      submitting={submitting}
      approveDisabled={!feedback.trim() || !channelId}
      onApprove={handleApprove}
      onDiscard={() => onResolve({ approved: false })}
    >
      <div className="relative">
        <Textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={5}
          placeholder="Qualitative feedback (no grade)"
          className="resize-none pr-9 text-sm leading-relaxed"
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={handleCopy}
          aria-label="Copy feedback"
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
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
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
