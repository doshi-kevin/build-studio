'use client'

import { useMemo, useState } from 'react'
import type React from 'react'
import { Search, Sigma, Pi, Code2, Table, TrendingUp, BarChart2, Atom, LineChart } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CellImageUploadButton } from './shared/CellImageUploadButton'
import { CELL_PALETTE, type PaletteItem } from '@/lib/assignments/studio/palette'

interface Props {
  sectionId: string
  assignmentId: string
  onInsert: (item: Pick<PaletteItem, 'cellType' | 'template'>) => void
}

const QUICK_INSERT = [
  { label: 'Equation', icon: Sigma, cellType: 'markdown' as const, template: '$$\nE = mc^2\n$$' },
  { label: 'LaTeX', icon: Pi, cellType: 'markdown' as const, template: '$$\n\\begin{aligned}\n  a &= b + c\n\\end{aligned}\n$$' },
  { label: 'Code', icon: Code2, cellType: 'code' as const, template: '' },
]

function buildTableMarkdown(rows: number, cols: number): string {
  const header = '| ' + Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(' | ') + ' |'
  const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |'
  const row = '| ' + Array.from({ length: cols }, () => '').join(' | ') + ' |'
  return [header, sep, ...Array.from({ length: rows }, () => row)].join('\n')
}

function TablePicker({ onInsert }: { onInsert: Props['onInsert'] }) {
  const MAX = 6
  const [hovered, setHovered] = useState({ rows: 0, cols: 0 })
  const [open, setOpen] = useState(false)

  const insert = (rows: number, cols: number) => {
    onInsert({ cellType: 'markdown', template: buildTableMarkdown(rows, cols) })
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex flex-col items-center gap-1 rounded-xl border border-border bg-background px-2 py-2.5 text-center transition-colors hover:border-primary hover:bg-accent"
        >
          <Table className="h-4 w-4 text-muted-foreground" />
          <span className="text-[10px] leading-tight text-foreground">Table</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-auto p-2">
        <div
          className="grid gap-0.5"
          style={{ gridTemplateColumns: `repeat(${MAX}, 1.5rem)` }}
          onMouseLeave={() => setHovered({ rows: 0, cols: 0 })}
        >
          {Array.from({ length: MAX * MAX }, (_, i) => {
            const r = Math.floor(i / MAX) + 1
            const c = (i % MAX) + 1
            const active = r <= hovered.rows && c <= hovered.cols
            return (
              <button
                key={i}
                type="button"
                className={`h-6 w-6 rounded border transition-colors ${active ? 'border-primary bg-primary/20' : 'border-border bg-background'}`}
                onMouseEnter={() => setHovered({ rows: r, cols: c })}
                onClick={() => insert(r, c)}
              />
            )
          })}
        </div>
        <p className="mt-1.5 text-center text-xs text-muted-foreground">
          {hovered.rows > 0 ? `${hovered.rows} × ${hovered.cols}` : 'Hover to select size'}
        </p>
      </PopoverContent>
    </Popover>
  )
}

// SVG thumbnails for chart type buttons
function LineChartThumb() {
  return (
    <svg viewBox="0 0 48 32" fill="none" className="h-7 w-full" aria-hidden>
      <line x1="3" y1="29" x2="45" y2="29" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" />
      <line x1="3" y1="3" x2="3" y2="29" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" />
      <polyline points="4,24 12,17 20,20 28,9 36,13 44,5" stroke="currentColor" strokeOpacity="0.8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="4" cy="24" r="2" fill="currentColor" fillOpacity="0.7" />
      <circle cx="12" cy="17" r="2" fill="currentColor" fillOpacity="0.7" />
      <circle cx="20" cy="20" r="2" fill="currentColor" fillOpacity="0.7" />
      <circle cx="28" cy="9" r="2" fill="currentColor" fillOpacity="0.7" />
      <circle cx="36" cy="13" r="2" fill="currentColor" fillOpacity="0.7" />
      <circle cx="44" cy="5" r="2" fill="currentColor" fillOpacity="0.7" />
    </svg>
  )
}
function BarChartThumb() {
  return (
    <svg viewBox="0 0 48 32" fill="none" className="h-7 w-full" aria-hidden>
      <line x1="3" y1="29" x2="45" y2="29" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" />
      <rect x="5" y="16" width="8" height="13" fill="currentColor" fillOpacity="0.5" rx="1.5" />
      <rect x="15" y="8" width="8" height="21" fill="currentColor" fillOpacity="0.7" rx="1.5" />
      <rect x="25" y="18" width="8" height="11" fill="currentColor" fillOpacity="0.5" rx="1.5" />
      <rect x="35" y="5" width="8" height="24" fill="currentColor" fillOpacity="0.7" rx="1.5" />
    </svg>
  )
}
function ScatterThumb() {
  return (
    <svg viewBox="0 0 48 32" fill="none" className="h-7 w-full" aria-hidden>
      <line x1="3" y1="29" x2="45" y2="29" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" />
      <line x1="3" y1="3" x2="3" y2="29" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" />
      <circle cx="9" cy="24" r="2.5" fill="currentColor" fillOpacity="0.7" />
      <circle cx="16" cy="11" r="2.5" fill="currentColor" fillOpacity="0.7" />
      <circle cx="22" cy="20" r="2.5" fill="currentColor" fillOpacity="0.7" />
      <circle cx="30" cy="7" r="2.5" fill="currentColor" fillOpacity="0.7" />
      <circle cx="37" cy="15" r="2.5" fill="currentColor" fillOpacity="0.7" />
      <circle cx="43" cy="10" r="2.5" fill="currentColor" fillOpacity="0.7" />
    </svg>
  )
}
function HistogramThumb() {
  return (
    <svg viewBox="0 0 48 32" fill="none" className="h-7 w-full" aria-hidden>
      <line x1="3" y1="29" x2="45" y2="29" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" />
      <rect x="4" y="22" width="6" height="7" fill="currentColor" fillOpacity="0.4" />
      <rect x="10" y="14" width="6" height="15" fill="currentColor" fillOpacity="0.55" />
      <rect x="16" y="7" width="6" height="22" fill="currentColor" fillOpacity="0.7" />
      <rect x="22" y="11" width="6" height="18" fill="currentColor" fillOpacity="0.65" />
      <rect x="28" y="17" width="6" height="12" fill="currentColor" fillOpacity="0.5" />
      <rect x="34" y="23" width="6" height="6" fill="currentColor" fillOpacity="0.35" />
      <rect x="40" y="26" width="4" height="3" fill="currentColor" fillOpacity="0.25" />
    </svg>
  )
}

const CHART_TEMPLATES: { label: string; icon: typeof TrendingUp; thumb: () => React.ReactElement; template: string }[] = [
  {
    label: 'Line chart', icon: TrendingUp, thumb: LineChartThumb,
    template: [
      'import matplotlib.pyplot as plt', '',
      '# --- Edit this data ---',
      'x = [1, 2, 3, 4, 5, 6]', 'y = [2, 5, 3, 8, 6, 9]',
      'x_label = "X Axis"', 'y_label = "Y Axis"', 'title = "Line Chart"', '',
      'plt.figure(figsize=(8, 5))',
      "plt.plot(x, y, marker='o', linewidth=2, color='steelblue')",
      'plt.xlabel(x_label)', 'plt.ylabel(y_label)', 'plt.title(title)',
      'plt.grid(True, alpha=0.3)', 'plt.tight_layout()', 'plt.show()',
    ].join('\n'),
  },
  {
    label: 'Bar chart', icon: BarChart2, thumb: BarChartThumb,
    template: [
      'import matplotlib.pyplot as plt', '',
      '# --- Edit this data ---',
      'categories = ["A", "B", "C", "D", "E"]', 'values = [4, 7, 3, 9, 5]',
      'x_label = "Category"', 'y_label = "Value"', 'title = "Bar Chart"', '',
      'plt.figure(figsize=(8, 5))',
      "plt.bar(categories, values, color='steelblue', edgecolor='white')",
      'plt.xlabel(x_label)', 'plt.ylabel(y_label)', 'plt.title(title)',
      'plt.tight_layout()', 'plt.show()',
    ].join('\n'),
  },
  {
    label: 'Scatter plot', icon: Atom, thumb: ScatterThumb,
    template: [
      'import matplotlib.pyplot as plt', '',
      '# --- Edit this data ---',
      'x = [1, 3, 2, 5, 4, 6, 3, 7]', 'y = [3, 7, 2, 8, 4, 6, 5, 9]',
      'x_label = "X Axis"', 'y_label = "Y Axis"', 'title = "Scatter Plot"', '',
      'plt.figure(figsize=(8, 5))',
      "plt.scatter(x, y, s=100, color='steelblue', alpha=0.7, edgecolors='white')",
      'plt.xlabel(x_label)', 'plt.ylabel(y_label)', 'plt.title(title)',
      'plt.grid(True, alpha=0.3)', 'plt.tight_layout()', 'plt.show()',
    ].join('\n'),
  },
  {
    label: 'Histogram', icon: LineChart, thumb: HistogramThumb,
    template: [
      'import matplotlib.pyplot as plt', '',
      '# --- Edit this data ---',
      'data = [2, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 7, 7, 8]',
      'bins = 8', 'x_label = "Value"', 'y_label = "Frequency"', 'title = "Histogram"', '',
      'plt.figure(figsize=(8, 5))',
      "plt.hist(data, bins=bins, color='steelblue', edgecolor='white')",
      'plt.xlabel(x_label)', 'plt.ylabel(y_label)', 'plt.title(title)',
      'plt.tight_layout()', 'plt.show()',
    ].join('\n'),
  },
]

export function NotebookPalette({ sectionId, assignmentId, onInsert }: Props) {
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return CELL_PALETTE
    return CELL_PALETTE.map((g) => ({
      ...g,
      items: g.items.filter(
        (i) => i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
      ),
    })).filter((g) => g.items.length > 0)
  }, [query])

  return (
    <aside className="hidden w-56 shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-card lg:flex">
      {/* Quick-insert grid */}
      <div className="border-b border-border p-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Quick insert</p>
        <div className="grid grid-cols-2 gap-1.5">
          <TablePicker onInsert={onInsert} />
          {QUICK_INSERT.map((q) => {
            const Icon = q.icon
            return (
              <button
                key={q.label}
                type="button"
                onClick={() => onInsert(q)}
                className="flex flex-col items-center gap-1 rounded-xl border border-border bg-background px-2 py-2.5 text-center transition-colors hover:border-primary hover:bg-accent"
              >
                <Icon className="h-4 w-4 text-muted-foreground" />
                <span className="text-[10px] leading-tight text-foreground">{q.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Charts */}
      <div className="border-b border-border p-3">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Charts</p>
        <div className="grid grid-cols-2 gap-1.5">
          {CHART_TEMPLATES.map((ct) => {
            const Thumb = ct.thumb
            return (
              <button
                key={ct.label}
                type="button"
                onClick={() => onInsert({ cellType: 'code', template: ct.template })}
                className="flex flex-col gap-1 rounded-xl border border-border bg-background px-2 pt-2 pb-2 text-left transition-colors hover:border-primary hover:bg-accent"
              >
                <div className="text-primary/70">
                  <Thumb />
                </div>
                <span className="text-[10px] font-medium leading-tight text-foreground">{ct.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Image upload */}
      <div className="border-b border-border p-3">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Image</p>
        <CellImageUploadButton
          sectionId={sectionId}
          assignmentId={assignmentId}
          onInserted={(markdown) => onInsert({ cellType: 'markdown', template: markdown })}
        />
      </div>

      {/* Search */}
      <div className="border-b border-border px-3 py-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search blocks…"
            className="h-8 pl-8 text-sm"
            aria-label="Search block types"
          />
        </div>
      </div>

      {/* Block groups */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {groups.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">No block types match.</p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mb-4 last:mb-0">
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      key={item.kind}
                      type="button"
                      onClick={() => onInsert(item)}
                      className="flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-accent"
                    >
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">{item.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
