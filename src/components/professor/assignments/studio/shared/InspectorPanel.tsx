'use client'

import { useState, useTransition } from 'react'
import { Plus, X, ChevronUp, ChevronDown, Lightbulb, Link, Trash2, Info, Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select'
import { BLOOM_LEVELS, type AuthoringMeta, type BloomLevel } from '@/lib/assignments/studio/authoring'
import { generateReferenceLinks } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'

export interface ReferenceLink {
  label: string
  url: string
}

const NONE = 'none'

interface Props {
  authoring: AuthoringMeta
  onChange: (meta: AuthoringMeta) => void
  disabled?: boolean
  sectionId: string
  references: ReferenceLink[]
  onChangeReferences: (refs: ReferenceLink[]) => void
  onDelete: () => void
}

export function InspectorPanel({ authoring, onChange, disabled, sectionId, references, onChangeReferences, onDelete }: Props) {
  const [newTag, setNewTag] = useState('')
  const [generatingLinks, startGenerating] = useTransition()

  const a = authoring
  const hints = a.hints ?? []
  const tags = a.conceptTags ?? []
  const graded = a.graded === true

  const patch = (next: Partial<AuthoringMeta>) => onChange({ ...a, ...next })

  function setHint(i: number, value: string) {
    const copy = [...hints]; copy[i] = value; patch({ hints: copy })
  }
  function moveHint(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= hints.length) return
    const copy = [...hints];
    [copy[i], copy[j]] = [copy[j], copy[i]]; patch({ hints: copy })
  }
  function addTag() {
    const t = newTag.trim()
    if (!t || tags.includes(t)) { setNewTag(''); return }
    patch({ conceptTags: [...tags, t] }); setNewTag('')
  }

  function updateRef(i: number, field: keyof ReferenceLink, value: string) {
    onChangeReferences(references.map((r, k) => k === i ? { ...r, [field]: value } : r))
  }
  function removeRef(i: number) {
    onChangeReferences(references.filter((_, k) => k !== i))
  }
  function addRef() {
    onChangeReferences([...references, { label: '', url: '' }])
  }
  function generateLinks() {
    if (!tags.length) return
    startGenerating(async () => {
      const res = await generateReferenceLinks(sectionId, tags)
      if ('error' in res) return
      const existing = new Set(references.map((r) => r.url))
      const fresh = res.links.filter((l) => !existing.has(l.url))
      if (fresh.length) onChangeReferences([...references, ...fresh])
    })
  }

  return (
    <fieldset disabled={disabled} className="space-y-3 disabled:opacity-60">

      {/* Difficulty — segmented */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Difficulty</Label>
        <div className="flex gap-1">
          {(['easy', 'medium', 'hard'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => patch({ difficulty: a.difficulty === d ? undefined : d })}
              className={cn(
                'flex-1 rounded-lg border px-2 py-1 text-xs uppercase tracking-wide transition-colors',
                a.difficulty === d
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {d === 'medium' ? 'Med' : d}
            </button>
          ))}
        </div>
      </div>

      {/* Bloom's taxonomy */}
      <div className="space-y-1.5">
        <Label className="flex items-center gap-1 text-xs text-muted-foreground">
          Bloom&apos;s
          <Info className="h-3 w-3" aria-hidden />
          <span className="sr-only">Bloom&apos;s taxonomy cognitive level</span>
        </Label>
        <Select
          value={a.bloom ?? NONE}
          onValueChange={(v) => patch({ bloom: v === NONE ? undefined : (v as BloomLevel) })}
        >
          <SelectTrigger className="h-8 text-sm capitalize"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {BLOOM_LEVELS.map((b) => (
              <SelectItem key={b} value={b} className="capitalize">{b}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Concept tags */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Tags</Label>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                {t}
                <button type="button" onClick={() => patch({ conceptTags: tags.filter((x) => x !== t) })} aria-label={`Remove ${t}`}>
                  <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                </button>
              </span>
            ))}
          </div>
        )}
        <Input
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
          onBlur={addTag}
          placeholder="comma-separated"
          className="h-8"
        />
      </div>

      {/* Grading */}
      <label htmlFor="insp-graded" className="flex items-center justify-between gap-4 py-0.5">
        <span className="text-xs font-medium text-foreground">Counts toward grade</span>
        <Switch id="insp-graded" checked={graded} onCheckedChange={(c) => patch({ graded: c })} />
      </label>

      {graded && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="insp-points" className="text-xs text-muted-foreground">Points</Label>
            <Input
              id="insp-points"
              type="number"
              min={0}
              value={a.points ?? ''}
              placeholder="0"
              onChange={(e) => patch({ points: e.target.value === '' ? undefined : Number(e.target.value) })}
              className="h-8"
            />
          </div>

          <label htmlFor="insp-bonus" className="flex items-center gap-2">
            <Switch id="insp-bonus" checked={!!a.bonus} onCheckedChange={(c) => patch({ bonus: c })} />
            <span className="text-xs font-medium text-foreground">Bonus</span>
          </label>
          <label htmlFor="insp-extra" className="flex items-center gap-2">
            <Switch id="insp-extra" checked={!!a.extraCredit} onCheckedChange={(c) => patch({ extraCredit: c })} />
            <span className="text-xs font-medium text-foreground">Extra Credit</span>
          </label>

          <div className="space-y-1.5">
            <Label htmlFor="insp-key" className="text-xs text-muted-foreground">Answer key (professor only)</Label>
            <Textarea
              id="insp-key"
              rows={2}
              value={a.answerKey ?? ''}
              placeholder="Expected answer"
              onChange={(e) => patch({ answerKey: e.target.value })}
            />
          </div>
        </>
      )}

      {/* Progressive hints */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lightbulb className="h-3.5 w-3.5" /> Progressive hints
          </Label>
          <button
            type="button"
            onClick={() => patch({ hints: [...hints, ''] })}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        {hints.length === 0 ? (
          <p className="text-xs text-muted-foreground">No hints yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {hints.map((h, i) => (
              <li key={i} className="flex items-start gap-1">
                <span className="mt-2 w-4 shrink-0 text-center text-xs text-muted-foreground">{i + 1}</span>
                <Textarea
                  rows={2}
                  value={h}
                  onChange={(e) => setHint(i, e.target.value)}
                  placeholder={`Hint ${i + 1}`}
                  className="flex-1"
                />
                <div className="flex flex-col">
                  <button type="button" onClick={() => moveHint(i, -1)} disabled={i === 0} className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30" aria-label="Move hint up"><ChevronUp className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => moveHint(i, 1)} disabled={i === hints.length - 1} className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30" aria-label="Move hint down"><ChevronDown className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => patch({ hints: hints.filter((_, k) => k !== i) })} className="rounded p-0.5 text-muted-foreground hover:bg-destructive-muted hover:text-destructive-muted-foreground" aria-label="Remove hint"><X className="h-3.5 w-3.5" /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Reference links */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Link className="h-3.5 w-3.5" /> Reference links
          </Label>
          {tags.length > 0 && (
            <button
              type="button"
              onClick={generateLinks}
              disabled={generatingLinks}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-50"
            >
              <Bot className="h-3 w-3" />
              {generatingLinks ? 'Generating…' : 'AI suggest'}
            </button>
          )}
        </div>
        {references.length === 0 ? (
          <p className="text-xs text-muted-foreground">No links yet. Add manually or use AI suggest from your tags.</p>
        ) : (
          <ul className="space-y-1.5">
            {references.map((r, i) => (
              <li key={i} className="space-y-1 rounded-xl border border-border p-2">
                <div className="flex items-center gap-1">
                  <Input
                    value={r.label}
                    onChange={(e) => updateRef(i, 'label', e.target.value)}
                    placeholder="Label"
                    className="h-7 text-xs"
                    aria-label="Link label"
                  />
                  <button
                    type="button"
                    onClick={() => removeRef(i)}
                    className="rounded-md p-1 text-muted-foreground hover:text-destructive"
                    aria-label="Remove link"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <Input
                  value={r.url}
                  onChange={(e) => updateRef(i, 'url', e.target.value)}
                  placeholder="https://..."
                  className="h-7 text-xs"
                  aria-label="Link URL"
                />
              </li>
            ))}
          </ul>
        )}
        <Button variant="outline" size="sm" className="w-full h-7 text-xs" onClick={addRef}>
          <Plus className="h-3.5 w-3.5" /> Add link
        </Button>
      </div>

      {/* Delete */}
      <button
        type="button"
        onClick={onDelete}
        className="flex items-center gap-1.5 text-xs font-medium text-destructive hover:underline"
      >
        <Trash2 className="h-3.5 w-3.5" /> Delete block
      </button>

    </fieldset>
  )
}
