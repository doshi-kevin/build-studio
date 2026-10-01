/**
 * One Verbal Assessment cell, styled to match the notebook studio cells. Cell types:
 * greeting, question, mcq, ai_followup (an inert seam block where Athena's adaptive
 * follow-up plugs in later). Authoring only - no grading, no AI calls.
 */
'use client'

import { useRef } from 'react'
import {
  GripVertical, ChevronUp, ChevronDown, Copy, Trash2, Volume2, Loader2,
  Plus, X, Bot, Hand, MessageSquareText, ListChecks, CircleDot,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { StudioMarkdown } from '@/components/professor/assignments/studio/shared/StudioMarkdown'
import { insertAt } from '@/lib/assignments/studio/insert-ops'
import { GREETING_PRESETS, type VerbalCell } from '@/lib/assignments/verbal/config'

export interface VerbalCellOps {
  update: (id: string, patch: Partial<VerbalCell>) => void
  remove: (id: string) => void
  move: (id: string, dir: -1 | 1) => void
  duplicate: (id: string) => void
  generateAudio: (id: string) => void
  aiGenerate: (id: string) => void
}

const META: Record<VerbalCell['type'], { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  greeting: { label: 'Greeting', icon: Hand },
  question: { label: 'Question', icon: MessageSquareText },
  mcq: { label: 'MCQ', icon: ListChecks },
  ai_followup: { label: 'AI follow-up', icon: Bot },
}

interface Props {
  cell: VerbalCell
  index: number
  total: number
  maxFollowUpDepth: number
  selected: boolean
  generating: boolean
  audioUrl: string | null | undefined
  ops: VerbalCellOps
  onSelect: () => void
  onCellFocus?: (id: string, el: HTMLTextAreaElement) => void
  dragHandle?: React.HTMLAttributes<HTMLButtonElement>
}

export function VerbalCellView({ cell, index, total, maxFollowUpDepth, selected, generating, audioUrl, ops, onSelect, onCellFocus, dragHandle }: Props) {
  const meta = META[cell.type]
  const Icon = meta.icon
  const canAudio = (cell.type === 'question' || cell.type === 'mcq') && cell.prompt.trim().length > 0

  return (
    <div
      onClick={onSelect}
      className={cn(
        'group relative rounded-2xl border transition-[background-color,border-color,box-shadow] duration-150',
        cell.type === 'ai_followup' ? 'border-dashed border-primary/40 bg-primary/5' : selected ? 'border-primary/50 bg-card shadow-sm' : 'border-border/50 bg-card hover:border-border hover:shadow-sm',
      )}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button {...dragHandle} onClick={(e) => e.stopPropagation()} aria-label="Drag to reorder" className="cursor-grab rounded-md p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing">
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Icon className="h-3 w-3" /> {meta.label}
        </span>
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Tool label="Move up" onClick={() => ops.move(cell.id, -1)} disabled={index === 0}><ChevronUp className="h-3.5 w-3.5" /></Tool>
          <Tool label="Move down" onClick={() => ops.move(cell.id, 1)} disabled={index === total - 1}><ChevronDown className="h-3.5 w-3.5" /></Tool>
          <Tool label="Duplicate" onClick={() => ops.duplicate(cell.id)}><Copy className="h-3.5 w-3.5" /></Tool>
          <Tool label="Delete" onClick={() => ops.remove(cell.id)} destructive><Trash2 className="h-3.5 w-3.5" /></Tool>
        </div>
      </div>

      {/* Body */}
      <div className="space-y-3 px-3 pb-3">
        {cell.type === 'ai_followup' ? (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p>
              Athena asks an adaptive follow-up here based on the student&apos;s answer (up to{' '}
              <span className="font-medium text-foreground">{maxFollowUpDepth}</span> deep). Built by Athena; nothing to author.
            </p>
          </div>
        ) : (
          <>
            {cell.type === 'greeting' ? (
              <GreetingEditor cell={cell} ops={ops} onCellFocus={onCellFocus} />
            ) : selected ? (
              <Textarea
                value={cell.prompt}
                autoFocus
                onChange={(e) => ops.update(cell.id, { prompt: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => onCellFocus?.(cell.id, e.currentTarget)}
                rows={2}
                placeholder={cell.type === 'mcq' ? 'The multiple-choice question stem' : 'The question the student will be asked aloud'}
              />
            ) : (
              <div className="cursor-text rounded-xl">
                {cell.prompt.trim() ? (
                  <StudioMarkdown content={cell.prompt} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {cell.type === 'mcq' ? 'Empty MCQ stem. Click to edit.' : 'Empty question. Click to edit.'}
                  </p>
                )}
              </div>
            )}

            {cell.type === 'mcq' && <McqOptions cell={cell} ops={ops} />}

            {cell.type === 'mcq' && <McqFollowUps cell={cell} ops={ops} />}

            {/* Footer controls for question/mcq */}
            {(cell.type === 'question' || cell.type === 'mcq') && (
              <div className="flex flex-wrap items-center gap-3 border-t border-border/50 pt-2">
                {cell.type === 'question' && (
                  <select
                    value={cell.answerType ?? 'short'}
                    onChange={(e) => ops.update(cell.id, { answerType: e.target.value as 'short' | 'long' })}
                    onClick={(e) => e.stopPropagation()}
                    className="h-7 rounded-lg border border-border bg-background px-1.5 text-xs text-foreground"
                  >
                    <option value="short">Short answer</option>
                    <option value="long">Long answer</option>
                  </select>
                )}
                <label className="inline-flex items-center gap-2 text-xs text-foreground" onClick={(e) => e.stopPropagation()}>
                  <Switch checked={cell.allowFollowUps ?? false} onCheckedChange={(v) => ops.update(cell.id, { allowFollowUps: v })} />
                  Allow AI follow-ups
                </label>
                {cell.type === 'mcq' && (
                  <button type="button" onClick={(e) => { e.stopPropagation(); ops.aiGenerate(cell.id) }} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-primary hover:bg-muted">
                    <Bot className="h-3.5 w-3.5" /> Generate with AI
                  </button>
                )}
                <button
                  type="button"
                  disabled={generating || !canAudio}
                  onClick={(e) => { e.stopPropagation(); ops.generateAudio(cell.id) }}
                  className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Volume2 className="h-3.5 w-3.5" />}
                  {cell.audioPath ? 'Regenerate audio' : 'Generate audio'}
                </button>
              </div>
            )}

            {audioUrl && (
              <audio controls src={audioUrl} className="h-9 w-full">
                <track kind="captions" />
              </audio>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Greeting authoring: a preset picker + one-click {name}/{topic} inserts over the free-text field. */
function GreetingEditor({
  cell, ops, onCellFocus,
}: {
  cell: VerbalCell
  ops: VerbalCellOps
  onCellFocus?: (id: string, el: HTMLTextAreaElement) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  function insertVar(token: string) {
    const el = ref.current
    if (!el) {
      ops.update(cell.id, { prompt: cell.prompt + token })
      return
    }
    const start = el.selectionStart ?? cell.prompt.length
    const end = el.selectionEnd ?? start
    const { value, selStart } = insertAt(cell.prompt, start, end, token)
    ops.update(cell.id, { prompt: value })
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(selStart, selStart)
    })
  }

  // Applying a template REPLACES the greeting. Only a non-empty, different prior greeting is worth
  // warning about, so offer an Undo toast in that case (autosave makes a silent overwrite risky).
  function applyPreset(text: string) {
    const prev = cell.prompt
    ops.update(cell.id, { prompt: text })
    if (prev.trim() && prev !== text) {
      toast('Greeting replaced with a template', {
        action: { label: 'Undo', onClick: () => ops.update(cell.id, { prompt: prev }) },
      })
    }
  }

  return (
    <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
            >
              Use a template <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {GREETING_PRESETS.map((g) => (
              <DropdownMenuItem key={g.label} onClick={() => applyPreset(g.text)} className="flex-col items-start gap-0.5">
                <span className="text-xs font-medium text-foreground">{g.label}</span>
                <span className="max-w-64 truncate text-[11px] text-muted-foreground">{g.text}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <VarChip label="{name}" onClick={() => insertVar('{name}')} />
        <VarChip label="{topic}" onClick={() => insertVar('{topic}')} />
      </div>
      <Textarea
        ref={ref}
        value={cell.prompt}
        onChange={(e) => ops.update(cell.id, { prompt: e.target.value })}
        onFocus={(e) => onCellFocus?.(cell.id, e.currentTarget)}
        rows={2}
        placeholder="Greeting, supports {name} and {topic}"
      />
      <p className="text-xs text-muted-foreground">
        Spoken to each student by name. Pick a template or insert <code className="rounded bg-muted px-1">{'{name}'}</code> / <code className="rounded bg-muted px-1">{'{topic}'}</code>.
      </p>
    </div>
  )
}

function VarChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs font-medium text-foreground transition-colors hover:bg-accent"
    >
      {label}
    </button>
  )
}

function McqOptions({ cell, ops }: { cell: VerbalCell; ops: VerbalCellOps }) {
  const options = cell.options ?? []
  const setOpt = (id: string, text: string) => ops.update(cell.id, { options: options.map((o) => (o.id === id ? { ...o, text } : o)) })
  const addOpt = () => ops.update(cell.id, { options: [...options, { id: Math.random().toString(36).slice(2, 10), text: '' }] })
  const removeOpt = (id: string) => ops.update(cell.id, { options: options.filter((o) => o.id !== id), correctOptionId: cell.correctOptionId === id ? undefined : cell.correctOptionId })

  return (
    <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
      {options.map((o) => (
        <div key={o.id} className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => ops.update(cell.id, { correctOptionId: o.id })}
            aria-label="Mark correct"
            title="Mark as the correct answer"
            className={cn('shrink-0 rounded-full p-0.5', cell.correctOptionId === o.id ? 'text-primary' : 'text-muted-foreground hover:text-foreground')}
          >
            <CircleDot className="h-4 w-4" />
          </button>
          <Input value={o.text} onChange={(e) => setOpt(o.id, e.target.value)} placeholder="Option" className="h-8 text-sm" />
          <button type="button" onClick={() => removeOpt(o.id)} aria-label="Remove option" className="rounded p-1 text-muted-foreground hover:bg-destructive-muted hover:text-destructive-muted-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={addOpt} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
        <Plus className="h-3.5 w-3.5" /> Add option
      </button>
    </div>
  )
}

/** Deterministic, professor-authored follow-up asked based on MCQ correctness (no AI). */
function McqFollowUps({ cell, ops }: { cell: VerbalCell; ops: VerbalCellOps }) {
  const fu = cell.followUps ?? {}
  const set = (patch: Partial<NonNullable<VerbalCell['followUps']>>) =>
    ops.update(cell.id, { followUps: { ...fu, ...patch } })
  const hasKey = !!cell.correctOptionId
  return (
    <div className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3" onClick={(e) => e.stopPropagation()}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Adaptive follow-up</p>
      {!hasKey && (
        <p className="text-[11px] leading-snug text-muted-foreground">Mark the correct option above to branch on the student&apos;s answer.</p>
      )}
      <div className="space-y-1.5">
        <Label className="text-xs text-success-muted-foreground">If correct, ask</Label>
        <Input
          value={fu.correct ?? ''}
          onChange={(e) => set({ correct: e.target.value })}
          placeholder="A harder follow-up (optional)"
          className="h-8 text-sm"
          disabled={!hasKey}
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-destructive">If incorrect, ask</Label>
        <Input
          value={fu.incorrect ?? ''}
          onChange={(e) => set({ incorrect: e.target.value })}
          placeholder="A simpler, probing follow-up (optional)"
          className="h-8 text-sm"
          disabled={!hasKey}
        />
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">Spoken aloud right after this question, chosen by whether the pick was correct.</p>
    </div>
  )
}

function Tool({ label, onClick, disabled, destructive, children }: { label: string; onClick: () => void; disabled?: boolean; destructive?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={cn(
        'rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30',
        destructive && 'hover:bg-destructive-muted hover:text-destructive-muted-foreground',
      )}
    >
      {children}
    </button>
  )
}
