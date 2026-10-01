/**
 * Canonical, editable in-app notebook model + lossless `.ipynb` parser/serializer.
 *
 * This is the KEYSTONE of the notebook studio. Unlike the view-only `lib/assignments/
 * notebook.ts` (which truncates outputs for safe display and is intentionally lossy),
 * this model preserves everything needed to round-trip a real notebook:
 *   parse(serialize(parse(x)))  deep-equals  parse(x)        // idempotent
 *   serialize(parse(x))         is valid nbformat 4 JSON
 *
 * We NEVER execute anything — `outputs` are stored verbatim and re-emitted untouched.
 * Source is normalised to a single string in-model (easy to edit) and split back into
 * Jupyter's line-array form on serialize, so `join(split(s)) === s` exactly.
 */

export type StudioCellType = 'code' | 'markdown' | 'raw'

export interface StudioCell {
  /** Stable id — preserved from nbformat 4.5 `id`, or generated when absent. */
  id: string
  cell_type: StudioCellType
  /** Whole-cell source as one editable string. */
  source: string
  /** Full nbformat cell metadata (tags, nbgrader, jupyter.*, editable/deletable…). */
  metadata: Record<string, unknown>
  /** Raw nbformat outputs (code cells only). Stored verbatim — never executed by us. */
  outputs: unknown[]
  execution_count: number | null
}

export interface StudioNotebook {
  cells: StudioCell[]
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

/** Shape we serialize to (a valid nbformat-4 notebook file). */
export interface IpynbFile {
  cells: Array<Record<string, unknown>>
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Jupyter stores `source`/`text` as a string or an array of lines — collapse to one string. */
export function joinSource(source: unknown): string {
  if (Array.isArray(source)) return source.join('')
  return typeof source === 'string' ? source : ''
}

/**
 * Split a string into Jupyter's line-array form: each element keeps its trailing `\n`
 * except a final line with no newline. Guarantees `splitSource(s).join('') === s`.
 */
export function splitSource(s: string): string[] {
  if (s === '') return []
  return s.match(/[^\n]*\n|[^\n]+/g) ?? []
}

/** Short, collision-resistant cell id (nbformat ids are arbitrary ≤64-char strings). */
export function genCellId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid.replace(/-/g, '').slice(0, 12)
  // Fallback for environments without Web Crypto.
  return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
}

/**
 * Parse raw `.ipynb` text (or an already-parsed object) into the editable model.
 * Returns `null` on anything that isn't a notebook, so callers can fall back.
 */
export function parseNotebookModel(input: string | unknown): StudioNotebook | null {
  let nb: unknown
  if (typeof input === 'string') {
    try {
      nb = JSON.parse(input)
    } catch {
      return null
    }
  } else {
    nb = input
  }
  if (!isObject(nb) || !Array.isArray(nb.cells)) return null

  const nbformat = typeof nb.nbformat === 'number' ? nb.nbformat : 4
  let nbformat_minor = typeof nb.nbformat_minor === 'number' ? nb.nbformat_minor : 5
  const metadata = isObject(nb.metadata) ? nb.metadata : {}

  let generatedAnyId = false
  const cells: StudioCell[] = (nb.cells as unknown[]).map((raw) => {
    const c = isObject(raw) ? raw : {}
    const cell_type: StudioCellType =
      c.cell_type === 'code' || c.cell_type === 'markdown' ? c.cell_type : 'raw'

    let id = typeof c.id === 'string' && c.id.length > 0 ? c.id : ''
    if (!id) {
      id = genCellId()
      generatedAnyId = true
    }

    const isCode = cell_type === 'code'
    return {
      id,
      cell_type,
      source: joinSource(c.source),
      metadata: isObject(c.metadata) ? c.metadata : {},
      outputs: isCode && Array.isArray(c.outputs) ? (c.outputs as unknown[]) : [],
      execution_count: isCode && typeof c.execution_count === 'number' ? c.execution_count : null,
    }
  })

  // We always emit ids (Jupyter itself adds them on save); cell ids landed in 4.5.
  if (generatedAnyId && nbformat_minor < 5) nbformat_minor = 5

  return { cells, metadata, nbformat, nbformat_minor }
}

/** Serialize the model to an nbformat-4 notebook object. */
export function serializeNotebookModel(nb: StudioNotebook): IpynbFile {
  return {
    cells: nb.cells.map((c) => {
      const cell: Record<string, unknown> = {
        cell_type: c.cell_type,
        id: c.id,
        metadata: c.metadata,
        source: splitSource(c.source),
      }
      if (c.cell_type === 'code') {
        cell.outputs = c.outputs
        cell.execution_count = c.execution_count
      }
      return cell
    }),
    metadata: nb.metadata,
    nbformat: nb.nbformat,
    nbformat_minor: nb.nbformat_minor,
  }
}

/** Serialize to `.ipynb` text (Jupyter writes indent=1 with a trailing newline). */
export function serializeNotebookJson(nb: StudioNotebook): string {
  return JSON.stringify(serializeNotebookModel(nb), null, 1) + '\n'
}

/** A fresh, empty notebook with a Python kernelspec (so a download opens as Python). */
export function emptyNotebook(): StudioNotebook {
  return {
    cells: [],
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3 (ipykernel)', language: 'python' },
      language_info: { name: 'python', version: '3.11' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }
}
