// Non-AI XLSX extractor (Phase 5b). A .xlsx is OOXML like .pptx/.docx — a ZIP of
// XML read with fflate + the shared ooxml walker. Two deterministic deliverables,
// both byte-exact ($0, source 'native'):
//   • tables: each worksheet IS a table — sheetData rows/cells → HTML. Shared
//     strings are resolved from xl/sharedStrings.xml; one sheet = one page.
//   • charts: the series DATA behind each chart (xl/charts/chartN.xml → c:ser →
//     c:cat/c:val numCache/strCache) as CSV, NOT a picture. This is what the quiz
//     generator can build questions from; describing pixels can't answer them.
//
// No VLM, no Storage write (the deliverable is data, not rendered images).

import { unzipSync } from 'fflate'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type {
  ExtractionResultData,
  ExtractedTableData,
  ExtractedChartData,
  ExtractionPageData,
} from '@/lib/validations/document-extraction'
import {
  parseXml,
  findAll,
  findFirst,
  childrenNamed,
  textOf,
  escapeHtml,
  chartDataFromPart,
  seriesToChart,
  type XmlNode,
  type ChartSeries,
} from './ooxml'

export interface ExtractXlsxOptions {
  sectionId: string
  moduleItemId: string
  // Accepted for dispatcher signature parity with the other extractors; XLSX
  // doesn't write to Storage in v1.
  adminClient?: SupabaseClient
  storageBucket?: string
}

export type ExtractXlsxResult = ExtractionResultData

// Guardrails: a worksheet can be enormous (100k rows). Cap the grid we
// materialize so one giant sheet can't blow the JSONB row / worker memory.
const MAX_ROWS = 500
const MAX_COLS = 50

// Cap on cells resolved from a chart formula ref (CWE-400 guard, mirrors the
// chart-point cap in ooxml).
const MAX_REF_CELLS = 4096

// ── Cell address ⇄ column index ────────────────────────────────
// "B3" → column "B" → 1 (0-based). Spreadsheet columns are bijective base-26.
function colIndexFromRef(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0]
  if (!letters) return 0
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** Inverse of colIndexFromRef: 0 → "A", 26 → "AA". */
function colName(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// ── Shared strings ─────────────────────────────────────────────
// xl/sharedStrings.xml is an array of <si>; a cell with t="s" stores the index.
function parseSharedStrings(xml: string): string[] {
  const root = parseXml(xml)
  return findAll(root, 'si').map((si) => textOf(si))
}

// ── Worksheet → HTML table + cell map ──────────────────────────
// Returns the HTML table (the visible grid, capped at MAX_ROWS×MAX_COLS) AND a
// cellRef→value map ("A2" → "1200") used to resolve chart formula refs that
// carry no cached values.
interface ParsedSheet {
  table: ExtractedTableData | null
  cells: Map<string, string>
}

function parseSheet(xml: string, sharedStrings: string[], pageNumber: number): ParsedSheet {
  const root = parseXml(xml)
  const cells = new Map<string, string>()
  const rowNodes = findAll(root, 'row')
  if (rowNodes.length === 0) return { table: null, cells }

  // Materialize a sparse grid: rowsOut[r][c] = cell text. Empty cells stay ''.
  const rowsOut: string[][] = []
  let maxCol = 0
  for (const row of rowNodes.slice(0, MAX_ROWS)) {
    const arr: string[] = []
    for (const c of childrenNamed(row, 'c')) {
      const ref = (c.attrs.r ?? '').toUpperCase()
      const col = colIndexFromRef(ref)
      const val = cellValue(c, sharedStrings)
      if (ref && col < MAX_REF_CELLS) cells.set(ref, val) // for chart-ref resolution
      if (col < MAX_COLS) {
        arr[col] = val
        if (col > maxCol) maxCol = col
      }
    }
    rowsOut.push(arr)
  }
  if (maxCol === 0 && rowsOut.every((r) => r.length === 0)) return { table: null, cells }

  const cols = maxCol + 1
  const trs: string[] = []
  for (const arr of rowsOut) {
    const tds: string[] = []
    for (let c = 0; c < cols; c++) tds.push(`<td>${escapeHtml(arr[c] ?? '')}</td>`)
    trs.push(`<tr>${tds.join('')}</tr>`)
  }
  const html = `<table>${trs.join('')}</table>`
  return { table: { pageNumber, html, rows: rowsOut.length, cols, source: 'native' }, cells }
}

// ── Sheet-name → worksheet-file map (workbook.xml + rels) ───────
// Chart formula refs name a sheet ('Enrollment'!A2:A6), so we resolve sheet
// names via workbook.xml's <sheet name r:id> against workbook.xml.rels, rather
// than guessing from the sheetN.xml filename (which need not match display order).
function sheetFileByName(zip: Record<string, Uint8Array>, decoder: TextDecoder): Map<string, string> {
  const out = new Map<string, string>()
  const wb = zip['xl/workbook.xml']
  const rels = zip['xl/_rels/workbook.xml.rels']
  if (!wb || !rels) return out
  const fileByRid = new Map<string, string>()
  for (const rel of findAll(parseXml(decoder.decode(rels)), 'Relationship')) {
    const id = rel.attrs.Id
    const target = rel.attrs.Target
    if (!id || !target) continue
    fileByRid.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
  }
  for (const sh of findAll(parseXml(decoder.decode(wb)), 'sheet')) {
    const name = sh.attrs.name
    const rid = sh.attrs['r:id'] ?? sh.attrs.id
    const file = rid ? fileByRid.get(rid) : undefined
    if (name && file) out.set(name, file)
  }
  return out
}

// ── Chart formula-ref resolution (no cache → read the sheet) ────
/** The `<c:f>` formula text under a cat/val/tx node, e.g. "'Sheet1'!$A$2:$A$6". */
function refFormula(parent: XmlNode | undefined): string {
  if (!parent) return ''
  const f = findFirst(parent, 'f')
  return f ? textOf(f).trim() : ''
}

/** Resolve a chart ref ("'Enrollment'!$A$2:$A$6" / "Sheet1!B1") to cell values. */
function resolveRef(formula: string, sheets: Map<string, Map<string, string>>): string[] {
  const bang = formula.lastIndexOf('!')
  if (bang < 0) return []
  const sheetName = formula.slice(0, bang).trim().replace(/^'(.*)'$/, '$1').replace(/''/g, "'")
  const cells = sheets.get(sheetName)
  if (!cells) return []
  const range = formula.slice(bang + 1).replace(/\$/g, '').toUpperCase()
  const [a, b] = range.split(':')
  const pa = a?.match(/^([A-Z]+)(\d+)$/)
  if (!pa) return []
  if (!b) return [cells.get(a) ?? '']
  const pb = b.match(/^([A-Z]+)(\d+)$/)
  if (!pb) return []
  const c0 = colIndexFromRef(pa[1])
  const c1 = colIndexFromRef(pb[1])
  const r0 = Number(pa[2])
  const r1 = Number(pb[2])
  const out: string[] = []
  for (let r = Math.min(r0, r1); r <= Math.max(r0, r1) && out.length < MAX_REF_CELLS; r++) {
    for (let c = Math.min(c0, c1); c <= Math.max(c0, c1) && out.length < MAX_REF_CELLS; c++) {
      out.push(cells.get(`${colName(c)}${r}`) ?? '')
    }
  }
  return out
}

/** Build a chart from formula refs resolved against the workbook's sheets. */
function chartFromRefs(root: XmlNode, sheets: Map<string, Map<string, string>>): { title?: string; data: string } | null {
  const sers = findAll(root, 'ser')
  if (sers.length === 0) return null
  let categories: string[] = []
  const series: ChartSeries[] = []
  for (const ser of sers) {
    const cat = resolveRef(refFormula(findFirst(ser, 'cat')), sheets)
    if (cat.length > categories.length) categories = cat
    const values = resolveRef(refFormula(findFirst(ser, 'val')), sheets)
    const name = resolveRef(refFormula(findFirst(ser, 'tx')), sheets)[0] || `series${series.length + 1}`
    series.push({ name, values })
  }
  return seriesToChart(root, categories, series)
}

function cellValue(c: XmlNode, sharedStrings: string[]): string {
  const type = c.attrs.t
  if (type === 'inlineStr') {
    return textOf(findFirst(c, 'is') ?? c).replace(/\s+/g, ' ').trim()
  }
  const v = findFirst(c, 'v')
  const raw = v ? textOf(v).trim() : ''
  if (type === 's') {
    const idx = Number(raw)
    return sharedStrings[idx] ?? ''
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE'
  return raw // numeric, formula-string result, date serial, etc.
}

// Chart series → exact (label,value) CSV is parsed by the shared
// `chartDataFromPart` (./ooxml) — the same parser PPTX/DOCX use.

// ── Main extractor ─────────────────────────────────────────────

export async function extractXlsx(buffer: Buffer, opts: ExtractXlsxOptions): Promise<ExtractXlsxResult> {
  const startedAt = Date.now()
  const failed = (msg: string): ExtractXlsxResult => ({
    status: 'failed',
    extractedAt: new Date(startedAt).toISOString(),
    error: msg,
    metadata: { pageCount: 0, wordCount: 0 },
    pages: [],
    textStatus: 'failed',
    imagesStatus: 'failed',
    formulasStatus: 'failed',
    tablesStatus: 'failed',
  })

  let zip
  try {
    zip = unzipSync(new Uint8Array(buffer))
  } catch (err) {
    logger.error('extractXlsx: unzip failed', err, { moduleItemId: opts.moduleItemId })
    return failed(err instanceof Error ? err.message : 'Unzip failed')
  }

  const decoder = new TextDecoder('utf-8')
  const sharedStrings = zip['xl/sharedStrings.xml']
    ? parseSharedStrings(decoder.decode(zip['xl/sharedStrings.xml']))
    : []

  // Worksheets in numeric order — sheet1.xml → page 1, sheet2.xml → page 2, …
  const sheetPaths = Object.keys(zip)
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/sheet(\d+)/)![1]) - Number(b.match(/sheet(\d+)/)![1]))
  if (sheetPaths.length === 0) return failed('no worksheets found')

  // sheet display-name → its cell map, for resolving chart formula refs.
  const fileByName = sheetFileByName(zip, decoder)
  const nameByFile = new Map<string, string>()
  for (const [name, file] of fileByName) nameByFile.set(file, name)

  const tables: ExtractedTableData[] = []
  const pages: ExtractionPageData[] = []
  const cellsByName = new Map<string, Map<string, string>>()
  sheetPaths.forEach((path, i) => {
    const pageNumber = i + 1
    pages.push({ pageNumber, text: '', headings: [] })
    try {
      const { table, cells } = parseSheet(decoder.decode(zip[path]), sharedStrings, pageNumber)
      if (table) tables.push(table)
      cellsByName.set(nameByFile.get(path) ?? `Sheet${pageNumber}`, cells)
    } catch (err) {
      logger.warn('extractXlsx: sheet parse failed, skipping', {
        moduleItemId: opts.moduleItemId,
        path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // Charts live in xl/charts/chartN.xml. Prefer cached values (numCache/strCache);
  // fall back to resolving formula refs against the sheets (openpyxl and friends
  // write only `<c:f>` refs, no cache). Charts anchor to page 1 — resolving the
  // sheet they're drawn on is a multi-hop the data doesn't need.
  const charts: ExtractedChartData[] = []
  for (const path of Object.keys(zip).filter((k) => /^xl\/charts\/chart\d+\.xml$/.test(k))) {
    try {
      const root = parseXml(decoder.decode(zip[path]))
      const cd = chartDataFromPart(root) ?? chartFromRefs(root, cellsByName)
      if (cd) charts.push({ pageNumber: 1, title: cd.title, data: cd.data, source: 'native' })
    } catch (err) {
      logger.warn('extractXlsx: chart parse failed, skipping', {
        moduleItemId: opts.moduleItemId,
        path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    status: 'completed',
    extractedAt: new Date(startedAt).toISOString(),
    error: null,
    metadata: { pageCount: sheetPaths.length, wordCount: 0, formulaCount: 0 },
    pages,
    tables: tables.length > 0 ? tables : undefined,
    charts: charts.length > 0 ? charts : undefined,
    textStatus: 'completed',
    imagesStatus: 'skipped',
    formulasStatus: 'skipped',
    tablesStatus: 'completed',
  }
}
