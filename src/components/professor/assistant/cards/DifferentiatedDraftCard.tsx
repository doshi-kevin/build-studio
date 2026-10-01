'use client'

import { useState } from 'react'
import { Layers } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { CardShell, type DraftToolOutput } from './CardShell'
import { MarkdownField } from './MarkdownField'
import { approveDifferentiatedDraft } from '../actions'
import type { DifferentiatedDraft } from '@/lib/ai/professor-assistant/schemas'

const VARIANT_LABELS: Record<NonNullable<DifferentiatedDraft['variant']>, string> = {
  simplified: 'Simplified',
  ell: 'Multilingual / ESL',
  advanced: 'Advanced',
}

export function DifferentiatedDraftCard({
  input,
  sectionId,
  onResolve,
}: {
  input: DifferentiatedDraft
  sectionId: string
  onResolve: (output: DraftToolOutput) => void
}) {
  const [title, setTitle] = useState(input.title)
  const [content, setContent] = useState(input.content)
  const [submitting, setSubmitting] = useState(false)

  const handleApprove = async () => {
    setSubmitting(true)
    const res = await approveDifferentiatedDraft(sectionId, {
      title: title.trim(),
      content: content.trim(),
      variant: input.variant,
    })
    setSubmitting(false)
    if (res.error) {
      toast.error(res.error)
      return
    }
    onResolve({ approved: true, note: res.note, href: res.href })
  }

  return (
    <CardShell
      icon={Layers}
      title="Draft alternate version"
      approveLabel="Save as draft"
      submitting={submitting}
      approveDisabled={!title.trim() || !content.trim()}
      onApprove={handleApprove}
      onDiscard={() => onResolve({ approved: false })}
    >
      {input.variant && (
        <span className="inline-flex w-fit rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
          {VARIANT_LABELS[input.variant]}
        </span>
      )}
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="font-medium" />
      <MarkdownField value={content} onChange={setContent} rows={7} placeholder="Rewritten content" />
    </CardShell>
  )
}
