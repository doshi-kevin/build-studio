/**
 * SolverPanel: the "Solver" tool in the studio side toolkit (maths/physics templates only).
 *
 * Type an expression, pick a tool → the server action calls Wolfram|Alpha (AppID stays
 * server-side) and the result is rendered HERE in the panel first (text in a box, images via a
 * plain <img> so they always show). The professor then chooses whether to add it to the selected
 * cell, and/or keep it in that cell's answer key. Nothing is inserted automatically.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Equal, ListChecks, Wand2, Atom, LineChart, ImageIcon, Loader2, Plus, KeyRound, X, type LucideIcon, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StudioMarkdown } from './StudioMarkdown'
// Backend keeps the Wolfram names (the actual Wolfram|Alpha integration); the UI calls it "Solver".
import { generateWolframSolution as generateSolverSolution } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import type { WolframTool as SolverTool } from '@/lib/wolfram/client'

interface ToolDef {
  tool: SolverTool
  label: string
  icon: LucideIcon
  hint: string
}

const TOOLS: ToolDef[] = [
  { tool: 'solve', label: 'Answer', icon: Equal, hint: 'One-line final answer' },
  { tool: 'worked', label: 'Worked solution', icon: ListChecks, hint: 'Readable step-by-step-style solution' },
  { tool: 'simplify', label: 'Simplify', icon: Wand2, hint: 'Simplified / alternate form' },
  { tool: 'physics', label: 'Physics', icon: Atom, hint: 'Quantity with units + equation' },
  { tool: 'plot', label: 'Plot', icon: LineChart, hint: 'Graph image' },
  { tool: 'snapshot', label: 'Result image', icon: ImageIcon, hint: 'Result rendered as an image' },
]

interface Result { def: ToolDef; text?: string; markdown?: string; imageUrl?: string }

/** The result formatted as markdown to append to a cell body. */
function toCellMarkdown(r: Result): string {
  if (r.imageUrl) return `\n\n![Solver — ${r.def.label}](${r.imageUrl})\n`
  if (r.markdown) return `\n\n**Solver — ${r.def.label}**\n\n${r.markdown}\n`
  return `\n\n**Solver — ${r.def.label}**\n\n\`\`\`\n${(r.text ?? '').trim()}\n\`\`\`\n`
}

/** The result for the answer key (professor-only text). */
function toAnswerKeyText(r: Result): string {
  return (r.markdown ?? r.text ?? '').trim()
}

interface Props {
  sectionId: string
  hasSelectedCell: boolean
  onAddToCell: (markdown: string) => void
  onAddToAnswerKey: (text: string) => void
  /** The word for where the result is inserted ("block" for the notebook, "document" for the doc). */
  targetNoun?: string
  /** Whether this surface has a professor-only answer-key store. Off for the document studio, whose
   *  single body is student-visible — showing it there would leak the solution into the assignment. */
  showAnswerKey?: boolean
}

export function SolverPanel({
  sectionId, hasSelectedCell, onAddToCell, onAddToAnswerKey, targetNoun = 'block', showAnswerKey = true,
}: Props) {
  const [query, setQuery] = useState('')
  const [running, setRunning] = useState<SolverTool | null>(null)
  const [result, setResult] = useState<Result | null>(null)

  async function run(def: ToolDef) {
    const q = query.trim()
    if (!q) {
      toast.error('Type an expression or question first.')
      return
    }
    setRunning(def.tool)
    const res = await generateSolverSolution(sectionId, def.tool, q)
    setRunning(null)
    if ('error' in res) {
      toast.error(res.error)
      return
    }
    setResult({ def, text: res.text, markdown: res.markdown, imageUrl: res.imageUrl })
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Bot className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">Solver</span>
      </div>
      <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
        Generate a maths/physics solution, then add it to the {targetNoun}{showAnswerKey ? ' or its answer key' : ''}.
      </p>

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="e.g. solve x^2-5x+6=0"
        className="h-8 text-sm"
        onKeyDown={(e) => { if (e.key === 'Enter') run(TOOLS[0]) }}
      />

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {TOOLS.map((def) => {
          const Icon = def.icon
          const busy = running === def.tool
          return (
            <Button
              key={def.tool}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto min-w-0 justify-start gap-1.5 px-2 py-1.5 text-xs"
              disabled={running !== null}
              onClick={() => run(def)}
              title={def.hint}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Icon className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate">{def.label}</span>
            </Button>
          )
        })}
      </div>

      {result && (
        <div className="mt-3 space-y-2 rounded-xl border border-border bg-background p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{result.def.label}</span>
            <button
              type="button"
              onClick={() => setResult(null)}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear result"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {result.imageUrl ? (
            // Plain <img> so the result always renders in the panel (no markdown pipeline).
            // eslint-disable-next-line @next/next/no-img-element
            <img src={result.imageUrl} alt={`${result.def.label} result`} className="max-w-full rounded-lg border border-border bg-white" />
          ) : result.markdown ? (
            <div className="max-h-72 overflow-auto">
              <StudioMarkdown content={result.markdown} />
            </div>
          ) : (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs text-foreground">{result.text}</pre>
          )}

          {!hasSelectedCell && (
            <p className="text-[11px] text-muted-foreground">Select a {targetNoun} to add this result.</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              disabled={!hasSelectedCell}
              onClick={() => { onAddToCell(toCellMarkdown(result)); toast.success(`Added to the ${targetNoun}`) }}
            >
              <Plus className="h-3.5 w-3.5" /> Add to {targetNoun}
            </Button>
            {showAnswerKey && !result.imageUrl && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                disabled={!hasSelectedCell}
                onClick={() => { onAddToAnswerKey(toAnswerKeyText(result)); toast.success('Saved to the answer key') }}
              >
                <KeyRound className="h-3.5 w-3.5" /> Save to answer key
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
