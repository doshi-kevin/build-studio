/**
 * One notebook cell: render + inline edit + outputs + per-cell toolbar.
 *
 * No execution: code cells are an editable mono textarea; stored outputs render read-only
 * (text as text, raster images as data URIs, never HTML/SVG, which could carry script).
 * Markdown cells render via the shared MarkdownLatex and flip to a textarea to edit.
 */
'use client'

import { useState } from 'react'
import {
  GripVertical, ChevronUp, ChevronDown, Copy, Trash2, Lock, LockOpen,
  ChevronsDownUp, ChevronsUpDown, Code2, Type, MoreHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import type { StudioCell } from '@/lib/assignments/studio/notebook-model'
import { isLocked, isCollapsed } from '@/lib/assignments/studio/cell-ops'
import { getAuthoring } from '@/lib/assignments/studio/authoring'
import { StudioMarkdown } from './shared/StudioMarkdown'
import { CodeBlock } from './shared/CodeBlock'
import { PedagogyCorner, CellBadges } from './shared/CellPedagogy'
import type { CellOps } from './studio-ops'

const TYPE_LABEL: Record<StudioCell['cell_type'], string> = {
  code: 'Code',
  markdown: 'Text block',
  raw: 'Raw',
}

interface Props {
  cell: StudioCell
  index: number
  selected: boolean
  mode: 'edit' | 'preview'
  ops: CellOps
  onSelect: () => void
  onCellFocus?: (id: string, el: HTMLTextAreaElement) => void
  onCellBlur?: (id: string) => void
  dragHandle?: React.HTMLAttributes<HTMLButtonElement>
}

function stripAnsi(t: string): string {
  // Strip ANSI colour codes. ESC is built via charCode so no control char sits in source.
  return t.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
}

function CellOutputs({ outputs }: { outputs: unknown[] }) {
  const items: React.ReactNode[] = []
  outputs.slice(0, 50).forEach((raw, i) => {
    const out = (raw ?? {}) as Record<string, unknown>
    const type = out.output_type
    const join = (v: unknown) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '')

    if (type === 'stream') {
      items.push(
        <pre key={i} className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {join(out.text).slice(0, 5000)}
        </pre>,
      )
    } else if (type === 'execute_result' || type === 'display_data') {
      const data = (out.data ?? {}) as Record<string, unknown>
      const img = ['image/png', 'image/jpeg', 'image/gif'].find((m) => data[m])
      if (img) {
        items.push(
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} alt="cell output" className="max-w-full rounded-xl border border-border"
            src={`data:${img};base64,${join(data[img]).replace(/\s/g, '')}`} />,
        )
      } else if (data['text/plain']) {
        items.push(
          <pre key={i} className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-foreground">
            {join(data['text/plain']).slice(0, 5000)}
          </pre>,
        )
      }
    } else if (type === 'error') {
      items.push(
        <pre key={i} className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-destructive-muted p-2 text-xs text-destructive-muted-foreground">
          {stripAnsi(join(out.traceback)).slice(0, 3000)}
        </pre>,
      )
    }
  })
  if (items.length === 0) return null
  return <div className="mt-2 space-y-2 border-l-2 border-border pl-3">{items}</div>
}

export function NotebookCellView({ cell, index, selected, mode, ops, onSelect, onCellFocus, onCellBlur, dragHandle }: Props) {
  const locked = isLocked(cell)
  const collapsed = isCollapsed(cell)
  const preview = mode === 'preview'
  // Per-cell markdown view: raw editor vs rendered preview (explicit toggle, not auto-preview).
  const [mdTab, setMdTab] = useState<'edit' | 'preview'>('edit')
  const isCode = cell.cell_type === 'code'
  const rows = Math.min(Math.max(cell.source.split('\n').length, 2), 40)
  const authoring = getAuthoring(cell.metadata)

  // ── Preview (student) mode: read-only, no chrome ──────────────────────────
  if (preview) {
    if (collapsed) return null
    return (
      <div className="py-2">
        {isCode ? (
          <>
            <CodeBlock code={cell.source || ' '} />
            <CellOutputs outputs={cell.outputs} />
          </>
        ) : cell.cell_type === 'markdown' ? (
          <StudioMarkdown content={cell.source} />
        ) : (
          <pre className="whitespace-pre-wrap text-sm text-muted-foreground">{cell.source}</pre>
        )}
      </div>
    )
  }

  // ── Edit mode ─────────────────────────────────────────────────────────────
  return (
    <div
      id={`studio-cell-${cell.id}`}
      onClick={onSelect}
      className={cn(
        'group relative scroll-mt-4 rounded-2xl border transition-[background-color,border-color,box-shadow] duration-150',
        locked
          ? 'border-border bg-muted/30'
          : selected
            ? 'border-primary/50 bg-card shadow-sm'
            : 'border-border/50 bg-card hover:border-border hover:shadow-sm',
      )}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          {...dragHandle}
          className="cursor-grab rounded-md p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
          aria-label="Drag to reorder"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          disabled={locked || cell.cell_type === 'raw'}
          onClick={(e) => {
            e.stopPropagation()
            ops.changeType(cell.id, isCode ? 'markdown' : 'code')
          }}
          title={locked || cell.cell_type === 'raw' ? undefined : isCode ? 'Switch to text block' : 'Switch to code'}
          className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-default disabled:hover:bg-muted disabled:hover:text-muted-foreground"
        >
          {TYPE_LABEL[cell.cell_type]}
        </button>
        {locked && (
          <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground" aria-label="Locked block">
            <Lock className="h-3 w-3" /> Locked
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <PedagogyCorner authoring={authoring} />
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <ToolBtn label="Move up" onClick={() => ops.move(cell.id, 'up')} disabled={index === 0}><ChevronUp className="h-3.5 w-3.5" /></ToolBtn>
            <ToolBtn label="Move down" onClick={() => ops.move(cell.id, 'down')}><ChevronDown className="h-3.5 w-3.5" /></ToolBtn>
            <ToolBtn label="Duplicate" onClick={() => ops.duplicate(cell.id)}><Copy className="h-3.5 w-3.5" /></ToolBtn>
            <ToolBtn label="Delete" onClick={() => ops.remove(cell.id)} disabled={locked} destructive><Trash2 className="h-3.5 w-3.5" /></ToolBtn>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="More block actions"
                  onClick={(e) => e.stopPropagation()}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem disabled={isCode || locked} onClick={() => ops.changeType(cell.id, 'code')}>
                  <Code2 className="h-4 w-4" /> Convert to code
                </DropdownMenuItem>
                <DropdownMenuItem disabled={cell.cell_type === 'markdown' || locked} onClick={() => ops.changeType(cell.id, 'markdown')}>
                  <Type className="h-4 w-4" /> Convert to text block
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => ops.toggleCollapse(cell.id)}>
                  {collapsed ? <ChevronsUpDown className="h-4 w-4" /> : <ChevronsDownUp className="h-4 w-4" />}
                  {collapsed ? 'Expand' : 'Collapse'}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => ops.toggleLock(cell.id)}>
                  {locked ? <LockOpen className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                  {locked ? 'Unlock' : 'Lock'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={locked} onClick={() => ops.remove(cell.id)}>
                  <Trash2 className="h-4 w-4" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Body */}
      {collapsed ? (
        <p className="px-3 pb-3 text-xs italic text-muted-foreground">Hidden. Expand to edit.</p>
      ) : (
        <div className="px-3 pb-3">
          {isCode || cell.cell_type === 'raw' ? (
            <>
              <textarea
                value={cell.source}
                readOnly={locked}
                onChange={(e) => ops.setSource(cell.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => { onCellFocus?.(cell.id, e.currentTarget); onSelect() }}
                onBlur={() => onCellBlur?.(cell.id)}
                rows={rows}
                spellCheck={false}
                className="w-full resize-y rounded-xl border border-border bg-muted/30 p-3 font-mono text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-60"
                placeholder={isCode ? '# code' : 'raw'}
              />
              {isCode && <CellOutputs outputs={cell.outputs} />}
            </>
          ) : selected && !locked ? (
            <div className="space-y-2">
              <div className="flex items-center justify-end">
                <MarkdownTabToggle value={mdTab} onChange={setMdTab} />
              </div>
              {mdTab === 'edit' ? (
                <textarea
                  value={cell.source}
                  autoFocus
                  onChange={(e) => ops.setSource(cell.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => { onCellFocus?.(cell.id, e.currentTarget); onSelect() }}
                  onBlur={() => onCellBlur?.(cell.id)}
                  rows={rows}
                  className="w-full resize-y rounded-xl border border-border bg-background p-3 text-sm text-foreground outline-none focus:border-primary/50"
                  placeholder="Text. Supports LaTeX and chemistry."
                />
              ) : (
                <div className="rounded-xl border border-border/60 bg-muted/20 p-3" onClick={(e) => e.stopPropagation()}>
                  {cell.source.trim() ? (
                    <StudioMarkdown content={cell.source} />
                  ) : (
                    <p className="text-sm text-muted-foreground">Nothing to preview yet. Switch to Edit to write.</p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="cursor-text rounded-xl px-1">
              {cell.source.trim() ? (
                <StudioMarkdown content={cell.source} />
              ) : (
                <p className="text-sm text-muted-foreground">Empty text block. Click to edit.</p>
              )}
            </div>
          )}
        </div>
      )}

      <CellBadges authoring={authoring} />
    </div>
  )
}

/** Edit | Preview segmented toggle for a markdown cell body. */
function MarkdownTabToggle({ value, onChange }: { value: 'edit' | 'preview'; onChange: (v: 'edit' | 'preview') => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5" onClick={(e) => e.stopPropagation()}>
      {(['edit', 'preview'] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => onChange(tab)}
          aria-pressed={value === tab}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors',
            value === tab ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {tab}
        </button>
      ))}
    </div>
  )
}

function ToolBtn({
  label, onClick, children, disabled, destructive,
}: {
  label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean; destructive?: boolean
}) {
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
