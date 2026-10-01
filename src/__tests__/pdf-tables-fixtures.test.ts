// @vitest-environment node
//
// Integration test for the geometric table tier against REAL table PDFs (the
// camelot-py purpose-built suite, MIT — see fixtures/README.md). Unlike the
// synthetic-ruling-line unit tests in pdf-tables.test.ts, this runs the full
// extractPdf pipeline (pdfjs operator walk → detectTablesForPage) so we assert
// the actual end-to-end gate decision the worker sees: emit a $0 geometric
// table, or flag the page to the VLM (tableVisionPages).
//
// Assertions are pinned to OUR detector's measured behavior (§4 contract: trust
// only a CLEAN lattice grid, defer everything else to the VLM), which is
// stricter than camelot itself — e.g. we flag merged/rotated tables rather than
// risk a wrong grid.
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { extractPdf } from '@/lib/document-parser/pdf'

const DIR = path.resolve(process.cwd(), 'src/__tests__/fixtures/tables')
const has = (f: string) => existsSync(path.join(DIR, f))

// extractPdf only touches storage.from().upload()/getPublicUrl() — stub it so the
// test is offline and never hits Supabase.
const admin = {
  storage: {
    from: () => ({
      upload: async () => ({ error: null }),
      getPublicUrl: () => ({ data: { publicUrl: 'https://x.test/i.png' } }),
    }),
  },
} as unknown as SupabaseClient

async function run(file: string) {
  const buf = readFileSync(path.join(DIR, file))
  return extractPdf(buf, { sectionId: 's', moduleItemId: 'm', adminClient: admin })
}

describe('extractPdf — geometric table tier on real camelot PDFs', () => {
  it('emits a CLEAN ruled grid as a $0 geometric table, no VLM flag (foo.pdf → 7×7)', async () => {
    if (!has('foo.pdf')) return
    const r = await run('foo.pdf')
    expect(r.status).toBe('completed')
    expect(r.tables).toBeDefined()
    const t = r.tables!.find((x) => x.source === 'geometric')
    expect(t).toBeDefined()
    expect(t!.rows).toBe(7)
    expect(t!.cols).toBe(7)
    expect(t!.html).toContain('<table>')
    // a confidently-extracted ruled table is NOT sent to the VLM
    expect(r.tableVisionPages ?? []).not.toContain(1)
  }, 30000)

  it('extracts a borderless/ragged stream table when confident (stream_inner_outer_columns → 5×6)', async () => {
    if (!has('stream_inner_outer_columns.pdf')) return
    const r = await run('stream_inner_outer_columns.pdf')
    const t = (r.tables ?? []).find((x) => x.source === 'geometric')
    expect(t).toBeDefined()
    expect(t!.rows).toBe(5)
    expect(t!.cols).toBe(6)
  }, 30000)

  // The §4 contract: when Tier-0 can't be CONFIDENT, defer to the VLM rather than
  // emit a wrong grid. Each of these real cases trips that — merged headers,
  // rotation, background-fill rules, gappy cells — so the page is flagged, not
  // emitted as geometric.
  it.each([
    ['column_span_1.pdf', 'merged column header'],
    ['row_span_1.pdf', 'merged rows'],
    ['clockwise_table_1.pdf', 'rotated 90°'],
    ['background_lines_1.pdf', 'rules drawn as background fill'],
    ['missing_values.pdf', 'blank/gappy cells'],
  ])('flags %s to the VLM rather than trust a shaky grid (%s)', async (file) => {
    if (!has(file)) return
    const r = await run(file)
    expect(r.status).toBe('completed')
    // no geometric table emitted for these…
    expect((r.tables ?? []).some((x) => x.source === 'geometric')).toBe(false)
    // …instead the page is handed to the VLM
    expect(r.tableVisionPages).toBeDefined()
    expect(r.tableVisionPages).toContain(1)
  }, 30000)
})
