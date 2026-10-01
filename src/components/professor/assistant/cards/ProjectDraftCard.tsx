'use client'

import { useState } from 'react'
import { FolderKanban } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { CardShell, type DraftToolOutput } from './CardShell'
import { MarkdownField } from './MarkdownField'
import { approveProjectDraft } from '../actions'
import type { ProjectDraft } from '@/lib/ai/professor-assistant/schemas'

export function ProjectDraftCard({
  input,
  sectionId,
  onResolve,
}: {
  input: ProjectDraft
  sectionId: string
  onResolve: (output: DraftToolOutput) => void
}) {
  const [title, setTitle] = useState(input.title)
  const [description, setDescription] = useState(input.description ?? '')
  const [guidelines, setGuidelines] = useState(input.guidelines ?? '')
  const [maxTeamSize, setMaxTeamSize] = useState(input.maxTeamSize ?? 5)
  const [dueDate, setDueDate] = useState(input.dueDate ?? '')
  const [allowTeamWorkspace, setAllowTeamWorkspace] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  // The team chat workspace only means something for group projects — an
  // individual project (team size 1) has no teammates to chat with.
  const isGroupProject = maxTeamSize > 1

  const handleApprove = async () => {
    setSubmitting(true)
    const res = await approveProjectDraft(sectionId, {
      title: title.trim(),
      description: description.trim(),
      guidelines: guidelines.trim(),
      maxTeamSize,
      dueDate: dueDate || undefined,
    }, allowTeamWorkspace)
    setSubmitting(false)
    if (res.error) {
      toast.error(res.error)
      return
    }
    onResolve({ approved: true, note: res.note, href: res.href })
  }

  return (
    <CardShell
      icon={FolderKanban}
      title="Draft project"
      approveLabel="Create project"
      submitting={submitting}
      approveDisabled={!title.trim()}
      onApprove={handleApprove}
      onDiscard={() => onResolve({ approved: false })}
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project title" className="font-medium" />
      <MarkdownField
        label="Description"
        value={description}
        onChange={setDescription}
        rows={3}
        placeholder="What the project is about — the brief shown to students"
      />
      <MarkdownField
        label="Guidelines"
        value={guidelines}
        onChange={setGuidelines}
        rows={6}
        placeholder="Deliverables, requirements, milestones, grading expectations"
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Team size
          <Input
            type="number"
            min={1}
            max={20}
            value={maxTeamSize}
            onChange={(e) => setMaxTeamSize(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
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
      {isGroupProject && (
        <div className="flex items-start justify-between gap-3 rounded-xl border p-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Enable team chat workspace</p>
            <p className="text-xs text-muted-foreground">
              Lets each team open a private #chat, #tasks, and #resources channel. Turn off for projects that shouldn&apos;t have chat.
            </p>
          </div>
          <Switch
            checked={allowTeamWorkspace}
            onCheckedChange={setAllowTeamWorkspace}
            aria-label="Enable team chat workspace"
          />
        </div>
      )}
    </CardShell>
  )
}
