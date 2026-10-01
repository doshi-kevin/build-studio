// Shared OOXML helpers — a minimal XML walker + small utilities used by every
// Office format (PPTX/DOCX/XLSX are all ZIPs of XML). Extracted from pptx.ts so
// the DOCX and XLSX extractors reuse one parser instead of re-implementing it.
// The grammar we touch (tables, text runs, alt-text, charts) is regular enough
// that a tiny open/close-tag walker suffices — no XML-parser dependency.

export interface XmlNode {
  tag: string
  /** local name (without namespace prefix) */
  local: string
  /** namespace prefix (without colon), or '' */
  prefix: string
  attrs: Record<string, string>
  children: Array<XmlNode | string>
}

export function decodeXmlEntities(s: string): string {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /(\S+?)=("|')(.*?)\2/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = decodeXmlEntities(m[3])
  }
  return out
}

/** Very small XML parser. Returns the document root node. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: '#root', local: '#root', prefix: '', attrs: {}, children: [] }
  const stack: XmlNode[] = [root]
  let i = 0
  while (i < xml.length) {
    if (xml[i] !== '<') {
      const nextLt = xml.indexOf('<', i)
      const text = xml.slice(i, nextLt === -1 ? xml.length : nextLt)
      if (text.trim().length > 0) {
        stack[stack.length - 1].children.push(decodeXmlEntities(text))
      }
      i = nextLt === -1 ? xml.length : nextLt
      continue
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4)
      i = end === -1 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2)
      i = end === -1 ? xml.length : end + 2
      continue
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9)
      const text = xml.slice(i + 9, end === -1 ? xml.length : end)
      stack[stack.length - 1].children.push(text)
      i = end === -1 ? xml.length : end + 3
      continue
    }

    const gt = xml.indexOf('>', i)
    if (gt === -1) break
    const rawTag = xml.slice(i + 1, gt)
    i = gt + 1

    if (rawTag.startsWith('/')) {
      if (stack.length > 1) stack.pop()
      continue
    }

    const selfClosing = rawTag.endsWith('/')
    const clean = selfClosing ? rawTag.slice(0, -1).trim() : rawTag.trim()
    const spaceIdx = clean.indexOf(' ')
    const name = spaceIdx === -1 ? clean : clean.slice(0, spaceIdx)
    const attrsStr = spaceIdx === -1 ? '' : clean.slice(spaceIdx + 1)
    const attrs = parseAttrs(attrsStr)

    const colon = name.indexOf(':')
    const prefix = colon === -1 ? '' : name.slice(0, colon)
    const local = colon === -1 ? name : name.slice(colon + 1)
    const node: XmlNode = { tag: name, local, prefix, attrs, children: [] }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }
  return root
}

/** Traverse a subtree, collecting nodes whose local name matches. */
export function findAll(node: XmlNode, localName: string): XmlNode[] {
  const out: XmlNode[] = []
  const walk = (n: XmlNode | string) => {
    if (typeof n === 'string') return
    if (n.local === localName) out.push(n)
    for (const c of n.children) walk(c)
  }
  for (const c of node.children) walk(c)
  return out
}

export function findFirst(node: XmlNode, localName: string): XmlNode | undefined {
  for (const c of node.children) {
    if (typeof c === 'string') continue
    if (c.local === localName) return c
    const inner = findFirst(c, localName)
    if (inner) return inner
  }
  return undefined
}

/** Direct children of `node` whose local name matches (no recursion). */
export function childrenNamed(node: XmlNode, localName: string): XmlNode[] {
  const out: XmlNode[] = []
  for (const c of node.children) {
    if (typeof c !== 'string' && c.local === localName) out.push(c)
  }
  return out
}

/** Concatenate all text nodes inside a subtree, ignoring element names. */
export function textOf(node: XmlNode): string {
  let out = ''
  for (const c of node.children) {
    if (typeof c === 'string') out += c
    else out += textOf(c)
  }
  return out
}

export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

// ── Chart data (c:chart → c:ser → c:cat/c:val) ─────────────────
// A chart part — XLSX `xl/charts/`, PPTX `ppt/charts/`, DOCX `word/charts/` —
// caches its plotted numbers in numCache/strCache, so we read the EXACT
// (label,value) pairs deterministically, no rendering. Shared by all three OOXML
// extractors (the part's grammar is identical across formats).

// Cap series length so a crafted `<c:pt idx="1000000000">` can't blow the CSV
// builder into a billion-row memory/CPU soak (CWE-400). Real charts are tiny.
const MAX_CHART_POINTS = 4096

/** Ordered <c:v> values under a <c:cat>/<c:val>, honoring each <c:pt idx>. */
function chartPtValues(ref: XmlNode | undefined): string[] {
  if (!ref) return []
  const out: string[] = []
  for (const pt of findAll(ref, 'pt')) {
    const idx = Number(pt.attrs.idx ?? out.length)
    if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_CHART_POINTS) continue
    out[idx] = textOf(findFirst(pt, 'v') ?? pt).trim()
  }
  return out
}

export interface ChartSeries {
  name: string
  values: string[]
}

/**
 * Build the chart unit (`{ title?, data }`) from already-extracted categories +
 * series, where `data` is CSV (category column + one column per series). Shared
 * by the cached path (below) and the XLSX formula-ref path (xlsx.ts), which read
 * the same numbers from two different places. Returns null when there's no data.
 */
export function seriesToChart(
  root: XmlNode,
  categories: string[],
  series: ChartSeries[],
): { title?: string; data: string } | null {
  const rowCount = Math.max(categories.length, ...series.map((s) => s.values.length), 0)
  if (rowCount === 0) return null

  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = [['category', ...series.map((s) => s.name)].map(esc).join(',')]
  for (let i = 0; i < rowCount; i++) {
    lines.push([categories[i] ?? String(i + 1), ...series.map((s) => s.values[i] ?? '')].map(esc).join(','))
  }

  // Chart title (c:chart > c:title appears before axis titles in doc order, so
  // findFirst returns it), else fall back to the first series name.
  const titleNode = findFirst(root, 'title')
  const title = (titleNode ? textOf(titleNode).replace(/\s+/g, ' ').trim() : '') || series[0]?.name || undefined
  return { title, data: lines.join('\n') }
}

/**
 * Parse a chart part's series from its CACHED values (numCache/strCache) into
 * `{ title?, data }`. Returns null when there are no series OR no cached points —
 * e.g. openpyxl writes only `<c:f>` formula refs with no cache, which the XLSX
 * path recovers by resolving the refs against the sheet (see xlsx.ts).
 */
export function chartDataFromPart(root: XmlNode): { title?: string; data: string } | null {
  const sers = findAll(root, 'ser')
  if (sers.length === 0) return null

  // Categories: take the longest cat list across series (they usually share one).
  let categories: string[] = []
  const series: ChartSeries[] = []
  for (const ser of sers) {
    const cat = chartPtValues(findFirst(ser, 'cat'))
    if (cat.length > categories.length) categories = cat
    const values = chartPtValues(findFirst(ser, 'val'))
    const tx = findFirst(ser, 'tx')
    const name = (tx ? textOf(tx).replace(/\s+/g, ' ').trim() : '') || `series${series.length + 1}`
    series.push({ name, values })
  }

  return seriesToChart(root, categories, series)
}

/** Per-cell rendering decision: colspan/rowspan and whether to drop the cell. */
export interface CellSpec {
  colSpan?: number
  rowSpan?: number
  /** true → this is a merged-into continuation cell, don't render it */
  skip?: boolean
}

/**
 * Build an HTML `<table>` from OOXML rows. Shared by PPTX (a:tr/a:tc, spans on
 * attrs) and DOCX (w:tr/w:tc, spans in child elements): the caller supplies a
 * `cellSpec` that reads the span/merge info for whichever grammar, and we render
 * consistent, HTML-escaped output.
 */
export function rowsToHtmlTable(
  rows: XmlNode[],
  cellTag: string,
  cellSpec: (cell: XmlNode) => CellSpec = () => ({}),
): string {
  const trs: string[] = []
  for (const tr of rows) {
    const cells: string[] = []
    for (const tc of childrenNamed(tr, cellTag)) {
      const spec = cellSpec(tc)
      if (spec.skip) continue
      const colSpan = spec.colSpan ?? 1
      const rowSpan = spec.rowSpan ?? 1
      const text = escapeHtml(textOf(tc).replace(/\s+/g, ' ').trim())
      const attrs = (colSpan > 1 ? ` colspan="${colSpan}"` : '') + (rowSpan > 1 ? ` rowspan="${rowSpan}"` : '')
      cells.push(`<td${attrs}>${text}</td>`)
    }
    trs.push(`<tr>${cells.join('')}</tr>`)
  }
  return `<table>${trs.join('')}</table>`
}

// ── Code detection (font-independent, deterministic) ───────────
// Monospace font is the primary, near-zero-false-positive code signal. But
// code pasted into a proportional font (Arial/Calibri) carries no font signal,
// so we add a CONSERVATIVE content heuristic as a secondary trigger: a block is
// code only when it shows ≥2 of four strong structural signals over ≥3 lines.
// The high bar keeps prose, bullet lists, and math from being mis-tagged.

const CODE_KEYWORDS =
  /\b(def|class|return|import|from|function|const|let|var|public|private|static|void|int|float|for|while|if|else|elif|switch|case|new|throw|try|catch|async|await|println|printf|echo|select|insert|update|delete|where)\b/gi

/** True when a text block is structurally code, regardless of font. Conservative. */
export function looksLikeCode(text: string): boolean {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim())
  if (lines.length < 3) return false
  const joined = lines.join('\n')

  const keywordHits = (joined.match(CODE_KEYWORDS) ?? []).length
  const symbols = (joined.match(/[{}()[\];=<>+\-*/%&|]/g) ?? []).length
  const alnum = (joined.match(/[A-Za-z0-9]/g) ?? []).length || 1
  const indentedLines = lines.filter((l) => /^(\t| {2,})\S/.test(l)).length
  const codeEndLines = lines.filter((l) => /[{};]\s*$/.test(l) || /[:{]\s*$/.test(l)).length

  const strongSignals = [
    keywordHits >= 3,
    symbols / alnum > 0.12,
    indentedLines >= 2,
    codeEndLines >= 2,
  ].filter(Boolean).length

  return strongSignals >= 2
}

/** Lightweight language guess from syntax cues. Returns undefined when unsure. */
export function guessCodeLanguage(code: string): string | undefined {
  if (/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(code) && /\bFROM\b/i.test(code)) return 'sql'
  if (/(^|\n)\s*(def |elif |import \w|print\()/.test(code) && /:\s*$/m.test(code)) return 'python'
  if (/#include|std::|int\s+main\s*\(/.test(code)) return 'cpp'
  if (/\bpublic\b.*\bclass\b|System\.out\.print/.test(code)) return 'java'
  if (/\b(function|const|let|var)\b/.test(code) && /[;{]/.test(code)) {
    return /\binterface\b|:\s*(string|number|boolean)\b|<[A-Za-z]+>/.test(code) ? 'typescript' : 'javascript'
  }
  return undefined
}
