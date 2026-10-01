// Visual assets: the extracted figures/charts/tables a generated quiz question
// or AI-tutor answer can SHOW (as a rendered crop of the source page), not just
// cite. See docs/designs/quizzes/hybrid-extraction-and-citation.md §16.
//
// An asset is addressed by (kind, page, idx) where idx is the unit's position
// within its kind's array filtered to that page — stable for a given stored
// extraction. The model only ever references IDs we handed it; every reference
// is re-resolved against the stored extraction before anything renders.

import type { ExtractionBbox } from '@/lib/validations/document-extraction'
import type { ExtractionUnitsForLLM } from '@/lib/document-parser'

export const ASSET_KINDS = ['table', 'chart', 'figure'] as const
export type AssetKind = (typeof ASSET_KINDS)[number]

export interface AssetUnit {
  kind: AssetKind
  page: number
  /** Index within this kind on this page (extraction array order). */
  idx: number
  bbox?: ExtractionBbox
  /** What the model reasons about: figure description, chart title+data, table HTML. */
  text: string
}

// The stored extraction JSONB, loosely typed — callers read it straight off
// module_items.content and the in-memory parse result.
interface ExtractionLike {
  tables?: Array<{ pageNumber: number; html: string; bbox?: ExtractionBbox }>
  charts?: Array<{ pageNumber: number; title?: string; data: string; bbox?: ExtractionBbox }>
  figures?: Array<{ pageNumber: number; description: string; bbox?: ExtractionBbox }>
  code?: Array<{ pageNumber: number; code: string; language?: string }>
}

/** All visual assets in an extraction, in canonical (kind, array) order.
 *  Only kinds the model can reason about as text are eligible — figures carry
 *  a description, charts their data series, tables their cells. */
export function listAssetUnits(extraction: ExtractionLike): AssetUnit[] {
  const units: AssetUnit[] = []
  const idxByPage = new Map<string, number>()
  const next = (kind: AssetKind, page: number): number => {
    const key = `${kind}:${page}`
    const idx = idxByPage.get(key) ?? 0
    idxByPage.set(key, idx + 1)
    return idx
  }
  for (const t of extraction.tables ?? []) {
    units.push({ kind: 'table', page: t.pageNumber, idx: next('table', t.pageNumber), bbox: t.bbox, text: t.html })
  }
  for (const c of extraction.charts ?? []) {
    units.push({ kind: 'chart', page: c.pageNumber, idx: next('chart', c.pageNumber), bbox: c.bbox, text: c.data })
  }
  for (const f of extraction.figures ?? []) {
    units.push({ kind: 'figure', page: f.pageNumber, idx: next('figure', f.pageNumber), bbox: f.bbox, text: f.description })
  }
  return units
}

/** Resolve an asset address against the stored extraction. Null if it doesn't
 *  exist — a hallucinated reference must never render anything. */
export function findAssetUnit(
  extraction: ExtractionLike,
  kind: AssetKind,
  page: number,
  idx: number,
): AssetUnit | null {
  return (
    listAssetUnits(extraction).find((u) => u.kind === kind && u.page === page && u.idx === idx) ?? null
  )
}

/**
 * Build the `units` argument for getExtractionContextForLLM, attaching an
 * asset ID (from `idFor`) to each visual unit so its context block is tagged
 * `[ASSET <id>]`. `idFor` returning null leaves the unit untagged (still
 * useful as plain context). Code units carry no asset IDs — they already
 * render as text.
 */
export function buildUnitsForLLM(
  extraction: ExtractionLike,
  idFor?: (unit: AssetUnit) => string | null,
): ExtractionUnitsForLLM {
  // listAssetUnits pushes each kind in extraction-array order, so the i-th
  // unit of a kind corresponds to the i-th element of that kind's array.
  const units = listAssetUnits(extraction)
  const byKind = (kind: AssetKind) => units.filter((u) => u.kind === kind)
  const id = (u: AssetUnit) => idFor?.(u) ?? undefined

  const tables = byKind('table')
  const charts = byKind('chart')
  const figures = byKind('figure')

  return {
    tables: extraction.tables?.map((t, i) => ({ pageNumber: t.pageNumber, html: t.html, assetId: id(tables[i]) })),
    charts: extraction.charts?.map((c, i) => ({ pageNumber: c.pageNumber, title: c.title, data: c.data, assetId: id(charts[i]) })),
    figures: extraction.figures?.map((f, i) => ({ pageNumber: f.pageNumber, description: f.description, assetId: id(figures[i]) })),
    code: extraction.code,
  }
}

// ── Durable asset refs (AI tutor) ────────────────────────────────
// The tutor embeds visuals as `![caption](asset://<itemId>:<kind>:<page>:<idx>)`
// in its markdown; the ref must survive in the stored message and resolve at
// render time, so it carries the module item ID.

const ASSET_REF_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(table|chart|figure):(\d{1,4}):(\d{1,3})$/i

export function formatAssetRef(itemId: string, unit: Pick<AssetUnit, 'kind' | 'page' | 'idx'>): string {
  return `${itemId}:${unit.kind}:${unit.page}:${unit.idx}`
}

export function parseAssetRef(
  ref: string,
): { itemId: string; kind: AssetKind; page: number; idx: number } | null {
  const m = ASSET_REF_RE.exec(ref)
  if (!m) return null
  return { itemId: m[1], kind: m[2].toLowerCase() as AssetKind, page: Number(m[3]), idx: Number(m[4]) }
}
