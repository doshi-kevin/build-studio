/**
 * ChartNode — a TipTap block node that embeds an editable chart (Recharts) in Scholera's colors.
 *
 * Types: line · bar · scatter · area · pie · radar. Editing uses an inline spreadsheet grid —
 * click a cell to focus, type to overwrite, Enter/Tab/arrows to navigate, Enter on last row appends.
 * Paste TSV/CSV from Excel/Sheets fills rows. Colors resolve from the live `--chart-1..5` theme
 * tokens at runtime (so they're never the broken black that `hsl(var(--oklch-token))` produced).
 * Config is JSON in `data-chart`.
 *
 * §3 Axis config: xLabel, yLabel, xMin, xMax, yMin, yMax, showGrid are optional on ChartConfig.
 * Rendered via Recharts domains, CartesianGrid, and Label on XAxis/YAxis.
 *
 * Equation layers: functions[] lets professors plot y = f(x) curves alongside data, using mathjs.
 * Solver plot: wolframImageUrl stores a Solver plot image fetched via generateSolverSolution.
 */
'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import {
  LineChart, Line, BarChart, Bar, ScatterChart, Scatter, AreaChart, Area,
  PieChart, Pie, RadarChart, Radar, PolarGrid, PolarAngleAxis, Cell, Legend,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Label,
} from 'recharts'
import { Trash2, LineChart as LineIcon, BarChart3, Dot, AreaChart as AreaIcon, PieChart as PieIcon, ChevronDown, ChevronUp, Loader2, Bot } from 'lucide-react'
import { compile, type EvalFunction } from 'mathjs'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { BlockChrome } from './shared/BlockChrome'
import type { BlockAlign } from './shared/BlockChrome'
import { toast } from 'sonner'
import { generateWolframSolution as generateSolverSolution } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'

// 'wolfram' value kept as-is for backward-compat with stored content
export type ChartType = 'line' | 'bar' | 'scatter' | 'area' | 'pie' | 'radar' | 'wolfram'
export interface ChartPoint { x: string; y: number }
export interface ChartFunction { expr: string; label?: string }
export interface ChartConfig {
  type: ChartType
  title: string
  points: ChartPoint[]
  // §3 Axis config
  xLabel?: string
  yLabel?: string
  xMin?: number
  xMax?: number
  yMin?: number
  yMax?: number
  showGrid?: boolean
  // Equation layers (cartesian types only)
  functions?: ChartFunction[]
  // Solver plot image
  wolframImageUrl?: string
}

const SAMPLE: Record<ChartType, ChartPoint[]> = {
  line: [{ x: '1', y: 2 }, { x: '2', y: 5 }, { x: '3', y: 3 }, { x: '4', y: 8 }, { x: '5', y: 6 }, { x: '6', y: 9 }],
  area: [{ x: '1', y: 2 }, { x: '2', y: 5 }, { x: '3', y: 3 }, { x: '4', y: 8 }, { x: '5', y: 6 }, { x: '6', y: 9 }],
  bar: [{ x: 'A', y: 4 }, { x: 'B', y: 7 }, { x: 'C', y: 3 }, { x: 'D', y: 9 }, { x: 'E', y: 5 }],
  scatter: [{ x: '1', y: 3 }, { x: '3', y: 7 }, { x: '2', y: 2 }, { x: '5', y: 8 }, { x: '4', y: 4 }, { x: '6', y: 6 }],
  pie: [{ x: 'Alpha', y: 40 }, { x: 'Beta', y: 25 }, { x: 'Gamma', y: 20 }, { x: 'Delta', y: 15 }],
  radar: [{ x: 'Speed', y: 7 }, { x: 'Power', y: 5 }, { x: 'Range', y: 8 }, { x: 'Cost', y: 4 }, { x: 'Ease', y: 6 }],
  wolfram: [],
}

export const CHART_DEFAULTS: Record<ChartType, ChartConfig> = {
  line: { type: 'line', title: 'Line chart', points: SAMPLE.line },
  bar: { type: 'bar', title: 'Bar chart', points: SAMPLE.bar },
  scatter: { type: 'scatter', title: 'Scatter plot', points: SAMPLE.scatter },
  area: { type: 'area', title: 'Area chart', points: SAMPLE.area },
  pie: { type: 'pie', title: 'Pie chart', points: SAMPLE.pie },
  radar: { type: 'radar', title: 'Radar chart', points: SAMPLE.radar },
  wolfram: { type: 'wolfram', title: 'Solver plot', points: [] },
}

const FALLBACK = ['#4b56d2', '#12a594', '#7c5cff', '#c08a2b', '#c0453b']

/** Resolve the Scholera chart tokens to concrete colors (var() won't resolve in SVG attrs). Read
 *  once via a lazy initializer — NodeViews mount client-side only, so the DOM is available. */
function useChartPalette(): string[] {
  const [palette] = useState<string[]>(() => {
    if (typeof document === 'undefined') return FALLBACK
    const s = getComputedStyle(document.documentElement)
    const c = [1, 2, 3, 4, 5].map((i) => s.getPropertyValue(`--chart-${i}`).trim()).filter(Boolean)
    return c.length ? c : FALLBACK
  })
  return palette
}

function parseConfig(raw: string): ChartConfig {
  try {
    const c = JSON.parse(raw) as ChartConfig
    if (!Array.isArray(c.points)) c.points = []
    if (!c.type) c.type = 'line'
    if (!Array.isArray(c.functions)) c.functions = undefined
    return c
  } catch {
    return CHART_DEFAULTS.line
  }
}

/** Sample a function expression across [lo, hi] with N points. Returns Recharts-ready rows. */
const FUNC_SAMPLES = 160
function sampleFunction(expr: string, lo: number, hi: number): { x: number; y: number }[] {
  let compiled: EvalFunction | null = null
  try { compiled = compile(expr) as EvalFunction } catch { return [] }
  if (!compiled) return []
  const step = (hi - lo) / (FUNC_SAMPLES - 1)
  const rows: { x: number; y: number }[] = []
  for (let i = 0; i < FUNC_SAMPLES; i++) {
    const x = lo + i * step
    try {
      const y = (compiled as EvalFunction).evaluate({ x })
      if (typeof y === 'number' && Number.isFinite(y)) {
        rows.push({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1e6) / 1e6 })
      }
    } catch { /* skip non-finite points */ }
  }
  return rows
}

const TYPES: { type: ChartType; label: string; icon: typeof LineIcon }[] = [
  { type: 'line', label: 'Line', icon: LineIcon },
  { type: 'bar', label: 'Bar', icon: BarChart3 },
  { type: 'area', label: 'Area', icon: AreaIcon },
  { type: 'scatter', label: 'Scatter', icon: Dot },
  { type: 'pie', label: 'Pie', icon: PieIcon },
  { type: 'wolfram', label: 'Equation', icon: Bot },
]

/** Cartesian types that support axis config */
const CARTESIAN_TYPES: ChartType[] = ['line', 'bar', 'scatter', 'area']

// ── Spreadsheet grid ─────────────────────────────────────────────────────────

interface GridCellProps {
  value: string
  isNumber?: boolean
  highlighted?: boolean
  onCommit: (v: string) => void
  onFocus: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onPaste?: (e: React.ClipboardEvent<HTMLInputElement>) => void
  inputRef?: React.Ref<HTMLInputElement>
}

function GridCell({ value, isNumber, highlighted, onCommit, onFocus, onKeyDown, onPaste, inputRef }: GridCellProps) {
  const [draft, setDraft] = useState(value)

  // Sync when value changes externally (e.g. paste fills a row)
  useEffect(() => { setDraft(value) }, [value])

  const handleBlur = () => {
    if (isNumber) {
      const n = Number(draft)
      onCommit(Number.isFinite(n) ? String(n) : String(value))
    } else {
      onCommit(draft)
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    if (isNumber) {
      // Allow partial numeric input (minus, decimal point)
      if (v === '' || v === '-' || v === '.' || v === '-.' || /^-?\d*\.?\d*$/.test(v)) {
        setDraft(v)
      }
    } else {
      setDraft(v)
    }
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode={isNumber ? 'decimal' : 'text'}
      value={draft}
      onChange={handleChange}
      onBlur={handleBlur}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      className={cn(
        'w-full border-0 bg-transparent px-2 py-1 text-xs outline-none',
        'focus:bg-accent/40 rounded',
        isNumber && 'tabular-nums text-right',
        highlighted && 'bg-accent/20',
      )}
    />
  )
}

interface SpreadsheetGridProps {
  points: ChartPoint[]
  highlightRow: number | null
  onHighlightRow: (i: number | null) => void
  onChange: (points: ChartPoint[]) => void
  xHeader?: string
  yHeader?: string
}

function SpreadsheetGrid({ points, highlightRow, onHighlightRow, onChange, xHeader = 'X (label)', yHeader = 'Y (value)' }: SpreadsheetGridProps) {
  // refs[row][col] — col 0 = X label, col 1 = Y value
  const refs = useRef<(HTMLInputElement | null)[][]>([])

  const focus = (row: number, col: number) => {
    refs.current[row]?.[col]?.focus()
  }

  const setCell = (i: number, field: 'x' | 'y', val: string) => {
    const next = points.map((p, idx) =>
      idx === i
        ? { ...p, [field]: field === 'y' ? (Number.isFinite(Number(val)) ? Number(val) : p.y) : val }
        : p,
    )
    onChange(next)
  }

  const appendRow = () => {
    const next = [...points, { x: `${points.length + 1}`, y: 0 }]
    onChange(next)
    // Focus new row's X cell after render
    setTimeout(() => focus(next.length - 1, 0), 16)
  }

  const deleteRow = (i: number) => {
    onChange(points.filter((_, idx) => idx !== i))
  }

  const insertAbove = (i: number) => {
    const next = [...points]
    next.splice(i, 0, { x: '', y: 0 })
    onChange(next)
    setTimeout(() => focus(i, 0), 16)
  }

  const makeKeyHandler = (row: number, col: number) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && col === 1)) {
      e.preventDefault()
      if (row === points.length - 1 && (e.key === 'Enter' || col === 1)) {
        // Last row: append
        appendRow()
      } else {
        focus(row + 1, col)
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (row > 0) focus(row - 1, col)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (col === 0) {
        focus(row, 1)
      } else {
        // col 1 → next row X
        if (row === points.length - 1) {
          appendRow()
        } else {
          focus(row + 1, 0)
        }
      }
    }
  }

  // Paste handler — accepts TSV or CSV, lands on col 0 of the focused row
  const makePasteHandler = (startRow: number) => (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (!text.includes('\n') && !text.includes('\t')) return // single cell, let default handle
    e.preventDefault()

    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    if (!lines.length) return

    const parsed: ChartPoint[] = lines.map((line) => {
      const sep = line.includes('\t') ? '\t' : ','
      const parts = line.split(sep)
      return { x: (parts[0] ?? '').trim(), y: Number((parts[1] ?? '0').trim()) || 0 }
    })

    // Overwrite from startRow, append beyond
    const next = [...points]
    parsed.forEach((p, i) => {
      if (startRow + i < next.length) {
        next[startRow + i] = p
      } else {
        next.push(p)
      }
    })
    onChange(next)
    toast.success(`${parsed.length} row${parsed.length === 1 ? '' : 's'} pasted`)
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[260px] border-collapse text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="py-1.5 pl-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{xHeader}</th>
            <th className="py-1.5 pr-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{yHeader}</th>
            <th className="w-8" aria-label="Row actions" />
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
              <tr
                key={i}
                onMouseEnter={() => onHighlightRow(i)}
                onMouseLeave={() => onHighlightRow(null)}
                className={cn(
                  'group border-b border-border/50 last:border-0 transition-colors',
                  highlightRow === i && 'bg-accent/10',
                )}
              >
                <td className="py-1.5 pl-1">
                  <GridCell
                    value={p.x}
                    highlighted={highlightRow === i}
                    onCommit={(v) => setCell(i, 'x', v)}
                    onFocus={() => onHighlightRow(i)}
                    onKeyDown={makeKeyHandler(i, 0)}
                    onPaste={makePasteHandler(i)}
                    inputRef={(el) => { if (!refs.current[i]) refs.current[i] = [null, null]; refs.current[i][0] = el }}
                  />
                </td>
                <td className="py-1.5 pr-1">
                  <GridCell
                    value={String(p.y)}
                    isNumber
                    highlighted={highlightRow === i}
                    onCommit={(v) => setCell(i, 'y', v)}
                    onFocus={() => onHighlightRow(i)}
                    onKeyDown={makeKeyHandler(i, 1)}
                    inputRef={(el) => { if (!refs.current[i]) refs.current[i] = [null, null]; refs.current[i][1] = el }}
                  />
                </td>
                <td className="w-8 py-1.5">
                  <div className="flex items-center justify-center gap-0 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => insertAbove(i)}
                      title="Insert row above"
                      className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    >
                      <ChevronUp className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteRow(i)}
                      title="Delete row"
                      className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </td>
              </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Axis config panel ────────────────────────────────────────────────────────

interface AxisConfigProps {
  cfg: ChartConfig
  onChange: (partial: Partial<ChartConfig>) => void
}

function AxisConfig({ cfg, onChange }: AxisConfigProps) {
  const autoX = cfg.xMin === undefined && cfg.xMax === undefined
  const autoY = cfg.yMin === undefined && cfg.yMax === undefined
  const [xAutoOn, setXAutoOn] = useState(autoX)
  const [yAutoOn, setYAutoOn] = useState(autoY)

  const handleXAutoChange = (checked: boolean) => {
    setXAutoOn(checked)
    if (checked) onChange({ xMin: undefined, xMax: undefined })
  }
  const handleYAutoChange = (checked: boolean) => {
    setYAutoOn(checked)
    if (checked) onChange({ yMin: undefined, yMax: undefined })
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Range &amp; grid</p>

      {/* X range */}
      <div className="flex items-center gap-2">
        <label className="w-14 text-[10px] text-muted-foreground">X range</label>
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            checked={xAutoOn}
            onChange={(e) => handleXAutoChange(e.target.checked)}
            className="h-3 w-3"
          />
          Auto
        </label>
        <Input
          type="number"
          value={xAutoOn ? '' : (cfg.xMin ?? '')}
          disabled={xAutoOn}
          onChange={(e) => onChange({ xMin: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="Min"
          className="h-7 w-20 text-xs disabled:opacity-40"
        />
        <Input
          type="number"
          value={xAutoOn ? '' : (cfg.xMax ?? '')}
          disabled={xAutoOn}
          onChange={(e) => onChange({ xMax: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="Max"
          className="h-7 w-20 text-xs disabled:opacity-40"
        />
      </div>

      {/* Y range */}
      <div className="flex items-center gap-2">
        <label className="w-14 text-[10px] text-muted-foreground">Y range</label>
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            checked={yAutoOn}
            onChange={(e) => handleYAutoChange(e.target.checked)}
            className="h-3 w-3"
          />
          Auto
        </label>
        <Input
          type="number"
          value={yAutoOn ? '' : (cfg.yMin ?? '')}
          disabled={yAutoOn}
          onChange={(e) => onChange({ yMin: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="Min"
          className="h-7 w-20 text-xs disabled:opacity-40"
        />
        <Input
          type="number"
          value={yAutoOn ? '' : (cfg.yMax ?? '')}
          disabled={yAutoOn}
          onChange={(e) => onChange({ yMax: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="Max"
          className="h-7 w-20 text-xs disabled:opacity-40"
        />
      </div>

      {/* Grid lines toggle */}
      <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <input
          type="checkbox"
          checked={cfg.showGrid ?? false}
          onChange={(e) => onChange({ showGrid: e.target.checked })}
          className="h-3 w-3"
        />
        Show grid lines
      </label>
    </div>
  )
}

// ── Chart renderer ────────────────────────────────────────────────────────────

function ChartRenderer({
  config, palette, highlightIndex, onPick,
}: {
  config: ChartConfig
  palette: string[]
  highlightIndex?: number | null
  onPick?: (index: number) => void
}) {
  const accent = palette[0]
  const data = config.points.map((p) => ({
    x: config.type === 'scatter' ? Number(p.x) || 0 : p.x,
    y: p.y,
  }))
  const pick = onPick ? (i: number | undefined) => { if (typeof i === 'number' && i >= 0) onPick(i) } : undefined
  const clickCursor = onPick ? { cursor: 'pointer' } : undefined

  const cartesianClick = pick
    ? (state: unknown) => pick((state as { activeTooltipIndex?: number } | null)?.activeTooltipIndex)
    : undefined

  // Build domain from axis config (undefined = Recharts auto)
  const xDomain: [number | string, number | string] | undefined =
    config.xMin !== undefined && config.xMax !== undefined
      ? [config.xMin, config.xMax]
      : undefined
  const yDomain: [number | string, number | string] | undefined =
    config.yMin !== undefined || config.yMax !== undefined
      ? [config.yMin ?? 'auto', config.yMax ?? 'auto']
      : undefined

  const grid = config.showGrid ? <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} /> : null
  const xAxisLabel = config.xLabel ? (
    <Label value={config.xLabel} offset={-4} position="insideBottom" style={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
  ) : null
  const yAxisLabel = config.yLabel ? (
    <Label value={config.yLabel} angle={-90} position="insideLeft" style={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
  ) : null

  // Dot style that highlights the hovered row's corresponding point
  const dotStyle = (index: number) => ({
    fill: accent,
    r: highlightIndex === index ? 6 : 4,
    strokeWidth: highlightIndex === index ? 2 : 0,
    stroke: 'hsl(var(--background))',
  })

  // Sampled function data for cartesian equation layers (palette offset by 1 so data series + functions don't collide)
  const isCartesianType = CARTESIAN_TYPES.includes(config.type)
  const fns = isCartesianType ? (config.functions ?? []) : []
  const xLo = config.xMin ?? -6
  const xHi = config.xMax ?? 6
  const sampledFns = useMemo(
    () => fns.map((f) => sampleFunction(f.expr, xLo, xHi)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fns.map((f) => f.expr).join('|'), xLo, xHi],
  )
  const hasFunctions = fns.length > 0 && isCartesianType

  // Function line elements to inject into cartesian charts
  const funcLines = fns.map((f, i) => (
    <Line
      key={`fn-${i}`}
      data={sampledFns[i]}
      type="monotone"
      dataKey="y"
      name={f.label ?? `f${i + 1}(x)`}
      stroke={palette[(i + 1) % palette.length]}
      strokeWidth={2}
      dot={false}
      isAnimationActive={false}
      connectNulls
    />
  ))

  // Solver-plot type: show the fetched image (or a prompt). Placed after the hooks above so hook
  // order stays stable across type switches.
  if (config.type === 'wolfram') {
    return config.wolframImageUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={config.wolframImageUrl} alt="Solver plot" className="mx-auto max-h-[280px] max-w-full rounded-xl border border-border bg-white" />
    ) : (
      <div className="flex h-[220px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        Enter a plot query below, then Fetch.
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={250}>
      {config.type === 'bar' ? (
        <BarChart data={data} margin={{ top: 6, right: 12, left: config.yLabel ? 16 : 0, bottom: config.xLabel ? 20 : 4 }} onClick={cartesianClick} style={clickCursor}>
          {grid}
          <XAxis dataKey="x" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} domain={xDomain}>{xAxisLabel}</XAxis>
          <YAxis hide={!config.yLabel} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} domain={yDomain} width={config.yLabel ? 40 : 0}>{yAxisLabel}</YAxis>
          <Tooltip />
          {hasFunctions && <Legend wrapperStyle={{ fontSize: 11 }} />}
          <Bar dataKey="y" radius={[6, 6, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={i} fill={highlightIndex === i ? palette[1] ?? accent : accent} />
            ))}
          </Bar>
          {funcLines}
        </BarChart>
      ) : config.type === 'scatter' ? (
        <ScatterChart margin={{ top: 6, right: 12, left: config.yLabel ? 16 : 0, bottom: config.xLabel ? 20 : 4 }} onClick={cartesianClick} style={clickCursor}>
          {grid}
          <XAxis dataKey="x" type="number" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} domain={xDomain}>{xAxisLabel}</XAxis>
          <YAxis dataKey="y" type="number" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} domain={yDomain} width={config.yLabel ? 40 : 8}>{yAxisLabel}</YAxis>
          <Tooltip cursor={{ strokeDasharray: '3 3' }} />
          {hasFunctions && <Legend wrapperStyle={{ fontSize: 11 }} />}
          <Scatter data={data} onClick={pick ? (_: unknown, i: number) => pick(i) : undefined}>
            {data.map((_, i) => (
              <Cell key={i} fill={highlightIndex === i ? palette[1] ?? accent : accent} />
            ))}
          </Scatter>
          {funcLines}
        </ScatterChart>
      ) : config.type === 'area' ? (
        <AreaChart data={data} margin={{ top: 6, right: 12, left: config.yLabel ? 16 : 0, bottom: config.xLabel ? 20 : 4 }} onClick={cartesianClick} style={clickCursor}>
          <defs>
            <linearGradient id="chart-area-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity={0.35} />
              <stop offset="100%" stopColor={accent} stopOpacity={0.04} />
            </linearGradient>
          </defs>
          {grid}
          <XAxis dataKey="x" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} domain={xDomain}>{xAxisLabel}</XAxis>
          <YAxis hide={!config.yLabel} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} domain={yDomain} width={config.yLabel ? 40 : 0}>{yAxisLabel}</YAxis>
          <Tooltip />
          {hasFunctions && <Legend wrapperStyle={{ fontSize: 11 }} />}
          <Area type="monotone" dataKey="y" stroke={accent} strokeWidth={2} fill="url(#chart-area-fill)"
            dot={(props: { index?: number; cx?: number; cy?: number }) => {
              const i = props.index ?? 0
              const style = dotStyle(i)
              return <circle key={i} cx={props.cx} cy={props.cy} r={style.r} fill={style.fill} stroke={style.stroke} strokeWidth={style.strokeWidth} />
            }}
          />
          {funcLines}
        </AreaChart>
      ) : config.type === 'pie' ? (
        <PieChart>
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Pie
            data={data}
            dataKey="y"
            nameKey="x"
            cx="50%"
            cy="50%"
            outerRadius={88}
            innerRadius={40}
            paddingAngle={2}
            onClick={pick ? (_: unknown, i: number) => pick(i) : undefined}
            style={clickCursor}
          >
            {data.map((_, i) => <Cell key={i} fill={palette[i % palette.length]} stroke={highlightIndex === i ? 'hsl(var(--foreground))' : 'none'} strokeWidth={highlightIndex === i ? 2 : 0} />)}
          </Pie>
        </PieChart>
      ) : config.type === 'radar' ? (
        <RadarChart data={data} onClick={cartesianClick} style={clickCursor}>
          <PolarGrid stroke="hsl(var(--border))" />
          <PolarAngleAxis dataKey="x" tick={{ fontSize: 11 }} />
          <Tooltip />
          <Radar dataKey="y" stroke={accent} fill={accent} fillOpacity={0.25} />
        </RadarChart>
      ) : (
        // line (default)
        <LineChart data={data} margin={{ top: 6, right: 12, left: config.yLabel ? 16 : 0, bottom: config.xLabel ? 20 : 4 }} onClick={cartesianClick} style={clickCursor}>
          {grid}
          <XAxis dataKey="x" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} domain={xDomain}>{xAxisLabel}</XAxis>
          <YAxis hide={!config.yLabel} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} domain={yDomain} width={config.yLabel ? 40 : 0}>{yAxisLabel}</YAxis>
          <Tooltip />
          {hasFunctions && <Legend wrapperStyle={{ fontSize: 11 }} />}
          <Line
            type="monotone"
            dataKey="y"
            stroke={accent}
            strokeWidth={2.5}
            dot={(props: { index?: number; cx?: number; cy?: number }) => {
              const i = props.index ?? 0
              const style = dotStyle(i)
              return <circle key={i} cx={props.cx} cy={props.cy} r={style.r} fill={style.fill} stroke={style.stroke} strokeWidth={style.strokeWidth} />
            }}
            activeDot={{ r: 6 }}
          />
          {funcLines}
        </LineChart>
      )}
    </ResponsiveContainer>
  )
}

// ── Solver plot panel ────────────────────────────────────────────────────────

interface SolverPlotPanelProps {
  imageUrl: string | undefined
  editor: NodeViewProps['editor']
  onImageUrl: (url: string | undefined) => void
}

function SolverPlotPanel({ imageUrl, editor, onImageUrl }: SolverPlotPanelProps) {
  const [query, setQuery] = useState('')
  const [running, setRunning] = useState(false)

  async function fetch() {
    const q = query.trim()
    if (!q) { toast.error('Enter a plot query first.'); return }
    const sectionId = (editor.storage.wolfram as { sectionId: string } | undefined)?.sectionId
    if (!sectionId) { toast.error('Reopen the document and try again.'); return }
    setRunning(true)
    const res = await generateSolverSolution(sectionId, 'plot', q)
    setRunning(false)
    if ('error' in res) { toast.error(res.error); return }
    if (res.imageUrl) onImageUrl(res.imageUrl)
    else toast.error('No plot image returned.')
  }

  return (
    <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Solver plot</p>
      {imageUrl ? (
        <div className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="Solver plot" className="w-full rounded-xl border border-border bg-white" />
          <button
            type="button"
            onClick={() => onImageUrl(undefined)}
            className="text-[11px] text-muted-foreground transition-colors hover:text-destructive"
          >
            Remove Solver plot
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void fetch() } }}
            placeholder="e.g. plot sin(x) from -pi to pi"
            className="h-7 text-xs"
          />
          <button
            type="button"
            onClick={() => void fetch()}
            disabled={running}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bot className="h-3 w-3" />}
            {running ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Node view ─────────────────────────────────────────────────────────────────

function ChartNodeView({ node, updateAttributes, deleteNode, getPos, selected, editor }: NodeViewProps) {
  const palette = useChartPalette()
  const [cfg, setCfg] = useState<ChartConfig>(() => parseConfig(node.attrs.data as string))
  const [highlightRow, setHighlightRow] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [axisOpen, setAxisOpen] = useState(false)
  const canEdit = editor.isEditable

  const width = (node.attrs.width as number | null) ?? 100
  const align = ((node.attrs.align as string | null) ?? 'center') as BlockAlign

  const write = useCallback((next: ChartConfig) => {
    setCfg(next)
    updateAttributes({ data: JSON.stringify(next) })
  }, [updateAttributes])

  const setType = (type: ChartType) => write({ ...cfg, type })
  const setTitle = (title: string) => write({ ...cfg, title })
  const setPoints = (points: ChartPoint[]) => write({ ...cfg, points })
  const patchAxis = (partial: Partial<ChartConfig>) => write({ ...cfg, ...partial })
  const setSolverImageUrl = (wolframImageUrl: string | undefined) => write({ ...cfg, wolframImageUrl })

  const handleDuplicate = useCallback(() => {
    if (typeof getPos !== 'function') return
    editor.chain().insertContentAt(getPos() + node.nodeSize, node.toJSON()).run()
  }, [editor, getPos, node])

  // Clicking a point on the chart focuses that grid row's X cell
  const handleChartPick = (index: number) => {
    setHighlightRow(index)
    if (!editing) setEditing(true)
  }

  const isCartesian = CARTESIAN_TYPES.includes(cfg.type)
  const isSolver = cfg.type === 'wolfram'
  const isPie = cfg.type === 'pie'

  return (
    <NodeViewWrapper>
      <BlockChrome
        editor={editor}
        selected={selected}
        onEdit={() => setEditing(true)}
        onDelete={deleteNode}
        onDuplicate={handleDuplicate}
        editLabel="Edit chart"
        align={align}
        onAlign={(a) => updateAttributes({ align: a })}
        width={width}
        onResize={(pct) => updateAttributes({ width: pct })}
      >
        {cfg.title && <p className="mb-2 text-center text-sm font-medium text-foreground">{cfg.title}</p>}

        <ChartRenderer
          config={cfg}
          palette={palette}
          highlightIndex={highlightRow}
          onPick={canEdit ? handleChartPick : undefined}
        />

        {editing && canEdit && (
          <div className="mt-4 space-y-4 border-t border-border pt-4">
            {/* Type switcher */}
            <div className="flex flex-wrap items-center gap-1.5">
              {TYPES.map(({ type, label, icon: Icon }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setType(type)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                    cfg.type === type ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:bg-accent',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>

            {/* Title input */}
            <Input
              value={cfg.title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Chart title"
              className="h-8 text-xs"
            />

            {isSolver ? (
              /* Solver-plot type: a query + fetch (no grid / axes) */
              <SolverPlotPanel
                imageUrl={cfg.wolframImageUrl}
                editor={editor}
                onImageUrl={setSolverImageUrl}
              />
            ) : (
              <>
                {/* X / Y axis labels — cartesian only */}
                {isCartesian && (
                  <div className="flex items-center gap-2">
                    <Input
                      value={cfg.xLabel ?? ''}
                      onChange={(e) => patchAxis({ xLabel: e.target.value || undefined })}
                      placeholder="X axis label"
                      className="h-8 text-xs"
                    />
                    <Input
                      value={cfg.yLabel ?? ''}
                      onChange={(e) => patchAxis({ yLabel: e.target.value || undefined })}
                      placeholder="Y axis label"
                      className="h-8 text-xs"
                    />
                  </div>
                )}

                {/* Data grid — pie uses Category / Value headers */}
                <SpreadsheetGrid
                  points={cfg.points}
                  highlightRow={highlightRow}
                  onHighlightRow={setHighlightRow}
                  onChange={setPoints}
                  xHeader={isPie ? 'Category' : 'X (label)'}
                  yHeader={isPie ? 'Value' : 'Y (value)'}
                />
                <p className="text-[10px] text-muted-foreground">
                  Enter or arrow-down on the last row adds a row. Tab moves across. Hover a row to insert or delete.
                </p>

                {/* Range & grid (cartesian only) */}
                {isCartesian && (
                  <>
                    <button
                      type="button"
                      onClick={() => setAxisOpen((v) => !v)}
                      className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {axisOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      Range &amp; grid
                    </button>
                    {axisOpen && <AxisConfig cfg={cfg} onChange={patchAxis} />}
                  </>
                )}
              </>
            )}

            <div className="flex items-center justify-end pt-1">
              <Button
                type="button"
                size="sm"
                onClick={() => { setEditing(false); setHighlightRow(null); setAxisOpen(false) }}
              >
                Done
              </Button>
            </div>
          </div>
        )}
      </BlockChrome>
    </NodeViewWrapper>
  )
}

export const ChartNode = Node.create({
  name: 'chart',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      data: {
        default: JSON.stringify(CHART_DEFAULTS.line),
        parseHTML: (el) => el.getAttribute('data-chart') ?? JSON.stringify(CHART_DEFAULTS.line),
        renderHTML: (attrs) => ({ 'data-chart': attrs.data as string }),
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
  parseHTML() { return [{ tag: 'div[data-chart]' }] },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes({ 'data-chart': '' }, HTMLAttributes)] },
  addNodeView() { return ReactNodeViewRenderer(ChartNodeView) },
})
