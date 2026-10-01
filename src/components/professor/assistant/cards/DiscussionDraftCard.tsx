'use client'

import { useEffect, useState } from 'react'
import { MessagesSquare, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CardShell, type DraftToolOutput } from './CardShell'
import { approveDiscussionDraft, getAssistantChannels } from '../actions'
import type { DiscussionDraft } from '@/lib/ai/professor-assistant/schemas'

export function DiscussionDraftCard({
  input,
  sectionId,
  onResolve,
}: {
  input: DiscussionDraft
  sectionId: string
  onResolve: (output: DraftToolOutput) => void
}) {
  const [title, setTitle] = useState(input.title)
  const [prompt, setPrompt] = useState(input.prompt ?? '')
  const [questions, setQuestions] = useState<string[]>(input.questions)
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([])
  const [channelId, setChannelId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

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

  const patch = (i: number, value: string) => setQuestions((qs) => qs.map((q, idx) => (idx === i ? value : q)))
  const remove = (i: number) => setQuestions((qs) => qs.filter((_, idx) => idx !== i))

  const handleApprove = async () => {
    setSubmitting(true)
    const res = await approveDiscussionDraft(sectionId, channelId, {
      title: title.trim(),
      prompt: prompt.trim() || undefined,
      questions: questions.map((q) => q.trim()).filter(Boolean),
    })
    setSubmitting(false)
    if (res.error) {
      toast.error(res.error)
      return
    }
    onResolve({ approved: true, note: res.note, href: res.href })
  }

  const liveQuestions = questions.filter((q) => q.trim()).length

  return (
    <CardShell
      icon={MessagesSquare}
      title="Draft discussion"
      approveLabel="Post discussion"
      submitting={submitting}
      approveDisabled={!title.trim() || liveQuestions === 0 || !channelId}
      onApprove={handleApprove}
      onDiscard={() => onResolve({ approved: false })}
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Discussion title" className="font-medium" />
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Framing / intro (optional)"
        rows={2}
        className="resize-none text-sm"
      />

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {liveQuestions} open question{liveQuestions === 1 ? '' : 's'} · ungraded, no answer key
        </p>
        {questions.map((q, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="mt-2.5 text-xs font-semibold text-muted-foreground tabular-nums">{i + 1}</span>
            <Textarea
              value={q}
              onChange={(e) => patch(i, e.target.value)}
              rows={2}
              className="flex-1 resize-none text-sm"
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => remove(i)}
              aria-label="Remove question"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
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
          <span className="text-xs text-muted-foreground">No discussion channels yet — create one first.</span>
        )}
      </div>
    </CardShell>
  )
}
