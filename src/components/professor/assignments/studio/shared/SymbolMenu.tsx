/**
 * Shared equation-builder dropdown: a small grid of common math symbols that insert
 * self-contained inline LaTeX. Used by the notebook ribbon and the verbal toolbar.
 */
'use client'

import { Calculator } from 'lucide-react'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from '@/components/ui/dropdown-menu'

export const SYMBOLS: Array<{ s: string; latex: string }> = [
  { s: '∑', latex: '\\sum' }, { s: '∫', latex: '\\int' }, { s: '√', latex: '\\sqrt{x}' }, { s: '∞', latex: '\\infty' },
  { s: 'π', latex: '\\pi' }, { s: 'θ', latex: '\\theta' }, { s: 'α', latex: '\\alpha' }, { s: 'β', latex: '\\beta' },
  { s: '≤', latex: '\\leq' }, { s: '≥', latex: '\\geq' }, { s: '≠', latex: '\\neq' }, { s: '≈', latex: '\\approx' },
  { s: '×', latex: '\\times' }, { s: '÷', latex: '\\div' }, { s: '±', latex: '\\pm' }, { s: '→', latex: '\\to' },
  { s: '·', latex: '\\cdot' }, { s: '∂', latex: '\\partial' }, { s: 'Δ', latex: '\\Delta' }, { s: '∇', latex: '\\nabla' },
]

/** Calls `onPick(latex)` for the chosen symbol; the caller decides how to insert it. */
export function SymbolMenu({ onPick }: { onPick: (latex: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Equation builder"
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Calculator className="h-3.5 w-3.5" />
          Symbols
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto p-2">
        <div className="grid grid-cols-5 gap-1">
          {SYMBOLS.map((sym) => (
            <button
              key={sym.latex}
              type="button"
              title={sym.latex}
              onClick={() => onPick(sym.latex)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-base hover:bg-muted"
            >
              {sym.s}
            </button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
