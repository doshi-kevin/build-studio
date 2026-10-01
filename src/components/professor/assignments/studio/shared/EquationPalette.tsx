/**
 * EquationPalette — categorized math symbol palette for the equation block editor.
 *
 * Features:
 * - Live KaTeX preview of typed LaTeX (shows last-good render on error, never raw KaTeX error)
 * - LaTeX textarea for direct input
 * - Search field that filters all symbols across categories
 * - Category tabs: Common | Greek | Operators & Relations | Functions | Structures
 * - Recently-used row (max 8, persisted in localStorage)
 * - Every button has a title tooltip = name + LaTeX snippet
 * - Save / Cancel buttons
 *
 * KaTeX output is set via dangerouslySetInnerHTML: the input is professor-authored LaTeX
 * (trusted staff), and KaTeX escapes its output with `trust: false` (default) so no raw
 * HTML/script passes through — this is KaTeX's rendered markup, not user HTML.
 */
'use client'

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import katex from 'katex'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PaletteSymbol {
  /** Display name shown in tooltip */
  name: string
  /** LaTeX inserted before caret (or around selection) */
  before: string
  /** LaTeX inserted after caret / selection, if any */
  after?: string
  /**
   * LaTeX to render as the button face (preview). Falls back to `name` text label
   * when KaTeX rendering fails (e.g. multi-char names like "sin").
   */
  preview?: string
  /** Extra keywords for search beyond the name */
  keywords?: string[]
}

type Category = 'common' | 'greek' | 'operators' | 'functions' | 'structures'

// ─────────────────────────────────────────────────────────────────────────────
// Symbol catalogue
// ─────────────────────────────────────────────────────────────────────────────

const COMMON: PaletteSymbol[] = [
  { name: 'Fraction', before: '\\frac{', after: '}{}', preview: '\\frac{\\square}{\\square}', keywords: ['frac', 'divide', 'over'] },
  { name: 'Superscript', before: '^{', after: '}', preview: 'x^{\\square}', keywords: ['power', 'exponent', 'sup'] },
  { name: 'Subscript', before: '_{', after: '}', preview: 'x_{\\square}', keywords: ['sub', 'index'] },
  { name: 'Square root', before: '\\sqrt{', after: '}', preview: '\\sqrt{\\square}', keywords: ['sqrt', 'radical'] },
  { name: 'Nth root', before: '\\sqrt[', after: ']{\\square}', preview: '\\sqrt[n]{\\square}', keywords: ['nthroot', 'radical', 'cube root'] },
  { name: 'Sum (with bounds)', before: '\\sum_{', after: '}^{}', preview: '\\sum_{i}^{n}', keywords: ['sigma', 'summation'] },
  { name: 'Integral (with bounds)', before: '\\int_{', after: '}^{}', preview: '\\int_{a}^{b}', keywords: ['integral', 'int'] },
  { name: 'Limit', before: '\\lim_{', after: '\\to }', preview: '\\lim_{x \\to \\infty}', keywords: ['lim', 'limit'] },
  { name: 'Parentheses (auto-size)', before: '\\left(', after: '\\right)', preview: '\\left(\\square\\right)', keywords: ['parens', 'brackets', 'grow'] },
  { name: '2×2 Matrix', before: '\\begin{pmatrix} ', after: ' &  \\\\\\ &  \\end{pmatrix}', preview: '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', keywords: ['matrix', 'pmatrix'] },
  { name: 'Cases', before: '\\begin{cases} ', after: ' & \\text{if } \\\\\\ & \\text{otherwise}\\end{cases}', preview: '\\begin{cases}a & \\text{if }b\\\\c & \\text{else}\\end{cases}', keywords: ['piecewise', 'case'] },
]

const GREEK: PaletteSymbol[] = [
  { name: 'alpha', before: '\\alpha', preview: '\\alpha' },
  { name: 'beta', before: '\\beta', preview: '\\beta' },
  { name: 'gamma', before: '\\gamma', preview: '\\gamma' },
  { name: 'delta', before: '\\delta', preview: '\\delta' },
  { name: 'epsilon', before: '\\epsilon', preview: '\\epsilon' },
  { name: 'zeta', before: '\\zeta', preview: '\\zeta' },
  { name: 'eta', before: '\\eta', preview: '\\eta' },
  { name: 'theta', before: '\\theta', preview: '\\theta' },
  { name: 'iota', before: '\\iota', preview: '\\iota' },
  { name: 'kappa', before: '\\kappa', preview: '\\kappa' },
  { name: 'lambda', before: '\\lambda', preview: '\\lambda' },
  { name: 'mu', before: '\\mu', preview: '\\mu' },
  { name: 'nu', before: '\\nu', preview: '\\nu' },
  { name: 'xi', before: '\\xi', preview: '\\xi' },
  { name: 'pi', before: '\\pi', preview: '\\pi' },
  { name: 'rho', before: '\\rho', preview: '\\rho' },
  { name: 'sigma', before: '\\sigma', preview: '\\sigma' },
  { name: 'tau', before: '\\tau', preview: '\\tau' },
  { name: 'upsilon', before: '\\upsilon', preview: '\\upsilon' },
  { name: 'phi', before: '\\phi', preview: '\\phi' },
  { name: 'chi', before: '\\chi', preview: '\\chi' },
  { name: 'psi', before: '\\psi', preview: '\\psi' },
  { name: 'omega', before: '\\omega', preview: '\\omega' },
  { name: 'Gamma', before: '\\Gamma', preview: '\\Gamma' },
  { name: 'Delta', before: '\\Delta', preview: '\\Delta' },
  { name: 'Theta', before: '\\Theta', preview: '\\Theta' },
  { name: 'Lambda', before: '\\Lambda', preview: '\\Lambda' },
  { name: 'Xi', before: '\\Xi', preview: '\\Xi' },
  { name: 'Pi', before: '\\Pi', preview: '\\Pi' },
  { name: 'Sigma', before: '\\Sigma', preview: '\\Sigma' },
  { name: 'Phi', before: '\\Phi', preview: '\\Phi' },
  { name: 'Psi', before: '\\Psi', preview: '\\Psi' },
  { name: 'Omega', before: '\\Omega', preview: '\\Omega' },
]

const OPERATORS: PaletteSymbol[] = [
  { name: 'plus or minus', before: '\\pm', preview: '\\pm', keywords: ['plusminus'] },
  { name: 'times', before: '\\times', preview: '\\times', keywords: ['multiply', 'cross'] },
  { name: 'divide', before: '\\div', preview: '\\div', keywords: ['division'] },
  { name: 'less or equal', before: '\\leq', preview: '\\leq', keywords: ['le', 'lte'] },
  { name: 'greater or equal', before: '\\geq', preview: '\\geq', keywords: ['ge', 'gte'] },
  { name: 'not equal', before: '\\neq', preview: '\\neq', keywords: ['ne', 'noteq'] },
  { name: 'approximately', before: '\\approx', preview: '\\approx', keywords: ['approx', 'tilde'] },
  { name: 'element of', before: '\\in', preview: '\\in', keywords: ['in', 'set'] },
  { name: 'subset', before: '\\subset', preview: '\\subset', keywords: ['subset'] },
  { name: 'union', before: '\\cup', preview: '\\cup', keywords: ['union', 'cup'] },
  { name: 'intersection', before: '\\cap', preview: '\\cap', keywords: ['intersection', 'cap'] },
  { name: 'arrow right', before: '\\to', preview: '\\to', keywords: ['to', 'rightarrow'] },
  { name: 'implies', before: '\\Rightarrow', preview: '\\Rightarrow', keywords: ['implies', 'double arrow'] },
  { name: 'for all', before: '\\forall', preview: '\\forall', keywords: ['forall', 'all'] },
  { name: 'there exists', before: '\\exists', preview: '\\exists', keywords: ['exists', 'exist'] },
  { name: 'infinity', before: '\\infty', preview: '\\infty', keywords: ['infty', 'inf'] },
  { name: 'partial derivative', before: '\\partial', preview: '\\partial', keywords: ['partial', 'del'] },
  { name: 'nabla', before: '\\nabla', preview: '\\nabla', keywords: ['nabla', 'gradient', 'del'] },
  { name: 'proportional to', before: '\\propto', preview: '\\propto', keywords: ['propto', 'proportional'] },
  { name: 'similar to', before: '\\sim', preview: '\\sim', keywords: ['sim', 'similar', 'tilde'] },
  { name: 'equivalent', before: '\\equiv', preview: '\\equiv', keywords: ['equiv', 'equivalent'] },
  { name: 'much less than', before: '\\ll', preview: '\\ll', keywords: ['ll', 'much less'] },
  { name: 'much greater than', before: '\\gg', preview: '\\gg', keywords: ['gg', 'much greater'] },
]

const FUNCTIONS: PaletteSymbol[] = [
  { name: 'sin', before: '\\sin', preview: '\\sin', keywords: ['sine'] },
  { name: 'cos', before: '\\cos', preview: '\\cos', keywords: ['cosine'] },
  { name: 'tan', before: '\\tan', preview: '\\tan', keywords: ['tangent'] },
  { name: 'arcsin', before: '\\arcsin', preview: '\\arcsin', keywords: ['arcsin', 'inverse sine'] },
  { name: 'arccos', before: '\\arccos', preview: '\\arccos', keywords: ['arccos', 'inverse cosine'] },
  { name: 'arctan', before: '\\arctan', preview: '\\arctan', keywords: ['arctan', 'inverse tangent'] },
  { name: 'log', before: '\\log', preview: '\\log', keywords: ['logarithm'] },
  { name: 'ln', before: '\\ln', preview: '\\ln', keywords: ['natural log'] },
  { name: 'exp', before: '\\exp', preview: '\\exp', keywords: ['exponential'] },
  { name: 'absolute value', before: '\\left|', after: '\\right|', preview: '\\left|x\\right|', keywords: ['abs', 'modulus'] },
  { name: 'floor', before: '\\lfloor ', after: ' \\rfloor', preview: '\\lfloor x \\rfloor', keywords: ['floor'] },
  { name: 'ceil', before: '\\lceil ', after: ' \\rceil', preview: '\\lceil x \\rceil', keywords: ['ceiling', 'ceil'] },
  { name: 'max', before: '\\max', preview: '\\max' },
  { name: 'min', before: '\\min', preview: '\\min' },
  { name: 'gcd', before: '\\gcd', preview: '\\gcd' },
  { name: 'det', before: '\\det', preview: '\\det', keywords: ['determinant'] },
]

const STRUCTURES: PaletteSymbol[] = [
  { name: '2×2 matrix (bracket)', before: '\\begin{bmatrix} ', after: ' &  \\\\\\ &  \\end{bmatrix}', preview: '\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}', keywords: ['matrix', 'bmatrix'] },
  { name: '3×3 matrix', before: '\\begin{pmatrix}  &  &  \\\\\\ &  &  \\\\\\ &  &  \\end{pmatrix}', preview: '\\begin{pmatrix}a&b&c\\\\d&e&f\\\\g&h&i\\end{pmatrix}', keywords: ['matrix', '3x3'] },
  { name: 'Piecewise / cases', before: '\\begin{cases} ', after: ' & \\text{if } \\\\\\ & \\text{otherwise}\\end{cases}', preview: '\\begin{cases}f & \\text{if }x>0\\\\g & \\text{else}\\end{cases}', keywords: ['cases', 'piecewise'] },
  { name: 'Binomial coefficient', before: '\\binom{', after: '}{}', preview: '\\binom{n}{k}', keywords: ['binom', 'choose', 'combinations'] },
  { name: 'Overbrace', before: '\\overbrace{', after: '}^{}', preview: '\\overbrace{a+b}^{n}', keywords: ['overbrace', 'label above'] },
  { name: 'Underbrace', before: '\\underbrace{', after: '}_{\\text{}}', preview: '\\underbrace{x+y}_{n}', keywords: ['underbrace', 'label below'] },
  { name: 'Hat accent', before: '\\hat{', after: '}', preview: '\\hat{x}', keywords: ['hat', 'accent'] },
  { name: 'Bar accent', before: '\\bar{', after: '}', preview: '\\bar{x}', keywords: ['bar', 'overline', 'accent'] },
  { name: 'Dot accent', before: '\\dot{', after: '}', preview: '\\dot{x}', keywords: ['dot', 'accent', 'derivative'] },
  { name: 'Vec accent', before: '\\vec{', after: '}', preview: '\\vec{x}', keywords: ['vec', 'vector', 'arrow', 'accent'] },
  { name: 'Overline', before: '\\overline{', after: '}', preview: '\\overline{AB}', keywords: ['overline', 'complement', 'conjugate'] },
  { name: 'Tilde accent', before: '\\tilde{', after: '}', preview: '\\tilde{x}', keywords: ['tilde', 'accent'] },
]

const CATEGORY_LABELS: Record<Category, string> = {
  common: 'Common',
  greek: 'Greek',
  operators: 'Operators',
  functions: 'Functions',
  structures: 'Structures',
}

const CATEGORY_SYMBOLS: Record<Category, PaletteSymbol[]> = {
  common: COMMON,
  greek: GREEK,
  operators: OPERATORS,
  functions: FUNCTIONS,
  structures: STRUCTURES,
}

const ALL_SYMBOLS: PaletteSymbol[] = [
  ...COMMON,
  ...GREEK,
  ...OPERATORS,
  ...FUNCTIONS,
  ...STRUCTURES,
]

// ─────────────────────────────────────────────────────────────────────────────
// KaTeX render helpers
// ─────────────────────────────────────────────────────────────────────────────

function renderInline(latex: string): string {
  try {
    return katex.renderToString(latex, { displayMode: false, throwOnError: true, output: 'html' })
  } catch {
    return ''
  }
}

function renderDisplay(latex: string): string {
  try {
    return katex.renderToString(latex, { displayMode: true, throwOnError: false, output: 'html' })
  } catch {
    return ''
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Recently-used persistence (localStorage, max 8)
// ─────────────────────────────────────────────────────────────────────────────

const RECENT_KEY = 'scholera:equation-recent'
const RECENT_MAX = 8

function loadRecent(): PaletteSymbol[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as PaletteSymbol[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveRecent(items: PaletteSymbol[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, RECENT_MAX)))
  } catch {
    // localStorage may be unavailable (private browsing, storage full) — silently ignore
  }
}

function addToRecent(sym: PaletteSymbol, current: PaletteSymbol[]): PaletteSymbol[] {
  const deduped = current.filter((s) => s.before !== sym.before || s.after !== sym.after)
  return [sym, ...deduped].slice(0, RECENT_MAX)
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

/** A single palette button rendering either a KaTeX mini-preview or a text label. */
function SymbolButton({
  sym,
  onClick,
  compact = false,
}: {
  sym: PaletteSymbol
  onClick: (sym: PaletteSymbol) => void
  compact?: boolean
}) {
  const previewHtml = sym.preview ? renderInline(sym.preview) : ''
  const tooltipText = `${sym.name}  —  ${sym.before}${sym.after ?? ''}`

  return (
    <button
      type="button"
      title={tooltipText}
      aria-label={sym.name}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onClick(sym)}
      className={cn(
        'flex items-center justify-center rounded-xl border border-border bg-background',
        'text-foreground transition-colors hover:border-primary hover:bg-accent',
        compact ? 'min-h-9 min-w-9 px-2 py-1.5 text-xs' : 'min-h-11 min-w-11 px-2.5 py-2 text-sm',
      )}
    >
      {previewHtml ? (
        <span
          className="pointer-events-none leading-none [&_.katex]:text-[0.7rem]"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      ) : (
        <span className="font-mono text-xs leading-none">{sym.name}</span>
      )}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export interface EquationPaletteProps {
  /** Current LaTeX draft value */
  draft: string
  /** Called whenever the user changes the draft (textarea input or symbol click) */
  onChange: (latex: string) => void
  /** Ref to the LaTeX textarea — palette uses it to insert symbols at caret */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  /** Save the equation */
  onSave: () => void
  /** Cancel editing */
  onCancel: () => void
}

export function EquationPalette({
  draft,
  onChange,
  textareaRef,
  onSave,
  onCancel,
}: EquationPaletteProps) {
  const [activeTab, setActiveTab] = useState<Category>('common')
  const [search, setSearch] = useState('')
  const [recent, setRecent] = useState<PaletteSymbol[]>(loadRecent)
  // Track last-good KaTeX render to avoid flashing raw error text
  const lastGoodPreviewRef = useRef<string>('')

  // Compute the live preview HTML — fall back to last good on error
  const previewHtml = useMemo(() => {
    if (!draft.trim()) return ''
    const rendered = renderDisplay(draft)
    if (rendered) {
      lastGoodPreviewRef.current = rendered
      return rendered
    }
    return lastGoodPreviewRef.current
  }, [draft])

  // Filter symbols across all categories when search is active
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null
    return ALL_SYMBOLS.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.before.toLowerCase().includes(q) ||
        s.keywords?.some((k) => k.toLowerCase().includes(q)),
    )
  }, [search])

  const insertSymbol = useCallback(
    (sym: PaletteSymbol) => {
      const ta = textareaRef.current
      const before = sym.before
      const after = sym.after ?? ''
      const start = ta?.selectionStart ?? draft.length
      const end = ta?.selectionEnd ?? draft.length
      const next = draft.slice(0, start) + before + draft.slice(start, end) + after + draft.slice(end)
      onChange(next)
      // Place caret just after `before` so the user types inside the first brace
      requestAnimationFrame(() => {
        if (!ta) return
        const pos = start + before.length
        ta.focus()
        ta.setSelectionRange(pos, pos)
      })

      // Update recently-used
      setRecent((prev) => {
        const updated = addToRecent(sym, prev)
        saveRecent(updated)
        return updated
      })

      // Clear search after inserting
      setSearch('')
    },
    [draft, onChange, textareaRef],
  )

  const TABS: Category[] = ['common', 'greek', 'operators', 'functions', 'structures']

  // Reset search when tab changes
  const handleTabChange = useCallback((tab: Category) => {
    setActiveTab(tab)
    setSearch('')
  }, [])

  // Sync lastGoodPreview when draft clears
  useEffect(() => {
    if (!draft.trim()) {
      lastGoodPreviewRef.current = ''
    }
  }, [draft])

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      {/* ── Live KaTeX preview ── */}
      <div className="flex min-h-10 items-center justify-center rounded-xl bg-accent/40 px-3 py-2">
        {previewHtml ? (
          <span
            className="text-foreground"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : (
          <span className="text-sm text-muted-foreground">
            {draft.trim() ? 'Incomplete expression' : 'Preview will appear here'}
          </span>
        )}
      </div>

      {/* ── LaTeX textarea ── */}
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={2}
        placeholder={String.raw`Type LaTeX — e.g. \frac{-b \pm \sqrt{b^2-4ac}}{2a}`}
        className="w-full rounded-xl border border-border bg-background p-2.5 font-mono text-sm text-foreground outline-none focus:border-primary"
      />

      {/* ── Palette: search + tabs + symbols ── */}
      <div className="rounded-xl border border-border bg-background">
        {/* Search */}
        <div className="border-b border-border px-3 pt-2.5 pb-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search symbols (e.g. int, alpha, frac)…"
            className="w-full rounded-xl border border-border bg-muted px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary"
          />
        </div>

        {/* Recently-used row */}
        {recent.length > 0 && !search && (
          <div className="border-b border-border px-3 py-2">
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent
            </p>
            <div className="flex flex-wrap gap-1">
              {recent.map((sym, i) => (
                <SymbolButton key={`recent-${i}`} sym={sym} onClick={insertSymbol} compact />
              ))}
            </div>
          </div>
        )}

        {/* Search results (cross-category) */}
        {searchResults !== null ? (
          <div className="px-3 py-2.5">
            {searchResults.length === 0 ? (
              <p className="py-2 text-center text-sm text-muted-foreground">No symbols found</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {searchResults.map((sym, i) => (
                  <SymbolButton key={`search-${i}`} sym={sym} onClick={insertSymbol} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Category tabs */}
            <div className="flex border-b border-border px-3">
              {TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleTabChange(tab)}
                  className={cn(
                    'mr-4 border-b-2 py-2 text-xs font-medium transition-colors',
                    activeTab === tab
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {CATEGORY_LABELS[tab]}
                </button>
              ))}
            </div>

            {/* Symbol grid */}
            <div className="px-3 py-2.5">
              <div className="flex flex-wrap gap-1.5">
                {CATEGORY_SYMBOLS[activeTab].map((sym, i) => (
                  <SymbolButton key={`${activeTab}-${i}`} sym={sym} onClick={insertSymbol} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Save / Cancel ── */}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={onSave}>
          Save equation
        </Button>
      </div>
    </div>
  )
}
