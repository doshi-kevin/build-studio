// Project rubric editor: the project's phases are the weighted grade structure.
// Each placed item carries a weight (points), a grain (team = one shared score,
// individual = per student), a scoring mode (numeric = auto-pulled, levels =
// manual pick), and optional levels. Manual + attendance items are created here.
// This replaces the old free-form criteria rubric — the phases ARE the rubric.
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Trash2, FileText, ListChecks, CalendarCheck, PencilLine, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover'
import {
  updatePhaseItemGrading,
  addManualPhaseItem,
} from '@/app/(dashboard)/professor/courses/[sectionId]/projects/actions'
import type { RubricItem, RubricLevel } from '@/lib/projects/grade'

interface Props {
  sectionId: string
  projectId: string
  items: RubricItem[]
  phases: { id: string; name: string }[]
  canWrite: boolean
}

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `lvl-${Math.floor(performance.now() * 1000)}`

const TYPE_ICON = { assignment: FileText, quiz: ListChecks, attendance: CalendarCheck, manual: PencilLine }

export function ProjectRubricTab({ sectionId, projectId, items, phases, canWrite }: Props) {
  const projectTotal = items.reduce((s, i) => s + (Number(i.weight) || 0), 0)
  const byPhase = new Map<string, RubricItem[]>()
  for (const it of items) {
    const key = it.phaseId ?? 'none'
    if (!byPhase.has(key)) byPhase.set(key, [])
    byPhase.get(key)!.push(it)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Grading rubric</h3>
          <p className="text-xs text-muted-foreground">
            Weight each item, choose team or individual, and how it&apos;s scored. Weights are points.
          </p>
        </div>
        <Badge variant="outline" className="tabular-nums">
          Project total {Math.round(projectTotal * 10) / 10} pts
        </Badge>
      </div>

      {phases.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-muted/10 p-8 text-center">
          <p className="text-sm font-medium">No phases yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Add phases on the Phases tab, then weight their items here.</p>
        </div>
      )}

      {phases.map((phase) => {
        const phaseItems = byPhase.get(phase.id) ?? []
        const subtotal = phaseItems.reduce((s, i) => s + (Number(i.weight) || 0), 0)
        return (
          <div key={phase.id} className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-sm font-semibold">{phase.name}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">{Math.round(subtotal * 10) / 10} pts</span>
                {canWrite && <AddManualItem phaseId={phase.id} sectionId={sectionId} projectId={projectId} />}
              </div>
            </div>
            <div className="divide-y divide-border/60">
              {phaseItems.length === 0 ? (
                <p className="px-4 py-4 text-xs text-muted-foreground">
                  No items in this phase. Place assignments/quizzes on the Phases tab, or add a manual item.
                </p>
              ) : (
                phaseItems.map((item) => (
                  <RubricItemRow key={item.id} item={item} sectionId={sectionId} projectId={projectId} canWrite={canWrite} />
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── One editable item row ────────────────────────────────────────

function RubricItemRow({
  item,
  sectionId,
  projectId,
  canWrite,
}: {
  item: RubricItem
  sectionId: string
  projectId: string
  canWrite: boolean
}) {
  const router = useRouter()
  const [weight, setWeight] = useState<string>(String(item.weight))
  const [grain, setGrain] = useState(item.grain)
  const [mode, setMode] = useState(item.scoringMode)
  const [levels, setLevels] = useState<RubricLevel[]>(item.levels)
  const [manualMax, setManualMax] = useState<string>(item.manualMax != null ? String(item.manualMax) : '')
  const [saving, startSave] = useTransition()

  const Icon = TYPE_ICON[item.itemType]
  const isManual = item.itemType === 'manual'
  const isAuto = item.itemType === 'assignment' || item.itemType === 'quiz' || item.itemType === 'attendance'
  // Grain only affects manual + level items (auto-pulled numeric is always per student).
  const grainEditable = isManual || mode === 'levels'
  const modeEditable = item.itemType !== 'attendance' // attendance is a rate, numeric only

  // Unsaved edits vs the saved item, so the Save button can signal there's
  // something to save (and disable when there isn't).
  const dirty =
    weight !== String(item.weight) ||
    grain !== item.grain ||
    mode !== item.scoringMode ||
    (isManual && manualMax !== (item.manualMax != null ? String(item.manualMax) : '')) ||
    JSON.stringify(levels) !== JSON.stringify(item.levels)

  function save() {
    if (mode === 'levels' && levels.some((l) => !l.label.trim())) {
      toast.error('Every level needs a label.')
      return
    }
    // When grain isn't editable we persist 'individual'; sync local state to it
    // so `dirty` clears after the save instead of leaving Save stuck highlighted.
    const nextGrain = grainEditable ? grain : 'individual'
    startSave(async () => {
      const res = await updatePhaseItemGrading(item.id, projectId, sectionId, {
        weight: weight === '' ? 0 : Number(weight),
        grain: nextGrain,
        scoring_mode: mode,
        levels: mode === 'levels' ? levels.map((l) => ({ ...l, label: l.label.trim() })) : [],
        ...(isManual ? { manual_max: manualMax === '' ? null : Number(manualMax) } : {}),
      })
      if (res.error) toast.error(res.error)
      else {
        setGrain(nextGrain)
        toast.success('Saved')
        router.refresh()
      }
    })
  }

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>

        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={0}
            max={1000}
            disabled={!canWrite}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            className="h-8 w-[72px] text-right tabular-nums"
          />
          <span className="text-xs text-muted-foreground">pts</span>
        </div>

        <Select value={grainEditable ? grain : 'individual'} disabled={!canWrite || !grainEditable} onValueChange={(v) => setGrain(v as 'team' | 'individual')}>
          <SelectTrigger className="h-8 w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="individual">Individual</SelectItem>
            <SelectItem value="team">Team</SelectItem>
          </SelectContent>
        </Select>

        <Select value={mode} disabled={!canWrite || !modeEditable} onValueChange={(v) => setMode(v as 'numeric' | 'levels')}>
          <SelectTrigger className="h-8 w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="numeric">{isAuto && item.itemType !== 'manual' ? 'Auto (numeric)' : 'Numeric'}</SelectItem>
            <SelectItem value="levels">Levels</SelectItem>
          </SelectContent>
        </Select>

        {isManual && mode === 'numeric' && (
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">out of</Label>
            <Input
              type="number"
              min={1}
              max={1000}
              disabled={!canWrite}
              value={manualMax}
              onChange={(e) => setManualMax(e.target.value)}
              className="h-8 w-[68px] text-right tabular-nums"
              placeholder="100"
            />
          </div>
        )}

        {canWrite && (
          <Button
            size="sm"
            variant={dirty ? 'default' : 'outline'}
            className="h-8"
            onClick={save}
            disabled={saving || !dirty}
            aria-label="Save item settings"
          >
            {saving ? '…' : <Check className="h-4 w-4" />}
          </Button>
        )}
      </div>

      {/* Levels editor */}
      {mode === 'levels' && (
        <div className="mt-2 space-y-1.5 pl-7">
          {levels.map((lvl, idx) => (
            <div key={lvl.id} className="flex items-center gap-2">
              <Input
                value={lvl.label}
                disabled={!canWrite}
                placeholder="Level label"
                onChange={(e) => setLevels((p) => p.map((l, i) => (i === idx ? { ...l, label: e.target.value } : l)))}
                className="h-8 flex-1"
              />
              <Input
                type="number"
                min={0}
                max={item.weight || 1000}
                disabled={!canWrite}
                value={lvl.points}
                onChange={(e) => setLevels((p) => p.map((l, i) => (i === idx ? { ...l, points: Number(e.target.value) } : l)))}
                className="h-8 w-[80px] text-right tabular-nums"
              />
              <span className="text-xs text-muted-foreground">pts</span>
              {canWrite && (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label="Remove level" onClick={() => setLevels((p) => p.filter((_, i) => i !== idx))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
          {canWrite && (
            <Button variant="outline" size="sm" className="h-7 border-dashed" onClick={() => setLevels((p) => [...p, { id: uid(), label: '', points: 0 }])}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add level
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Add a manual / attendance item to a phase ────────────────────

function AddManualItem({ phaseId, sectionId, projectId }: { phaseId: string; sectionId: string; projectId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<'manual' | 'attendance'>('manual')
  const [title, setTitle] = useState('')
  const [weight, setWeight] = useState('10')
  const [grain, setGrain] = useState<'team' | 'individual'>('individual')
  const [max, setMax] = useState('100')
  const [saving, startSave] = useTransition()

  function submit() {
    if (!title.trim()) {
      toast.error('Give the item a title.')
      return
    }
    startSave(async () => {
      const res = await addManualPhaseItem(phaseId, projectId, sectionId, {
        item_type: type,
        manual_title: title.trim(),
        weight: weight === '' ? 0 : Number(weight),
        grain,
        ...(type === 'manual' ? { manual_max: max === '' ? 100 : Number(max) } : {}),
      })
      if (res.error) toast.error(res.error)
      else {
        toast.success('Item added')
        setOpen(false)
        setTitle('')
        router.refresh()
      }
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 border-dashed text-xs">
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add item
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] space-y-3">
        <Select value={type} onValueChange={(v) => setType(v as 'manual' | 'attendance')}>
          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">Manual column</SelectItem>
            <SelectItem value="attendance">Attendance</SelectItem>
          </SelectContent>
        </Select>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={type === 'attendance' ? 'Attendance' : 'e.g. Final deliverable'} className="h-8" />
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Input type="number" min={0} max={1000} value={weight} onChange={(e) => setWeight(e.target.value)} className="h-8 w-[70px] text-right tabular-nums" />
            <span className="text-xs text-muted-foreground">pts</span>
          </div>
          <Select
            value={type === 'attendance' ? 'individual' : grain}
            disabled={type === 'attendance'}
            onValueChange={(v) => setGrain(v as 'team' | 'individual')}
          >
            <SelectTrigger className="h-8 flex-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="individual">Individual</SelectItem>
              <SelectItem value="team">Team</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {type === 'manual' && (
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">out of</Label>
            <Input type="number" min={1} max={1000} value={max} onChange={(e) => setMax(e.target.value)} className="h-8 w-[70px] text-right tabular-nums" />
          </div>
        )}
        <Button size="sm" className="w-full" onClick={submit} disabled={saving}>
          {saving ? 'Adding…' : 'Add item'}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
