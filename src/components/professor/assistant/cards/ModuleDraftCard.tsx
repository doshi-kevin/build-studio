'use client'

import { useState } from 'react'
import { LayoutList, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { CardShell, type DraftToolOutput } from './CardShell'
import { approveModuleDraft } from '../actions'
import type { ModuleDraft } from '@/lib/ai/professor-assistant/schemas'

type Item = ModuleDraft['items'][number]

export function ModuleDraftCard({
  input,
  sectionId,
  onResolve,
}: {
  input: ModuleDraft
  sectionId: string
  onResolve: (output: DraftToolOutput) => void
}) {
  const [title, setTitle] = useState(input.title)
  const [description, setDescription] = useState(input.description ?? '')
  const [items, setItems] = useState<Item[]>(input.items ?? [])
  const [submitting, setSubmitting] = useState(false)

  const patchItem = (i: number, patch: Partial<Item>) =>
    setItems((its) => its.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  const removeItem = (i: number) => setItems((its) => its.filter((_, idx) => idx !== i))

  const handleApprove = async () => {
    setSubmitting(true)
    const res = await approveModuleDraft(sectionId, {
      title: title.trim(),
      description: description.trim() || undefined,
      weekNumber: input.weekNumber,
      items: items.map((it) => ({ title: it.title.trim(), description: it.description?.trim() || undefined })),
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
      icon={LayoutList}
      title="Draft module outline"
      approveLabel="Create unpublished module"
      submitting={submitting}
      approveDisabled={!title.trim()}
      onApprove={handleApprove}
      onDiscard={() => onResolve({ approved: false })}
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Module title" className="font-medium" />
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        placeholder="Module description (optional)"
        className="resize-none text-sm"
      />

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {items.length} outline item{items.length === 1 ? '' : 's'}
        </p>
        {items.map((it, i) => (
          <div key={i} className="flex items-start gap-2 rounded-xl border border-border bg-background p-2.5">
            <span className="mt-2 text-xs font-semibold text-muted-foreground tabular-nums">{i + 1}</span>
            <div className="flex-1 space-y-1.5">
              <Input
                value={it.title}
                onChange={(e) => patchItem(i, { title: e.target.value })}
                placeholder="Item title"
                className="h-8 text-sm font-medium"
              />
              <Textarea
                value={it.description ?? ''}
                onChange={(e) => patchItem(i, { description: e.target.value })}
                rows={2}
                placeholder="Talking points (optional)"
                className="resize-none text-sm"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeItem(i)}
              aria-label="Remove item"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </CardShell>
  )
}
