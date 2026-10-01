// Non-AI PPTX extractor. A .pptx is a zip of XML — we can unzip it
// with fflate (already installed) and pull the three deliverables
// directly without any parser library:
//   • text: concatenate <a:t> runs in slide order
//   • images: `ppt/media/` contains native PNG/JPEG/etc already encoded
//   • formulas: `<m:oMath>` nodes preserve Office Math Markup Language
//     which maps deterministically to LaTeX via a small walker
//
// A 30-slide 6 MB deck processes in ~30 ms (experiment 15). We keep
// this path deliberately simple and deterministic — the vision
// pipeline (PR 4) picks up anything that's rendered as an image
// instead of preserved as OMML.

import { unzipSync, type Unzipped } from 'fflate'
import type { SupabaseClient } from '@supabase/supabase-js'

import { createAdminClient } from '@/lib/supabase/admin'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { logger } from '@/lib/logger'
import type {
  ExtractionResultData,
  ExtractedImageData,
  ExtractedFormulaData,
  ExtractedTableData,
  ExtractedCodeData,
  ExtractedChartData,
  ExtractedFigureData,
  ExtractionPageData,
} from '@/lib/validations/document-extraction'
import {
  type XmlNode,
  parseXml,
  findAll,
  findFirst,
  childrenNamed,
  textOf,
  rowsToHtmlTable,
  chartDataFromPart,
  looksLikeCode,
  guessCodeLanguage,
} from './ooxml'

// ── Types ──────────────────────────────────────────────────────

export interface ExtractPptxOptions {
  sectionId: string
  moduleItemId: string
  adminClient?: SupabaseClient
  storageBucket?: string
}

export type ExtractPptxResult = ExtractionResultData

// The XML walker + table-HTML helpers are shared across OOXML formats — see
// ./ooxml (parseXml/findAll/findFirst/textOf/rowsToHtmlTable, imported above).

// ── OMML → LaTeX ───────────────────────────────────────────────
// The full OMML spec is large; we cover the structures that
// typically appear in lecture slides. Anything we don't recognise
// is rendered as plain concatenated text — the vision fallback in
// PR 4 can still produce a LaTeX version from the slide image.

function ommlToLatex(node: XmlNode): string {
  if (node.local === 't') {
    return textOf(node)
  }
  if (node.local === 'r') {
    // Run: concatenate text children
    const parts: string[] = []
    for (const c of node.children) {
      if (typeof c === 'string') parts.push(c)
      else parts.push(ommlToLatex(c))
    }
    return parts.join('')
  }
  if (node.local === 'f') {
    // fraction: <m:f><m:num>..</m:num><m:den>..</m:den></m:f>
    const num = findFirst(node, 'num')
    const den = findFirst(node, 'den')
    return `\\frac{${num ? ommlChildren(num) : ''}}{${den ? ommlChildren(den) : ''}}`
  }
  if (node.local === 'sSub') {
    // subscript: <m:sSub><m:e>base</m:e><m:sub>sub</m:sub></m:sSub>
    const base = findFirst(node, 'e')
    const sub = findFirst(node, 'sub')
    return `{${base ? ommlChildren(base) : ''}}_{${sub ? ommlChildren(sub) : ''}}`
  }
  if (node.local === 'sSup') {
    const base = findFirst(node, 'e')
    const sup = findFirst(node, 'sup')
    return `{${base ? ommlChildren(base) : ''}}^{${sup ? ommlChildren(sup) : ''}}`
  }
  if (node.local === 'sSubSup') {
    const base = findFirst(node, 'e')
    const sub = findFirst(node, 'sub')
    const sup = findFirst(node, 'sup')
    return `{${base ? ommlChildren(base) : ''}}_{${sub ? ommlChildren(sub) : ''}}^{${sup ? ommlChildren(sup) : ''}}`
  }
  if (node.local === 'rad') {
    const deg = findFirst(node, 'deg')
    const e = findFirst(node, 'e')
    const inside = e ? ommlChildren(e) : ''
    const d = deg ? ommlChildren(deg) : ''
    return d ? `\\sqrt[${d}]{${inside}}` : `\\sqrt{${inside}}`
  }
  if (node.local === 'nary') {
    // n-ary: integrals, sums, products. <m:naryPr><m:chr val="∑"/></m:naryPr>
    const pr = findFirst(node, 'naryPr')
    const chr = pr ? findFirst(pr, 'chr') : undefined
    const sub = findFirst(node, 'sub')
    const sup = findFirst(node, 'sup')
    const e = findFirst(node, 'e')
    const symbol = chr?.attrs.val || '∑'
    const command = symbolToLatexCommand(symbol)
    let out = command
    if (sub) out += `_{${ommlChildren(sub)}}`
    if (sup) out += `^{${ommlChildren(sup)}}`
    if (e) out += ` ${ommlChildren(e)}`
    return out
  }
  if (node.local === 'd') {
    // delimiters: parens, brackets, etc.
    const pr = findFirst(node, 'dPr')
    const begChr = pr ? findFirst(pr, 'begChr')?.attrs.val : undefined
    const endChr = pr ? findFirst(pr, 'endChr')?.attrs.val : undefined
    const e = findFirst(node, 'e')
    const inside = e ? ommlChildren(e) : ''
    const left = begChr ?? '('
    const right = endChr ?? ')'
    return `\\left${escapeDelim(left)}${inside}\\right${escapeDelim(right)}`
  }
  // Fallback: recurse into children
  return ommlChildren(node)
}

function ommlChildren(node: XmlNode): string {
  const parts: string[] = []
  for (const c of node.children) {
    if (typeof c === 'string') parts.push(c)
    else parts.push(ommlToLatex(c))
  }
  return parts.join('')
}

function symbolToLatexCommand(sym: string): string {
  switch (sym) {
    case '∑': return '\\sum'
    case '∏': return '\\prod'
    case '∫': return '\\int'
    case '∮': return '\\oint'
    case '⋃': return '\\bigcup'
    case '⋂': return '\\bigcap'
    default: return sym
  }
}

function escapeDelim(ch: string): string {
  if (ch === '{' || ch === '}') return `\\${ch}`
  return ch
}

// ── Native tables (a:tbl → HTML) ───────────────────────────────
// A PPTX table is a graphicFrame holding <a:tbl>: <a:tblGrid> defines
// columns, each <a:tr> a row of <a:tc> cells. Merged cells carry
// gridSpan/rowSpan on the anchor cell and hMerge/vMerge="1" on the
// covered continuation cells (which we skip). We emit HTML so merged
// cells and multi-row headers survive — markdown pipes would mangle them.

function tablesFromSlide(root: XmlNode, slideNum: number): ExtractedTableData[] {
  const out: ExtractedTableData[] = []
  for (const tbl of findAll(root, 'tbl').filter((n) => n.prefix === 'a')) {
    const grid = findFirst(tbl, 'tblGrid')
    const colCount = grid ? findAll(grid, 'gridCol').filter((n) => n.prefix === 'a').length : 0
    const trs = childrenNamed(tbl, 'tr')
    if (trs.length === 0) continue

    // Merged cells: gridSpan/rowSpan on the anchor; hMerge/vMerge="1" on the
    // covered continuation cells, which we skip.
    const html = rowsToHtmlTable(trs, 'tc', (tc) => ({
      colSpan: Number(tc.attrs.gridSpan ?? '1'),
      rowSpan: Number(tc.attrs.rowSpan ?? '1'),
      skip: tc.attrs.hMerge === '1' || tc.attrs.vMerge === '1',
    }))
    out.push({ pageNumber: slideNum, html, rows: trs.length, cols: colCount, source: 'native' })
  }
  return out
}

// ── Native code (monospace OR structurally-code text boxes) ────
// Code on a slide is usually a text box set in a monospace font — the primary,
// near-zero-false-positive signal. But code pasted in a proportional font has
// no font signal, so we fall back to a conservative content heuristic
// (looksLikeCode). Either trigger emits a code unit, with a best-effort
// language guess (guessCodeLanguage).

const MONOSPACE_FONTS = new Set(
  [
    'courier new', 'courier', 'consolas', 'monaco', 'menlo', 'lucida console',
    'dejavu sans mono', 'source code pro', 'roboto mono', 'liberation mono',
    'andale mono', 'fira code', 'fira mono', 'cascadia code', 'cascadia mono',
    'sf mono', 'inconsolata', 'ibm plex mono', 'jetbrains mono', 'ubuntu mono',
  ].map((f) => f),
)

function runFontIsMonospace(run: XmlNode): boolean {
  // <a:r><a:rPr><a:latin typeface="Consolas"/></a:rPr>…</a:r>
  const latin = findFirst(run, 'latin')
  const face = latin?.attrs.typeface?.toLowerCase().trim()
  return !!face && MONOSPACE_FONTS.has(face)
}

function codeFromSlide(root: XmlNode, slideNum: number): ExtractedCodeData[] {
  const out: ExtractedCodeData[] = []
  for (const sp of findAll(root, 'sp').filter((n) => n.prefix === 'p')) {
    const runs = findAll(sp, 'r').filter((n) => n.prefix === 'a')
    if (runs.length === 0) continue

    // Reconstruct with paragraph breaks: one <a:p> per line.
    const paras = findAll(sp, 'p').filter((n) => n.prefix === 'a')
    const code = paras.map((p) => textOf(p)).join('\n').replace(/[ \t]+$/gm, '').trim()
    if (code.length < 20) continue // ignore stray fragments

    // Primary signal: predominantly monospace runs. Fallback: structurally code
    // (catches code set in a proportional font, which carries no font signal).
    const isMonospace = runs.filter(runFontIsMonospace).length / runs.length >= 0.6
    if (!isMonospace && !looksLikeCode(code)) continue

    out.push({ pageNumber: slideNum, code, language: guessCodeLanguage(code), source: 'native' })
  }
  return out
}

// ── Main extractor ─────────────────────────────────────────────

export async function extractPptx(
  buffer: Buffer,
  opts: ExtractPptxOptions,
): Promise<ExtractPptxResult> {
  const startedAt = Date.now()
  const admin = opts.adminClient ?? createAdminClient()
  const bucket = opts.storageBucket ?? COURSE_MATERIALS_BUCKET
  const storageFolder = `extracted-images/${opts.sectionId}/${opts.moduleItemId}`

  let zip: Unzipped
  try {
    zip = unzipSync(new Uint8Array(buffer))
  } catch (err) {
    logger.error('extractPptx: unzip failed', err, { moduleItemId: opts.moduleItemId })
    return {
      status: 'failed',
      extractedAt: new Date(startedAt).toISOString(),
      error: err instanceof Error ? err.message : 'Unzip failed',
      metadata: { pageCount: 0, wordCount: 0 },
      pages: [],
      textStatus: 'failed',
      imagesStatus: 'failed',
      formulasStatus: 'failed',
      tablesStatus: 'failed',
    }
  }

  const decoder = new TextDecoder('utf-8')

  // 1. Enumerate slides in numeric order
  const slidePaths = Object.keys(zip)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/slide(\d+)/)![1]) - Number(b.match(/slide(\d+)/)![1]))

  // 2. Build slide → media mapping from per-slide rels files.
  // <Relationship Id="rId1" Type="...image" Target="../media/image1.png"/>
  const slideMediaMap = new Map<number, string[]>()
  // rId → media filename, per slide — lets us tie a <p:pic>'s alt-text
  // (its blip's r:embed rId) to the specific media file it points at.
  const slideRelMap = new Map<number, Map<string, string>>()
  // slide → chart part filenames it references (../charts/chartN.xml) — for
  // slide-accurate native chart-data anchoring.
  const slideChartMap = new Map<number, string[]>()
  for (const slidePath of slidePaths) {
    const slideNum = Number(slidePath.match(/slide(\d+)/)![1])
    const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`
    const relsBytes = zip[relsPath]
    if (!relsBytes) {
      slideMediaMap.set(slideNum, [])
      slideRelMap.set(slideNum, new Map())
      slideChartMap.set(slideNum, [])
      continue
    }
    const rels = decoder.decode(relsBytes)
    const targets = Array.from(rels.matchAll(/Target="\.\.\/media\/([^"]+)"/g)).map((m) => m[1])
    slideMediaMap.set(slideNum, targets)
    slideChartMap.set(
      slideNum,
      Array.from(rels.matchAll(/Target="\.\.\/charts\/([^"]+)"/g)).map((m) => m[1]),
    )
    // rId↔name, tolerant of attribute order (Id before or after Target).
    const rIdMap = new Map<string, string>()
    for (const m of rels.matchAll(/Id="([^"]+)"[^>]*Target="\.\.\/media\/([^"]+)"/g)) rIdMap.set(m[1], m[2])
    for (const m of rels.matchAll(/Target="\.\.\/media\/([^"]+)"[^>]*Id="([^"]+)"/g)) rIdMap.set(m[2], m[1])
    slideRelMap.set(slideNum, rIdMap)
  }

  // 3. For each slide: extract text (<a:t>), formulas (<m:oMath>/<m:oMathPara>).
  const pages: ExtractionPageData[] = []
  const formulas: ExtractedFormulaData[] = []
  const tables: ExtractedTableData[] = []
  const code: ExtractedCodeData[] = []
  const charts: ExtractedChartData[] = []
  const figures: ExtractedFigureData[] = []
  // media filename → author alt-text (`descr`), for image citations.
  const mediaAltText = new Map<string, string>()
  let totalWords = 0

  for (const slidePath of slidePaths) {
    const slideNum = Number(slidePath.match(/slide(\d+)/)![1])
    const xml = decoder.decode(zip[slidePath])
    let root: XmlNode
    try {
      root = parseXml(xml)
    } catch (err) {
      logger.warn('extractPptx: slide parse failed, skipping', {
        moduleItemId: opts.moduleItemId,
        slide: slideNum,
        error: err instanceof Error ? err.message : String(err),
      })
      pages.push({ pageNumber: slideNum, text: '', headings: [] })
      continue
    }

    // Collect <a:t> text nodes; this is how OOXML stores runs of prose.
    const textNodes = findAll(root, 't').filter((n) => n.prefix === 'a')
    const text = textNodes.map((n) => textOf(n)).join(' ').replace(/\s+/g, ' ').trim()
    totalWords += text.split(/\s+/).filter(Boolean).length
    pages.push({ pageNumber: slideNum, text, headings: [] })

    // OMML: <m:oMath> is inline, <m:oMathPara> is display.
    const ommlDisplay = findAll(root, 'oMathPara').filter((n) => n.prefix === 'm')
    const ommlInline = findAll(root, 'oMath').filter((n) => n.prefix === 'm')

    for (const disp of ommlDisplay) {
      try {
        const latex = ommlChildren(disp).trim()
        if (latex) {
          formulas.push({
            pageNumber: slideNum,
            latex,
            kind: 'display',
            source: 'omml',
          })
        }
      } catch (err) {
        logger.warn('extractPptx: OMML-to-LaTeX failed on display math', {
          moduleItemId: opts.moduleItemId,
          slide: slideNum,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Skip oMath nodes that are nested inside an oMathPara (already handled above).
    for (const inl of ommlInline) {
      // Walk up: if any ancestor is oMathPara, skip. We don't track parents
      // in our tree, so check for inclusion by content: if the same LaTeX
      // was just emitted as display math, skip it.
      try {
        const latex = ommlChildren(inl).trim()
        if (!latex) continue
        const alreadyDisplay = formulas.some(
          (f) => f.pageNumber === slideNum && f.kind === 'display' && f.latex.includes(latex),
        )
        if (alreadyDisplay) continue
        formulas.push({
          pageNumber: slideNum,
          latex,
          kind: 'inline',
          source: 'omml',
        })
      } catch (err) {
        logger.warn('extractPptx: OMML-to-LaTeX failed on inline math', {
          moduleItemId: opts.moduleItemId,
          slide: slideNum,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Native tables (a:tbl → HTML) and monospace code boxes.
    try {
      tables.push(...tablesFromSlide(root, slideNum))
      code.push(...codeFromSlide(root, slideNum))
    } catch (err) {
      logger.warn('extractPptx: table/code extraction failed', {
        moduleItemId: opts.moduleItemId,
        slide: slideNum,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Author-written image alt-text (<p:pic> cNvPr@descr) → keyed by the
    // media file the pic's blip embeds, so it lands on the right image below.
    const rIdMap = slideRelMap.get(slideNum) ?? new Map<string, string>()
    for (const pic of findAll(root, 'pic').filter((n) => n.prefix === 'p')) {
      const descr = findFirst(pic, 'cNvPr')?.attrs.descr?.trim()
      if (!descr) continue
      const blip = findFirst(pic, 'blip')
      const embed = blip?.attrs['r:embed'] ?? blip?.attrs.embed
      const name = embed ? rIdMap.get(embed) : undefined
      if (name) mediaAltText.set(name, descr)
      // Author descr is also a native figure unit (mirrors docx.ts) — without
      // this, described PPTX figures are invisible to the asset registry.
      figures.push({ pageNumber: slideNum, description: descr, source: 'native' })
    }
  }

  // 3b. Native chart DATA (not a picture): each slide's referenced chart parts
  // carry their series in numCache/strCache — read exact (label,value) pairs for
  // $0, anchored to the slide that draws them. Shared parser with XLSX/DOCX.
  for (const [slideNum, chartFiles] of slideChartMap.entries()) {
    for (const file of chartFiles) {
      const bytes = zip[`ppt/charts/${file}`]
      if (!bytes) continue
      try {
        const cd = chartDataFromPart(parseXml(decoder.decode(bytes)))
        if (cd) charts.push({ pageNumber: slideNum, title: cd.title, data: cd.data, source: 'native' })
      } catch (err) {
        logger.warn('extractPptx: chart parse failed, skipping', {
          moduleItemId: opts.moduleItemId,
          slide: slideNum,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // 4. Upload media to Storage and build ExtractedImage entries.
  const images: ExtractedImageData[] = []
  const uploadedNames = new Set<string>()
  for (const [slideNum, mediaNames] of slideMediaMap.entries()) {
    for (const name of mediaNames) {
      const media = zip[`ppt/media/${name}`]
      if (!media) continue

      /* `name` is attacker-controlled: it comes verbatim out of the uploaded
         archive's rels XML, and the zip entry key can contain `..` segments. It is
         about to become a storage key written with the service-role client and
         upsert:true, and supabase-js interpolates the key into the request URL
         unencoded — so the URL parser would normalise `../../..` and land the write
         in another section's prefix, or even another bucket. Reduce it to a bare
         filename before it touches the path. Same sanitisation the legacy
         officeparser path in modules/actions.ts already applied; the v2 rewrite
         dropped it. Dedup on the SAFE name so two raw names that collapse to one
         key can't overwrite each other. */
      const safeName = (name.split('/').pop() ?? '').replace(/[^a-zA-Z0-9._-]/g, '_')
      if (!safeName || safeName === '.' || safeName === '..') continue
      if (uploadedNames.has(safeName)) continue
      uploadedNames.add(safeName)

      const storagePath = `${storageFolder}/${safeName}`
      const mimeType = guessMimeFromExt(safeName)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (admin as any).storage
        .from(bucket)
        .upload(storagePath, Buffer.from(media), {
          contentType: mimeType,
          cacheControl: '31536000',
          upsert: true,
        })
      if (error) {
        logger.warn('extractPptx: media upload failed', {
          moduleItemId: opts.moduleItemId,
          storagePath,
          error: error.message,
        })
        continue
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: pub } = (admin as any).storage.from(bucket).getPublicUrl(storagePath)

      // Pixel dimensions aren't in the zip; use 0/0 as a sentinel meaning
      // "present but unknown". Consumers should treat these as metadata
      // they may want to compute lazily via `sharp(buffer).metadata()`.
      // For schema validity, we need positive integers, so use 1 as a stub.
      images.push({
        pageNumber: slideNum,
        storagePath,
        storageUrl: pub.publicUrl,
        pixelWidth: 1,
        pixelHeight: 1,
        bytes: media.length,
        altText: mediaAltText.get(name),
      })
    }
  }

  return {
    status: 'completed',
    extractedAt: new Date(startedAt).toISOString(),
    error: null,
    metadata: {
      pageCount: slidePaths.length,
      wordCount: totalWords,
      imageCount: images.length,
      formulaCount: formulas.length,
    },
    pages,
    images: images.length > 0 ? images : undefined,
    formulas: formulas.length > 0 ? formulas : undefined,
    tables: tables.length > 0 ? tables : undefined,
    code: code.length > 0 ? code : undefined,
    charts: charts.length > 0 ? charts : undefined,
    figures: figures.length > 0 ? figures : undefined,
    textStatus: 'completed',
    imagesStatus: 'completed',
    formulasStatus: 'completed',
    tablesStatus: 'completed',
  }
}

function guessMimeFromExt(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'svg': return 'image/svg+xml'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'tif':
    case 'tiff': return 'image/tiff'
    default: return 'application/octet-stream'
  }
}
