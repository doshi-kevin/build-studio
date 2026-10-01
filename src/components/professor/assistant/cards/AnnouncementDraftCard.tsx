'use client'

import { useState } from 'react'
import { Megaphone } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { CardShell, type DraftToolOutput } from './CardShell'
import { MarkdownField } from './MarkdownField'
import { approveAnnouncementDraft } from '../actions'
import type { AnnouncementDraft } from '@/lib/ai/professor-assistant/schemas'

export function AnnouncementDraftCard({
  input,
  sectionId,
  onResolve,
}: {
  input: AnnouncementDraft
  sectionId: string
  onResolve: (output: DraftToolOutput) => void
}) {
  const [title, setTitle] = useState(input.title)
  const [content, setContent] = useState(input.content)
  const [submitting, setSubmitting] = useState(false)

  const handleApprove = async () => {
    setSubmitting(true)
    const res = await approveAnnouncementDraft(sectionId, { title: title.trim(), content: content.trim() })
    setSubmitting(false)
    if (res.error) {
      toast.error(res.error)
      return
    }
    onResolve({ approved: true, note: res.note, href: res.href })
  }

  return (
    <CardShell
      icon={Megaphone}
      title="Draft announcement"
      approveLabel="Save as draft"
      submitting={submitting}
      approveDisabled={!title.trim() || !content.trim()}
      onApprove={handleApprove}
      onDiscard={() => onResolve({ approved: false })}
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Announcement title" className="font-medium" />
      <MarkdownField value={content} onChange={setContent} rows={6} placeholder="Announcement body" />
    </CardShell>
  )
}
