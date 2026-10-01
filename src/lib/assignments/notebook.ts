/**
 * Pure, I/O-free parser for viewing a submitted Jupyter notebook (`.ipynb`) in-app.
 *
 * A TS port of the researcher's `ipynb_parser.py`, trimmed to what a viewer needs: it
 * turns the raw notebook JSON into ordered cells + extracted outputs (text, images,
 * error tracebacks). VIEW-ONLY — nothing is executed, no grading is computed; cell
 * `role` is used only for labels. An `.ipynb` is fully attacker-controlled JSON, so:
 * malformed input returns `null` (the UI falls back to a download card), outputs are
 * size-capped, ANSI is stripped, and HTML/SVG outputs are surfaced as TEXT (never
 * rendered as markup) so they can't carry script. No Node deps → safe to run anywhere.
 */

export const NOTEBOOK_LIMITS = {
  /** Max cells we render (a hostile notebook can declare millions). */
  maxCells: 1000,
  /** Truncate a single text output at this many characters. */
  maxTextChars: 5000,
  /** Truncate an error traceback at this many characters. */
  maxErrorChars: 3000,
  /** Skip an embedded image whose base64 exceeds this length (~2.2 MB decoded). */
  maxImageBase64Chars: 3_000_000,
  /** Max outputs rendered per cell (a hostile cell can declare thousands). */
  maxOutputsPerCell: 50,
} as const

export type CellRole = 'instruction' | 'starter' | 'solution' | 'test' | 'unknown'

export type NotebookOutput =
  | { type: 'text'; subtype: string; content: string; truncated: boolean }
  | { type: 'image'; mime: string; dataBase64: string }
  | { type: 'error'; errorType: string; errorValue: string; traceback: string; truncated: boolean }

export interface NotebookNbgrader {
  gradeId?: string
  points?: number
  solution?: boolean
  grade?: boolean
  locked?: boolean
}

export interface NotebookCell {
  cellType: 'code' | 'markdown' | 'raw'
  role: CellRole
  source: string
  outputs: NotebookOutput[]
  executionCount: number | null
  nbgrader?: NotebookNbgrader
}

export interface ParsedNotebook {
  cells: NotebookCell[]
  meta: { language: string; kernel: string }
  /** True when the notebook had more than `maxCells` cells and was cut off. */
  truncated: boolean
}

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function joinSource(source: any): string {
  if (Array.isArray(source)) return source.join('')
  return typeof source === 'string' ? source : ''
}

function truncate(text: string, max: number): { content: string; truncated: boolean } {
  if (text.length <= max) return { content: text, truncated: false }
  return { content: text.slice(0, max) + '\n… [truncated]', truncated: true }
}

/** Remove ANSI escape sequences (colour codes) commonly found in tracebacks. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * Classify a cell's role from nbgrader metadata → inline markers → tags → heuristics.
 * Mirrors `ipynb_parser.classify_cell`; used only for display labels.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classifyCell(cell: any, source: string): CellRole {
  const ct = cell.cell_type
  const meta = cell.metadata ?? {}
  const nbg = meta.nbgrader ?? {}
  if (nbg && Object.keys(nbg).length > 0) {
    if (nbg.solution) return 'solution'
    if (nbg.grade) return 'test'
    if (nbg.locked) return ct === 'markdown' ? 'instruction' : 'starter'
  }

  const upper = source.toUpperCase()
  if (upper.includes('### BEGIN SOLUTION') || upper.includes('# BEGIN SOLUTION')) return 'solution'
  if (upper.includes('### BEGIN HIDDEN TESTS') || upper.includes('# BEGIN HIDDEN TESTS')) return 'test'
  if (upper.includes('=== BEGIN MARK SCHEME ===')) return 'test'

  const tags = new Set((Array.isArray(meta.tags) ? meta.tags : []).map((t: unknown) => String(t).toLowerCase()))
  if (tags.has('solution') || tags.has('answer')) return 'solution'
  if (tags.has('test') || tags.has('graded') || tags.has('autograder') || tags.has('hidden-tests')) return 'test'
  if (tags.has('starter') || tags.has('scaffold') || tags.has('template')) return 'starter'
  if (tags.has('instruction') || tags.has('readonly') || tags.has('read-only')) return 'instruction'

  if (ct === 'markdown') return 'instruction'
  if (ct === 'code') {
    if (source.includes('assert ') || source.includes('assert(') || /raise notimplementederror/i.test(source)) {
      return source.includes('raise NotImplementedError') ? 'starter' : 'test'
    }
    if (upper.includes('# TODO') || upper.includes('# YOUR CODE HERE')) return 'starter'
    const trimmed = source.trim()
    if (!trimmed || trimmed === 'pass' || trimmed === '# Your code here' || trimmed === '...') return 'starter'
  }
  return 'unknown'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractOutputs(rawOutputs: any[]): NotebookOutput[] {
  const outputs: NotebookOutput[] = []

  for (const out of rawOutputs.slice(0, NOTEBOOK_LIMITS.maxOutputsPerCell)) {
    const otype = out?.output_type

    if (otype === 'stream') {
      const { content, truncated } = truncate(joinSource(out.text), NOTEBOOK_LIMITS.maxTextChars)
      outputs.push({ type: 'text', subtype: `stream_${out.name ?? 'stdout'}`, content, truncated })
      continue
    }

    if (otype === 'execute_result' || otype === 'display_data') {
      const data = out.data ?? {}

      // Images first (raster only — SVG is rendered as text below to avoid script).
      for (const mime of IMAGE_MIMES) {
        if (data[mime]) {
          const base64 = joinSource(data[mime]).replace(/\s/g, '')
          if (base64.length > 0 && base64.length <= NOTEBOOK_LIMITS.maxImageBase64Chars) {
            outputs.push({ type: 'image', mime, dataBase64: base64 })
          } else {
            outputs.push({
              type: 'text',
              subtype: 'note',
              content: '[image output omitted — too large to preview]',
              truncated: false,
            })
          }
        }
      }

      // Best available text representation (plain > html > latex), shown as text.
      for (const textMime of ['text/plain', 'text/html', 'text/latex']) {
        if (data[textMime]) {
          const { content, truncated } = truncate(joinSource(data[textMime]), NOTEBOOK_LIMITS.maxTextChars)
          outputs.push({ type: 'text', subtype: textMime.replace('text/', ''), content, truncated })
          break
        }
      }
      continue
    }

    if (otype === 'error') {
      const traceback = stripAnsi(joinSource(out.traceback))
      const { content, truncated } = truncate(traceback, NOTEBOOK_LIMITS.maxErrorChars)
      outputs.push({
        type: 'error',
        errorType: String(out.ename ?? 'Error'),
        errorValue: String(out.evalue ?? ''),
        traceback: content,
        truncated,
      })
    }
  }

  return outputs
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readNbgrader(cell: any): NotebookNbgrader | undefined {
  const nbg = cell?.metadata?.nbgrader
  if (!nbg || typeof nbg !== 'object') return undefined
  const out: NotebookNbgrader = {}
  if (typeof nbg.grade_id === 'string') out.gradeId = nbg.grade_id
  if (typeof nbg.points === 'number') out.points = nbg.points
  if (typeof nbg.solution === 'boolean') out.solution = nbg.solution
  if (typeof nbg.grade === 'boolean') out.grade = nbg.grade
  if (typeof nbg.locked === 'boolean') out.locked = nbg.locked
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Parse raw `.ipynb` text into a viewer-ready notebook. Returns `null` if the text isn't
 * valid notebook JSON, so the caller can fall back to a plain download.
 */
export function parseNotebook(text: string): ParsedNotebook | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let nb: any
  try {
    nb = JSON.parse(text)
  } catch {
    return null
  }
  if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells)) return null

  const language: string =
    nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? 'python'
  const kernel: string = nb.metadata?.kernelspec?.display_name ?? 'unknown'

  const rawCells = nb.cells as unknown[]
  const truncated = rawCells.length > NOTEBOOK_LIMITS.maxCells

  const cells: NotebookCell[] = rawCells.slice(0, NOTEBOOK_LIMITS.maxCells).map((raw) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cell = raw as any
    const cellType: NotebookCell['cellType'] =
      cell.cell_type === 'code' || cell.cell_type === 'markdown' ? cell.cell_type : 'raw'
    const source = joinSource(cell.source)
    return {
      cellType,
      role: classifyCell(cell, source),
      source,
      outputs: Array.isArray(cell.outputs) ? extractOutputs(cell.outputs) : [],
      executionCount: typeof cell.execution_count === 'number' ? cell.execution_count : null,
      nbgrader: readNbgrader(cell),
    }
  })

  return { cells, meta: { language, kernel }, truncated }
}
