'use client'

import { useState } from 'react'
import { ClipboardList } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { CardShell, type DraftToolOutput } from './CardShell'
import { MarkdownField } from './MarkdownField'
import { approveAssignmentDraft } from '../actions'
import type { AssignmentDraft } from '@/lib/ai/professor-assistant/schemas'
import { FILE_TYPE_KINDS, type FileTypeKind } from '@/lib/validations/assignment'

export function AssignmentDraftCard({
  input,
  sectionId,
  onResolve,
}: {
  input: AssignmentDraft
  sectionId: string
  onResolve: (output: DraftToolOutput) => void
}) {
  const [title, setTitle] = useState(input.title)
  const [instructions, setInstructions] = useState(input.instructions ?? '')
  const [points, setPoints] = useState(input.points ?? 100)
  const [dueDate, setDueDate] = useState(input.dueDate ?? '')
  const [fileTypes, setFileTypes] = useState<FileTypeKind[]>(input.fileTypes ?? [])
  const [submitting, setSubmitting] = useState(false)

  const toggleType = (kind: FileTypeKind) =>
    setFileTypes((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))

  const handleApprove = async () => {
    setSubmitting(true)
    const res = await approveAssignmentDraft(sectionId, {
      title: title.trim(),
      instructions: instructions.trim(),
      points,
      dueDate: dueDate || undefined,
      fileTypes,
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
      icon={ClipboardList}
      title="Draft assignment"
      approveLabel="Create assignment"
      submitting={submitting}
      approveDisabled={!title.trim()}
      onApprove={handleApprove}
      onDiscard={() => onResolve({ approved: false })}
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Assignment title" className="font-medium" />
      <MarkdownField
        label="Instructions"
        value={instructions}
        onChange={setInstructions}
        rows={6}
        placeholder="What students must do — the prompt shown to students"
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Points
          <Input
            type="number"
            min={0}
            max={1000}
            value={points}
            onChange={(e) => setPoints(Math.min(1000, Math.max(0, Number(e.target.value) || 0)))}
            className="h-9 w-24 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Due date
          <Input
            type="date"
            value={dueDate}
            min={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDueDate(e.target.value)}
            className="h-9 w-44 text-sm"
          />
        </label>
      </div>
      <div className="space-y-1.5">
        <span id="assignment-file-types-label" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Accepted file types
        </span>
        <div role="group" aria-labelledby="assignment-file-types-label" className="flex flex-wrap gap-2">
          {FILE_TYPE_KINDS.map((k) => {
            const active = fileTypes.includes(k.kind)
            return (
              <button
                key={k.kind}
                type="button"
                aria-pressed={active}
                onClick={() => toggleType(k.kind)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  active
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted',
                )}
              >
                {k.label}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {fileTypes.length ? 'Students upload files.' : 'Students submit in a text box (no file upload).'}
        </p>
      </div>
    </CardShell>
  )
}
