/**
 * MatchNode — a TipTap atom block for "Match the following" questions.
 *
 * Data is stored as JSON in `data-match`. Authoring mode renders two editable columns of cards
 * (Terms left, Definitions right) with @dnd-kit reordering. A "Try it" toggle flips to a
 * shuffled preview so the author can experience the student interaction. Read-only mode renders
 * a static, non-interactive worksheet (terms numbered, right column shuffled as an options bank).
 *
 * Graded/anti-cheat matching (stripping the answer pairing from the student payload + grading in
 * a server action) is a deferred follow-up requiring a Supabase table + migration.
 */
'use client'

import { useState, useCallback, useId, useMemo } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Plus, Trash2, ArrowLeftRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BlockChrome } from './shared/BlockChrome'

// ── Data model ────────────────────────────────────────────────────────────────

export interface MatchPair {
  id: string
  left: string
  right: string
}

export interface MatchDistractor {
  id: string
  text: string
}

export interface MatchConfig {
  prompt: string
  points: number
  pairs: MatchPair[]
  distractors: MatchDistractor[]
}

export const MATCH_DEFAULT: MatchConfig = {
  prompt: 'Match each term with its definition.',
  points: 5,
  pairs: [
    { id: 'p1', left: '', right: '' },
    { id: 'p2', left: '', right: '' },
    { id: 'p3', left: '', right: '' },
  ],
  distractors: [],
}

// ── Colour cycling via --chart-N tokens ───────────────────────────────────────

const FALLBACK_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

function chartColor(index: number): string {
  return FALLBACK_COLORS[index % FALLBACK_COLORS.length]
}

// ── Parse / stringify helpers ─────────────────────────────────────────────────

function parseConfig(raw: string): MatchConfig {
  try {
    const c = JSON.parse(raw) as MatchConfig
    if (!Array.isArray(c.pairs)) c.pairs = []
    if (!Array.isArray(c.distractors)) c.distractors = []
    if (typeof c.prompt !== 'string') c.prompt = ''
    if (typeof c.points !== 'number' || !Number.isFinite(c.points)) c.points = 5
    return c
  } catch {
    return MATCH_DEFAULT
  }
}

function nanoid6(): string {
  return Math.random().toString(36).slice(2, 8)
}

// ── Sortable pair row (authoring) ─────────────────────────────────────────────

interface SortablePairRowProps {
  pair: MatchPair
  index: number
  onChangeLeft: (v: string) => void
  onChangeRight: (v: string) => void
  onDelete: () => void
  isLast: boolean
  onEnterLast: () => void
}

function SortablePairRow({
  pair, index, onChangeLeft, onChangeRight, onDelete, isLast, onEnterLast,
}: SortablePairRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: pair.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  // One solid-colored left swatch per index
  const colorVar = chartColor(index)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('flex items-stretch gap-2', isDragging && 'z-50')}
    >
      {/* Drag handle */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="flex shrink-0 cursor-grab items-center px-0.5 text-muted-foreground opacity-40 active:cursor-grabbing hover:opacity-80"
        aria-label="Drag to reorder"
        tabIndex={-1}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {/* Left (Term) */}
      <div
        className="flex flex-1 items-center rounded-xl border border-border px-3 py-2 text-sm"
        style={{ borderLeftWidth: '3px', borderLeftColor: colorVar }}
      >
        <input
          type="text"
          value={pair.left}
          placeholder={`Term ${index + 1}`}
          onChange={(e) => onChangeLeft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isLast) { e.preventDefault(); onEnterLast() }
          }}
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {/* Right (Definition) */}
      <div className="flex flex-1 items-center rounded-xl border border-border px-3 py-2 text-sm">
        <input
          type="text"
          value={pair.right}
          placeholder={`Definition ${index + 1}`}
          onChange={(e) => onChangeRight(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isLast) { e.preventDefault(); onEnterLast() }
          }}
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {/* Delete row */}
      <button
        type="button"
        onClick={onDelete}
        title="Delete pair"
        className="flex shrink-0 items-center justify-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

// ── "Try it" preview (professor-side, shuffled right column) ──────────────────

function shuffleArray<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function TryItPreview({ cfg }: { cfg: MatchConfig }) {
  // Shuffle once when the component mounts (stable across re-renders)
  const allRight = useMemo(() =>
    shuffleArray([
      ...cfg.pairs.map((p) => ({ id: p.id, text: p.right })),
      ...cfg.distractors.map((d) => ({ id: d.id, text: d.text })),
    ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Preview (right side shuffled)
      </p>
      <div className="flex gap-4">
        {/* Left — terms in order */}
        <div className="flex flex-1 flex-col gap-2">
          {cfg.pairs.map((p, i) => (
            <div
              key={p.id}
              className="rounded-xl border border-border px-3 py-2 text-sm"
              style={{ borderLeftWidth: '3px', borderLeftColor: chartColor(i) }}
            >
              {p.left || <span className="text-muted-foreground italic">Term {i + 1}</span>}
            </div>
          ))}
        </div>
        {/* Right — shuffled options */}
        <div className="flex flex-1 flex-col gap-2">
          {allRight.map((item) => (
            <div key={item.id} className="rounded-xl border border-border px-3 py-2 text-sm bg-muted/30">
              {item.text || <span className="text-muted-foreground italic">Definition</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Authoring view ────────────────────────────────────────────────────────────

function MatchAuthor({ cfg, onChange }: { cfg: MatchConfig; onChange: (next: MatchConfig) => void }) {
  const dndId = useId()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const [tryIt, setTryIt] = useState(false)

  const addPair = useCallback(() => {
    onChange({ ...cfg, pairs: [...cfg.pairs, { id: nanoid6(), left: '', right: '' }] })
  }, [cfg, onChange])

  const deletePair = useCallback((id: string) => {
    onChange({ ...cfg, pairs: cfg.pairs.filter((p) => p.id !== id) })
  }, [cfg, onChange])

  const setPairField = useCallback((id: string, field: 'left' | 'right', value: string) => {
    onChange({
      ...cfg,
      pairs: cfg.pairs.map((p) => p.id === id ? { ...p, [field]: value } : p),
    })
  }, [cfg, onChange])

  const addDistractor = useCallback(() => {
    onChange({ ...cfg, distractors: [...cfg.distractors, { id: nanoid6(), text: '' }] })
  }, [cfg, onChange])

  const deleteDistractor = useCallback((id: string) => {
    onChange({ ...cfg, distractors: cfg.distractors.filter((d) => d.id !== id) })
  }, [cfg, onChange])

  const setDistractorText = useCallback((id: string, text: string) => {
    onChange({ ...cfg, distractors: cfg.distractors.map((d) => d.id === id ? { ...d, text } : d) })
  }, [cfg, onChange])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = cfg.pairs.findIndex((p) => p.id === active.id)
    const newIndex = cfg.pairs.findIndex((p) => p.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    onChange({ ...cfg, pairs: arrayMove(cfg.pairs, oldIndex, newIndex) })
  }, [cfg, onChange])

  return (
    // contentEditable={false} island — ProseMirror ignores pointer events inside this
    <div contentEditable={false} className="select-auto space-y-4">
      {/* Prompt + points row */}
      <div className="flex items-start gap-3">
        <input
          type="text"
          value={cfg.prompt}
          placeholder="Enter the prompt for this matching question…"
          onChange={(e) => onChange({ ...cfg, prompt: e.target.value })}
          className="flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground"
        />
        <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted-foreground">
          <input
            type="number"
            min={0}
            value={cfg.points}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n) && n >= 0) onChange({ ...cfg, points: n })
            }}
            className="w-8 bg-transparent text-center outline-none tabular-nums"
            aria-label="Points"
          />
          pts
        </div>
      </div>

      {/* Column headers */}
      <div className="flex gap-2 pl-6">
        <p className="flex-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Terms</p>
        <p className="flex-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Definitions</p>
        <div className="w-7" aria-hidden />
      </div>

      {/* Sortable pair rows */}
      <DndContext id={dndId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={cfg.pairs.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {cfg.pairs.map((pair, i) => (
              <SortablePairRow
                key={pair.id}
                pair={pair}
                index={i}
                onChangeLeft={(v) => setPairField(pair.id, 'left', v)}
                onChangeRight={(v) => setPairField(pair.id, 'right', v)}
                onDelete={() => deletePair(pair.id)}
                isLast={i === cfg.pairs.length - 1}
                onEnterLast={addPair}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Add pair */}
      <button
        type="button"
        onClick={addPair}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" /> Add pair
      </button>

      {/* Distractors */}
      <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Distractor decoys (right column only)
            </p>
            <button
              type="button"
              onClick={addDistractor}
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            >
              <Plus className="h-2.5 w-2.5" /> Add
            </button>
          </div>
          {cfg.distractors.map((d) => (
            <div key={d.id} className="flex items-center gap-2">
              <div className="flex flex-1 items-center rounded-xl border border-dashed border-border px-3 py-2">
                <input
                  type="text"
                  value={d.text}
                  placeholder="Distractor definition…"
                  onChange={(e) => setDistractorText(d.id, e.target.value)}
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
              <button
                type="button"
                onClick={() => deleteDistractor(d.id)}
                className="flex shrink-0 items-center justify-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
      </div>

      {/* Footer row: hint + Try it toggle */}
      <div className="flex items-center justify-between border-t border-border pt-2">
        <p className="text-[10px] text-muted-foreground">
          Students see the right side shuffled.
        </p>
        <button
          type="button"
          onClick={() => setTryIt((v) => !v)}
          className={cn(
            'rounded-full border px-3 py-1 text-[10px] font-medium transition-colors',
            tryIt
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border text-muted-foreground hover:border-primary hover:text-foreground',
          )}
        >
          {tryIt ? 'Exit preview' : 'Try it'}
        </button>
      </div>

      {/* Try-it preview */}
      {tryIt && (
        <div className="rounded-2xl border border-border bg-muted/20 p-4">
          <TryItPreview cfg={cfg} />
        </div>
      )}
    </div>
  )
}

// ── Read-only / student worksheet ─────────────────────────────────────────────

function MatchReadOnly({ cfg }: { cfg: MatchConfig }) {
  // Shuffle once on mount so options are stable across re-renders.
  const rightOptions = useMemo(() =>
    shuffleArray([
      ...cfg.pairs.map((p, i) => ({ key: p.id, text: p.right, label: String.fromCharCode(65 + i) })),
      ...cfg.distractors.map((d, i) => ({ key: d.id, text: d.text, label: String.fromCharCode(65 + cfg.pairs.length + i) })),
    ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  return (
    <div className="space-y-4 rounded-2xl border border-border p-4">
      {cfg.prompt && (
        <p className="font-medium text-sm text-foreground">{cfg.prompt}</p>
      )}

      {/* Numbered terms — each row has a blank for the matching letter */}
      <div className="space-y-2">
        {cfg.pairs.map((pair, i) => (
          <div key={pair.id} className="flex items-baseline gap-2 text-sm">
            <span className="shrink-0 font-semibold text-foreground">{i + 1}.</span>
            <span className="flex-1 text-foreground">
              {pair.left || <span className="italic text-muted-foreground">Term {i + 1}</span>}
            </span>
            <span className="shrink-0 text-muted-foreground">______</span>
          </div>
        ))}
      </div>

      {/* Options bank — shuffled right-column entries labeled A, B, C… */}
      <div className="border-t border-border pt-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Options</p>
        <div className="flex flex-wrap gap-2">
          {rightOptions.map((opt) => (
            <div
              key={opt.key}
              className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm"
            >
              <span className="font-semibold text-muted-foreground">{opt.label}.</span>
              {opt.text || <span className="italic text-muted-foreground">—</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── NodeView ──────────────────────────────────────────────────────────────────

function MatchNodeView({ node, updateAttributes, deleteNode, getPos, selected, editor }: NodeViewProps) {
  const [cfg, setCfg] = useState<MatchConfig>(() => parseConfig(node.attrs.data as string))
  const canEdit = editor.isEditable

  const write = useCallback((next: MatchConfig) => {
    setCfg(next)
    updateAttributes({ data: JSON.stringify(next) })
  }, [updateAttributes])

  const handleDuplicate = useCallback(() => {
    if (typeof getPos !== 'function') return
    editor.chain().insertContentAt(getPos() + node.nodeSize, node.toJSON()).run()
  }, [editor, getPos, node])

  return (
    <NodeViewWrapper>
      <BlockChrome
        editor={editor}
        selected={selected}
        onDelete={deleteNode}
        onDuplicate={handleDuplicate}
      >
        <div className="rounded-2xl border border-border bg-card p-4">
          {/* Icon header */}
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <ArrowLeftRight className="h-3.5 w-3.5" />
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Match the following
            </span>
          </div>

          {canEdit ? (
            <MatchAuthor cfg={cfg} onChange={write} />
          ) : (
            <MatchReadOnly cfg={cfg} />
          )}
        </div>
      </BlockChrome>
    </NodeViewWrapper>
  )
}

// ── TipTap Node definition ────────────────────────────────────────────────────

export const MatchNode = Node.create({
  name: 'match',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      data: {
        default: JSON.stringify(MATCH_DEFAULT),
        parseHTML: (el) => el.getAttribute('data-match') ?? JSON.stringify(MATCH_DEFAULT),
        renderHTML: (attrs) => ({ 'data-match': attrs.data as string }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-match]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-match': '' }, HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MatchNodeView)
  },
})
