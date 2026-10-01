// Non-AI DOCX extractor (Phase 5). A .docx is OOXML like .pptx — a ZIP of XML
// read with fflate + the shared ooxml walker. We pull the deliverables that
// matter for the tutor and citations, all deterministic ($0, source 'native'):
//   • text + headings: word/document.xml paragraphs (w:p / w:t, w:pStyle)
//   • tables: w:tbl → HTML (gridSpan → colspan; vMerge continuation cells dropped)
//   • figures: author alt-text (wp:docPr@descr) as native figure descriptions
//
// Word has no reliable page structure in document.xml, so everything is page 1.
// Image binaries aren't uploaded in v1 (the tutor-facing value is text + tables
// + alt-text); the VLM tier can still describe rendered figures later.

import { unzipSync } from 'fflate'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type {
  ExtractionResultData,
  ExtractedTableData,
  ExtractedFigureData,
  ExtractedChartData,
  ExtractionPageData,
} from '@/lib/validations/document-extraction'
import { parseXml, findAll, findFirst, childrenNamed, textOf, rowsToHtmlTable, chartDataFromPart } from './ooxml'

export interface ExtractDocxOptions {
  sectionId: string
  moduleItemId: string
  // Accepted for dispatcher signature parity with the PDF/PPTX extractors; the
  // DOCX path doesn't write to Storage in v1.
  adminClient?: SupabaseClient
  storageBucket?: string
}

export type ExtractDocxResult = ExtractionResultData

export async function extractDocx(buffer: Buffer, opts: ExtractDocxOptions): Promise<ExtractDocxResult> {
  const startedAt = Date.now()
  const failed = (msg: string): ExtractDocxResult => ({
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

  let xml: string
  let zip: ReturnType<typeof unzipSync>
  try {
    zip = unzipSync(new Uint8Array(buffer))
    const doc = zip['word/document.xml']
    if (!doc) return failed('word/document.xml missing')
    xml = new TextDecoder('utf-8').decode(doc)
  } catch (err) {
    logger.error('extractDocx: unzip failed', err, { moduleItemId: opts.moduleItemId })
    return failed(err instanceof Error ? err.message : 'Unzip failed')
  }

  let root
  try {
    root = parseXml(xml)
  } catch (err) {
    return failed(err instanceof Error ? err.message : 'XML parse failed')
  }

  // Text + headings: one block of text per paragraph, in document order.
  const paragraphs = findAll(root, 'p').filter((n) => n.prefix === 'w')
  const lines: string[] = []
  const headings: string[] = []
  for (const p of paragraphs) {
    const text = textOf(p).replace(/\s+/g, ' ').trim()
    if (!text) continue
    lines.push(text)
    const styleVal = findFirst(p, 'pStyle')?.attrs['w:val'] ?? ''
    if (/heading/i.test(styleVal)) headings.push(text)
  }
  const bodyText = lines.join('\n')
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length

  // Native tables. DOCX merges differ from PPTX: colspan is <w:gridSpan w:val>,
  // a vertical merge is <w:vMerge> (continuation cells have no/!='restart' val).
  const tables: ExtractedTableData[] = []
  for (const tbl of findAll(root, 'tbl').filter((n) => n.prefix === 'w')) {
    const grid = findFirst(tbl, 'tblGrid')
    const cols = grid ? findAll(grid, 'gridCol').filter((n) => n.prefix === 'w').length : 0
    const trs = childrenNamed(tbl, 'tr')
    if (trs.length === 0) continue
    const html = rowsToHtmlTable(trs, 'tc', (tc) => {
      const gridSpan = findFirst(tc, 'gridSpan')?.attrs['w:val']
      const vMerge = findFirst(tc, 'vMerge')
      return {
        colSpan: Number(gridSpan ?? '1'),
        skip: !!vMerge && (vMerge.attrs['w:val'] ?? 'continue') !== 'restart',
      }
    })
    tables.push({ pageNumber: 1, html, rows: trs.length, cols, source: 'native' })
  }

  // Author alt-text on drawings → native figure descriptions.
  const figures: ExtractedFigureData[] = []
  for (const docPr of findAll(root, 'docPr')) {
    const descr = docPr.attrs.descr?.trim()
    if (descr) figures.push({ pageNumber: 1, description: descr, source: 'native' })
  }

  // Native chart DATA from word/charts/chartN.xml (same parser as PPTX/XLSX).
  // Word has no page structure, so charts anchor to page 1 like its tables.
  const charts: ExtractedChartData[] = []
  for (const path of Object.keys(zip).filter((k) => /^word\/charts\/chart\d+\.xml$/.test(k))) {
    try {
      const cd = chartDataFromPart(parseXml(new TextDecoder('utf-8').decode(zip[path])))
      if (cd) charts.push({ pageNumber: 1, title: cd.title, data: cd.data, source: 'native' })
    } catch (err) {
      logger.warn('extractDocx: chart parse failed, skipping', {
        moduleItemId: opts.moduleItemId,
        path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const pages: ExtractionPageData[] = [{ pageNumber: 1, text: bodyText, headings }]

  return {
    status: 'completed',
    extractedAt: new Date(startedAt).toISOString(),
    error: null,
    metadata: { pageCount: 1, wordCount, formulaCount: 0 },
    pages,
    tables: tables.length > 0 ? tables : undefined,
    figures: figures.length > 0 ? figures : undefined,
    charts: charts.length > 0 ? charts : undefined,
    textStatus: 'completed',
    imagesStatus: 'completed',
    formulasStatus: 'skipped',
    tablesStatus: 'completed',
  }
}
