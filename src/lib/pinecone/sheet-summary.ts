/**
 * What a spreadsheet contributes to the vector index.
 *
 * A workbook is usually a dataset, not a lecture, and the two obvious ways to
 * index one are both wrong. Rendering it to page images means converting a
 * 50,000-row sheet into hundreds of pictures of number grids — minutes of
 * rendering, an embedding bill per page, and vectors that describe the shape of
 * a table rather than any idea, so they match queries weakly and at random.
 * Embedding the full text is the same problem without the pictures.
 *
 * What actually carries meaning in a sheet is its HEADERS — "student_id",
 * "perplexity", "epoch", "held-out loss" — plus enough example rows to show
 * what the columns hold. That is also what every tool that puts tabular data in
 * front of a model does: `df.head()` shows 5 rows, text-to-SQL prompting
 * (Spider, DIN-SQL) ships the schema plus ~3 sample rows, and dataframe agents
 * show a handful. So we take the header and a few rows, once per sheet, and
 * stop.
 *
 * The result is one small text vector per worksheet instead of hundreds of
 * image vectors per workbook, and it is the part a student could actually ask
 * about ("what columns are in the results file?").
 */

import 'server-only'

/**
 * Data rows kept after the header. Five is `df.head()`'s default and the most
 * common choice in tabular-RAG prompting; three (the text-to-SQL convention) is
 * too few to show a column's range, and more mostly adds digits.
 */
export const SHEET_SAMPLE_ROWS = 5

/** Columns kept per row — wide sheets are usually wide with data, not meaning. */
export const SHEET_MAX_COLS = 20

/** Characters per cell, so one essay-in-a-cell can't dominate the vector. */
const MAX_CELL_CHARS = 120

/** A worksheet as the extractor stores it: an HTML table plus its sheet name. */
export interface SheetTable {
  pageNumber: number
  html: string
  heading?: string | null
}

/** Strip tags and entities from one HTML cell. */
function cellText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CELL_CHARS)
}

/**
 * Header + first N rows of one worksheet, as compact text.
 *
 * Pure and exported so the sampling is testable without a workbook: the whole
 * decision this module makes is "which cells", and it should not need an
 * embedding call to check.
 */
export function summarizeSheet(table: SheetTable, sampleRows = SHEET_SAMPLE_ROWS): string {
  const rows = [...table.html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) =>
      [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
        .map((c) => cellText(c[1]))
        .slice(0, SHEET_MAX_COLS),
    )
    .filter((cells) => cells.some((c) => c.length > 0))

  if (rows.length === 0) return ''

  const [header, ...body] = rows
  const kept = body.slice(0, sampleRows)
  const lines = [
    table.heading ? `Sheet: ${table.heading}` : `Sheet ${table.pageNumber}`,
    `Columns: ${header.join(' | ')}`,
    ...kept.map((r) => r.join(' | ')),
  ]
  // Say what was left out. Without this the vector — and any answer grounded on
  // it — reads as if the sheet has five rows, and "how many students are in the
  // results file" would be answered confidently and wrongly.
  if (body.length > kept.length) {
    lines.push(`… ${body.length - kept.length} more rows not shown`)
  }
  return lines.join('\n')
}

/** Spreadsheets we summarize instead of rendering. `.xls` stays out for the
 *  same reason it stayed out of the converter: a CVE-dense legacy parser for a
 *  format nobody uploads. */
const SHEET_EXTS = new Set(['xlsx'])

/** Is this material a spreadsheet — indexed as sampled text, never as pages? */
export function isSpreadsheetSource(filePath: string): boolean {
  return SHEET_EXTS.has(filePath.toLowerCase().split('.').pop() ?? '')
}
