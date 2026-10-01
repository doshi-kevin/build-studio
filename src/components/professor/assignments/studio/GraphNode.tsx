/**
 * GraphNode — a TipTap block node that plots one or more functions y = f(x).
 *
 * Sibling of ChartNode: same insert-then-edit-inline UX, but instead of hand-entered points it
 * samples each expression across an x-range with mathjs and draws the curves with Recharts. Click
 * "Edit graph" to change the functions, the range, or the title. Config is JSON in `data-graph`.
 */
'use client'

import { useState, useCallback } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { compile } from 'mathjs'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { BlockChrome } from './shared/BlockChrome'
import type { BlockAlign } from './shared/BlockChrome'

export interface GraphFunction { expr: string; label: string }
export interface GraphConfig {
  title: string
  xMin: number
  xMax: number
  functions: GraphFunction[]
}

export const GRAPH_DEFAULT: GraphConfig = {
  title: 'Function graph',
  xMin: -6,
  xMax: 6,
  functions: [{ expr: 'sin(x)', label: 'f₁' }],
}

// Series colours mirror ChartNode's token approach so the two blocks look like one family.
const SERIES = [
  'hsl(var(--primary))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
]
const SAMPLES = 160

function parseConfig(raw: string): GraphConfig {
  try {
    const c = JSON.parse(raw) as GraphConfig
    if (!c.functions?.length) c.functions = GRAPH_DEFAULT.functions
    return c
  } catch {
    return GRAPH_DEFAULT
  }
}

/** Sample each function across [xMin, xMax]; invalid expressions simply contribute no points. */
function sample(config: GraphConfig): { rows: Record<string, number>[]; errors: boolean[] } {
  const { xMin, xMax, functions } = config
  const lo = Number.isFinite(xMin) ? xMin : -6
  const hi = Number.isFinite(xMax) && xMax > lo ? xMax : lo + 1
  const step = (hi - lo) / (SAMPLES - 1)
  const compiled = functions.map((f) => {
    try { return compile(f.expr) } catch { return null }
  })
  const errors = compiled.map((c) => c === null)
  const rows: Record<string, number>[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const x = lo + i * step
    const row: Record<string, number> = { x: Math.round(x * 1000) / 1000 }
    compiled.forEach((c, idx) => {
      if (!c) return
      try {
        const y = c.evaluate({ x })
        if (typeof y === 'number' && Number.isFinite(y)) row[`f${idx}`] = Math.round(y * 1e6) / 1e6
      } catch {
        /* undefined at this x (e.g. tan asymptote) — skip the point */
      }
    })
    rows.push(row)
  }
  return { rows, errors }
}

function GraphRenderer({ config }: { config: GraphConfig }) {
  const { rows, errors } = sample(config)
  return (
    <div className="w-full">
      {config.title && <p className="mb-2 text-center text-sm font-medium text-foreground">{config.title}</p>}
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={rows} margin={{ top: 6, right: 12, left: 0, bottom: 4 }}>
          <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} allowDecimals />
          <YAxis hide />
          <Tooltip />
          {config.functions.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {config.functions.map((f, i) =>
            errors[i] ? null : (
              <Line
                key={i}
                type="monotone"
                dataKey={`f${i}`}
                name={f.label || `f${i + 1}`}
                stroke={SERIES[i % SERIES.length]}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ),
          )}
        </LineChart>
      </ResponsiveContainer>
      {errors.some(Boolean) && (
        <p className="mt-1 text-center text-xs text-destructive">
          Check the highlighted expression{errors.filter(Boolean).length > 1 ? 's' : ''} — couldn&apos;t plot.
        </p>
      )}
    </div>
  )
}

function GraphNodeView({ node, updateAttributes, deleteNode, getPos, selected, editor }: NodeViewProps) {
  const config = parseConfig(node.attrs.data as string)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<GraphConfig>(config)
  const width = (node.attrs.width as number | null) ?? 100
  const align = ((node.attrs.align as string | null) ?? 'center') as BlockAlign

  const startEdit = useCallback(() => {
    setDraft(parseConfig(node.attrs.data as string))
    setEditing(true)
  }, [node.attrs.data])

  const commit = useCallback(() => {
    updateAttributes({ data: JSON.stringify(draft) })
    setEditing(false)
  }, [draft, updateAttributes])

  const handleDuplicate = useCallback(() => {
    if (typeof getPos !== 'function') return
    editor.chain().insertContentAt(getPos() + node.nodeSize, node.toJSON()).run()
  }, [editor, getPos, node])

  const draftErrors = sample(draft).errors

  return (
    <NodeViewWrapper>
      <BlockChrome
        editor={editor}
        selected={selected}
        onEdit={startEdit}
        onDelete={deleteNode}
        onDuplicate={handleDuplicate}
        editLabel="Edit graph"
        align={align}
        onAlign={(a) => updateAttributes({ align: a })}
        width={width}
        onResize={(pct) => updateAttributes({ width: pct })}
      >
        <GraphRenderer config={editing ? draft : config} />

        {editing && (
          <div className="mt-4 space-y-3 border-t border-border pt-4">
            <Input
              value={draft.title}
              onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
              placeholder="Title"
              className="h-8 text-xs"
            />
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                x min
                <Input
                  type="number"
                  value={draft.xMin}
                  onChange={(e) => setDraft((p) => ({ ...p, xMin: Number(e.target.value) }))}
                  className="h-8 text-xs"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                x max
                <Input
                  type="number"
                  value={draft.xMax}
                  onChange={(e) => setDraft((p) => ({ ...p, xMax: Number(e.target.value) }))}
                  className="h-8 text-xs"
                />
              </label>
            </div>

            <div className="space-y-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Functions of x</span>
              {draft.functions.map((f, i) => (
                <div key={i} className="grid grid-cols-[16px_1fr_28px] items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: SERIES[i % SERIES.length] }} />
                  <Input
                    value={f.expr}
                    onChange={(e) => setDraft((p) => ({ ...p, functions: p.functions.map((fn, idx) => idx === i ? { ...fn, expr: e.target.value } : fn) }))}
                    placeholder="e.g. x^2 - 3, sin(x), 2*x+1"
                    className={cn('h-8 font-mono text-xs', draftErrors[i] && 'border-destructive')}
                  />
                  <button
                    type="button"
                    onClick={() => setDraft((p) => ({ ...p, functions: p.functions.filter((_, idx) => idx !== i) }))}
                    disabled={draft.functions.length <= 1}
                    className="flex h-8 w-7 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive disabled:opacity-40"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setDraft((p) => ({ ...p, functions: [...p.functions, { expr: '', label: `f${p.functions.length + 1}` }] }))}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
              >
                <Plus className="h-3 w-3" /> Add function
              </button>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
              <Button type="button" size="sm" onClick={commit}>Save graph</Button>
            </div>
          </div>
        )}
      </BlockChrome>
    </NodeViewWrapper>
  )
}

export const GraphNode = Node.create({
  name: 'graph',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      data: {
        default: JSON.stringify(GRAPH_DEFAULT),
        parseHTML: (el) => el.getAttribute('data-graph') ?? JSON.stringify(GRAPH_DEFAULT),
        renderHTML: (attrs) => ({ 'data-graph': attrs.data as string }),
      },
      width: {
        default: 100,
        parseHTML: (el) => { const v = el.getAttribute('data-width'); return v ? Number(v) : 100 },
        renderHTML: (attrs) => ({ 'data-width': String(attrs.width ?? 100) }),
      },
      align: {
        default: 'center',
        parseHTML: (el) => el.getAttribute('data-align') ?? 'center',
        renderHTML: (attrs) => ({ 'data-align': (attrs.align as string) ?? 'center' }),
      },
    }
  },
  parseHTML() { return [{ tag: 'div[data-graph]' }] },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes({ 'data-graph': '' }, HTMLAttributes)] },
  addNodeView() { return ReactNodeViewRenderer(GraphNodeView) },
})
