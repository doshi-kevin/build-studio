'use client'

import { useState } from 'react'
import { Trophy } from 'lucide-react'
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
import { MarkdownField } from './MarkdownField'
import { approveChallengeDraft } from '../actions'
import type { ChallengeDraft } from '@/lib/ai/professor-assistant/schemas'
import {
  CHALLENGE_TYPES,
  CHALLENGE_DIFFICULTIES,
  CHALLENGE_TYPE_LABELS,
  CHALLENGE_DIFFICULTY_LABELS,
} from '@/lib/validations/challenge'

export function ChallengeDraftCard({
  input,
  sectionId,
  onResolve,
}: {
  input: ChallengeDraft
  sectionId: string
  onResolve: (output: DraftToolOutput) => void
}) {
  const [title, setTitle] = useState(input.title)
  const [description, setDescription] = useState(input.description ?? '')
  const [type, setType] = useState(input.type ?? 'general')
  const [difficulty, setDifficulty] = useState(input.difficulty ?? 'medium')
  const [points, setPoints] = useState(input.points ?? 10)
  const [dueDate, setDueDate] = useState(input.dueDate ?? '')
  const [submitting, setSubmitting] = useState(false)

  const handleApprove = async () => {
    setSubmitting(true)
    const res = await approveChallengeDraft(sectionId, {
      title: title.trim(),
      description: description.trim() || undefined,
      type,
      difficulty,
      points,
      bonusPoints: input.bonusPoints ?? 0,
      maxClaims: input.maxClaims,
      dueDate: dueDate || undefined,
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
      icon={Trophy}
      title="Draft challenge"
      approveLabel="Save as draft"
      submitting={submitting}
      approveDisabled={!title.trim()}
      onApprove={handleApprove}
      onDiscard={() => onResolve({ approved: false })}
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Challenge title" className="font-medium" />
      <MarkdownField value={description} onChange={setDescription} rows={4} placeholder="What students must do" />

      <div className="grid grid-cols-2 gap-2">
        <Select value={type} onValueChange={(v) => setType(v as ChallengeDraft['type'])}>
          <SelectTrigger aria-label="Challenge type" className="h-8 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CHALLENGE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>{CHALLENGE_TYPE_LABELS[t]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={difficulty} onValueChange={(v) => setDifficulty(v as ChallengeDraft['difficulty'])}>
          <SelectTrigger aria-label="Difficulty" className="h-8 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CHALLENGE_DIFFICULTIES.map((d) => (
              <SelectItem key={d} value={d}>{CHALLENGE_DIFFICULTY_LABELS[d]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Points
          <Input
            type="number"
            min={0}
            value={points}
            onChange={(e) => setPoints(Number(e.target.value) || 0)}
            className="h-8 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Due
          <Input
            type="date"
            min={new Date().toISOString().slice(0, 10)}
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="h-8 text-sm"
          />
        </label>
      </div>
    </CardShell>
  )
}
