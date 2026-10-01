'use client'

import { useEffect, useState } from 'react'
import { ClipboardList } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CardShell, type DraftToolOutput } from './CardShell'
import { approveRubricDraft, getAssistantRubricTargets } from '../actions'
import type { RubricDraft } from '@/lib/ai/professor-assistant/schemas'

type Target = { id: string; title: string }

export function RubricDraftCard({
  input,
  sectionId,
  onResolve,
}: {
  input: RubricDraft
  sectionId: string
  onResolve: (output: DraftToolOutput) => void
}) {
  const [title, setTitle] = useState(input.title)
  const [targets, setTargets] = useState<Target[]>([])
  const [selected, setSelected] = useState<string>('') // project id
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let active = true
    getAssistantRubricTargets(sectionId).then((res) => {
      if (!active) return
      setTargets(res.data)
      if (res.data.length > 0) setSelected(res.data[0].id)
    })
    return () => {
      active = false
    }
  }, [sectionId])

  const handleApprove = async () => {
    setSubmitting(true)
    const res = await approveRubricDraft(sectionId, selected, { title: title.trim(), criteria: input.criteria })
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
      title="Draft rubric"
      approveLabel="Attach rubric"
      submitting={submitting}
      approveDisabled={!title.trim() || !selected}
      onApprove={handleApprove}
      onDiscard={() => onResolve({ approved: false })}
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Rubric title" className="font-medium" />

      <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3">
        {input.criteria.map((c, i) => (
          <div key={i} className="text-sm">
            <p className="font-medium text-foreground">{c.name}</p>
            {c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}
            <ul className="mt-1 space-y-0.5">
              {c.levels.map((lvl, j) => (
                <li key={j} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{lvl.label}</span> ({lvl.points} pts) — {lvl.description}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Attach to project</span>
        {targets.length > 0 ? (
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger className="h-8 flex-1 text-sm">
              <SelectValue placeholder="Choose a project" />
            </SelectTrigger>
            <SelectContent>
              {targets.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-xs text-muted-foreground">No projects yet — create one first.</span>
        )}
      </div>
    </CardShell>
  )
}
