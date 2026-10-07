/**
 * Render-grounded evidence: what each captured screen actually shows, and where the source
 * claims something the screens don't.
 *
 *   ledger     capture.mjs reads the live DOM after every screenshot (render.json): headings,
 *              text, buttons, controls and their labels, tabs, table headers, badges, alerts,
 *              states and options, with visibility and a locator. Each item gets an id the
 *              judge can cite, such as render:professor-desktop-normal:button:mark-all-present.
 *   claims     the view source, parsed (never run): the button labels, column headers, tab
 *              labels, titles and field labels it asks the kit to show, with their lines.
 *   checks     claims no captured state shows, and screens that contradict themselves. These
 *              are decided here, deterministically; the judge is told, never asked.
 *
 * A source claim being absent from every captured state is only a contradiction when the
 * element it belongs to did render, or when nothing in the source makes it conditional.
 * Anything shown only under a condition the capture didn't reach is listed as not seen.
 */
import ts from 'typescript'
import { z } from 'zod'

export const RENDER_FORMAT = 'studio-quality-render-v1'

const KINDS = ['state', 'heading', 'tab', 'option', 'button', 'link', 'control', 'table', 'badge', 'stat', 'alert', 'progress', 'chart', 'list', 'text'] as const
const VISIBILITY = ['visible', 'clipped', 'partly-scrolled', 'scrolled-out', 'offscreen', 'below-frame'] as const

// The ledger is read inside the plugin's own frame, so everything in it is plugin-controlled
// text: bounded here, and cleaned of line breaks and control characters when parsed.
const str = (max: number) => z.string().max(max)
const renderItemSchema = z.strictObject({
  frame: z.enum(['plugin', 'host']),
  kind: z.enum(KINDS),
  text: str(400),
  label: str(400).optional(),
  placeholder: str(400).optional(),
  control: str(40).optional(),
  state: str(40).nullable().optional(),
  level: z.number().nullable().optional(),
  selected: z.boolean().optional(),
  disabled: z.boolean().optional(),
  value: z.union([z.number(), str(400)]).nullable().optional(),
  max: z.number().nullable().optional(),
  options: z.array(str(400)).max(20).optional(),
  headers: z.array(str(400)).max(30).optional(),
  rowCount: z.number().optional(),
  rows: z.array(z.array(str(400)).max(30)).max(4).optional(),
  visibility: z.enum(VISIBILITY),
  textCut: z.boolean(),
  group: str(600).nullable(),
  locator: str(600),
  rect: z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
})
export type RenderItem = z.infer<typeof renderItemSchema>

const renderShotSchema = z.strictObject({
  shot: z.string().regex(/^[a-z]+-[a-z]+-[a-z]+$/),
  view: z.enum(['professor', 'student']),
  device: z.enum(['desktop', 'phone']),
  scenario: z.enum(['normal', 'empty', 'slow', 'failing']),
  /** The tab opened to read this, or null for the screen as first shown. */
  tab: str(200).nullable(),
  items: z.array(renderItemSchema).max(500),
  truncated: z.number().int().min(0),
  failed: z.boolean().optional(),
})
export type RenderShot = z.infer<typeof renderShotSchema>

export const renderLedgerSchema = z.strictObject({ format: z.literal(RENDER_FORMAT), shots: z.array(renderShotSchema).max(40) })
export type RenderLedger = z.infer<typeof renderLedgerSchema>

/** A line break, another line terminator, or any C0 or C1 control character. */
const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029

/** Every string in the ledger on one line, so no plugin text can start a line of its own in the judge's input. */
function oneLine<T>(value: T): T {
  if (typeof value === 'string') return [...value].map((ch) => (isControl(ch.codePointAt(0)!) ? ' ' : ch)).join('') as T
  if (Array.isArray(value)) return value.map(oneLine) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, oneLine(v)])) as T
  return value
}

/** render.json as captured, validated and cleaned; null when it isn't a ledger. */
export function parseRenderLedger(raw: unknown): RenderLedger | null {
  const parsed = renderLedgerSchema.safeParse(raw)
  return parsed.success ? oneLine(parsed.data) : null
}

// ── Ids ──

export const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '') || 'item'

export const RENDER_ID = /^render:[a-z0-9.-]+:[a-z]+:[a-z0-9-]+(~[0-9]+)?$/
export const CHECK_ID = /^check:(professor|student):[0-9]{1,3}$/

/** The screen a render item was read from: the shot id, plus the tab when one was opened. */
export const shotKey = (s: Pick<RenderShot, 'shot' | 'tab'>) => (s.tab === null ? s.shot : `${s.shot}.tab-${slug(s.tab)}`)

export interface IndexedItem {
  id: string
  key: string
  view: RenderShot['view']
  device: RenderShot['device']
  scenario: RenderShot['scenario']
  tab: string | null
  item: RenderItem
}

/** Every render item with its citable id, in capture order. */
export function indexLedger(ledger: RenderLedger): IndexedItem[] {
  const out: IndexedItem[] = []
  const used = new Map<string, number>()
  for (const s of ledger.shots) {
    const key = shotKey(s)
    for (const item of s.items) {
      const base = `render:${key}:${item.kind}:${slug(item.text || item.label || item.kind)}`
      const n = (used.get(base) ?? 0) + 1
      used.set(base, n)
      out.push({ id: n === 1 ? base : `${base}~${n}`, key, view: s.view, device: s.device, scenario: s.scenario, tab: s.tab, item })
    }
  }
  return out
}

// ── Source claims ──

export type ClaimKind = 'button' | 'column' | 'tab' | 'heading' | 'stat' | 'field' | 'option' | 'badge' | 'alert' | 'state' | 'label' | 'text'

export interface SourceClaim {
  view: 'professor' | 'student'
  /** The kit component that would show it. */
  component: string
  kind: ClaimKind
  text: string
  line: number
  /** The line of the element it belongs to. */
  element: number
  /** Where that element starts in the source: claims of one element share it. */
  elementAt: number
  /** Inside a branch, a callback or an early return: it may need a state the capture didn't reach. */
  conditional: boolean
}

const FIELD_COMPONENTS = new Set(['TextField', 'NumberField', 'DateField', 'SearchField', 'Select', 'Checkbox', 'Switch', 'SegmentedControl'])

function staticText(node: ts.Expression | undefined): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text.trim().length >= 3 ? node.head.text : null
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression)
  return null
}

const attr = (el: ts.JsxOpeningLikeElement, name: string): ts.Expression | undefined => {
  for (const p of el.attributes.properties) {
    if (!ts.isJsxAttribute(p) || p.name.getText() !== name || !p.initializer) continue
    if (ts.isStringLiteral(p.initializer)) return p.initializer
    if (ts.isJsxExpression(p.initializer)) return p.initializer.expression
  }
  return undefined
}

const prop = (obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  for (const p of obj.properties) if (ts.isPropertyAssignment(p) && (p.name.getText().replace(/['"]/g, '') === name)) return p.initializer
  return undefined
}

/** A JSX element's own static text: its text children and string children, joined. */
function childText(node: ts.Node): string | null {
  if (!ts.isJsxElement(node)) return null
  const parts: string[] = []
  for (const c of node.children) {
    if (ts.isJsxText(c)) parts.push(c.text)
    else if (ts.isJsxExpression(c) && c.expression) {
      const t = staticText(c.expression)
      if (t) parts.push(t)
    }
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  return text.length >= 2 ? text : null
}

function isConditional(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isConditionalExpression(p) || ts.isIfStatement(p)) return true
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) return true
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent && ts.isCallExpression(p.parent)) return true
    // A helper component declared beside the view: shown only where the view uses it.
    if (ts.isFunctionDeclaration(p) && !p.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return true
  }
  return false
}

/** What a view's source asks the kit to show, in source order. */
export function sourceClaims(view: SourceClaim['view'], source: string): SourceClaim[] {
  const file = ts.createSourceFile(`${view}.tsx`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const claims: SourceClaim[] = []
  const lineOf = (n: ts.Node) => file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1
  const visit = (node: ts.Node) => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null
    if (opening) {
      const component = opening.tagName.getText(file)
      const element = lineOf(node)
      const elementAt = node.getStart(file)
      const conditional = isConditional(node)
      const push = (kind: ClaimKind, text: string | null, at: ts.Node = node) => {
        if (text && text.trim().length >= 2) claims.push({ view, component, kind, text: text.replace(/\s+/g, ' ').trim(), line: lineOf(at), element, elementAt, conditional })
      }
      const arrayOf = (name: string) => {
        const v = attr(opening, name)
        return v && ts.isArrayLiteralExpression(v) ? v.elements.filter(ts.isObjectLiteralExpression) : []
      }
      switch (component) {
        case 'Button':
          push('button', childText(node))
          break
        case 'Heading':
          push('heading', childText(node))
          break
        case 'Screen':
        case 'Section':
        case 'Card':
          push('heading', staticText(attr(opening, 'title')))
          break
        case 'StatCard':
          push('stat', staticText(attr(opening, 'label')))
          break
        case 'Tabs':
          for (const t of arrayOf('tabs')) push('tab', staticText(prop(t, 'label')), t)
          break
        case 'DataTable':
        case 'RosterTable': {
          push('label', staticText(attr(opening, 'label')))
          for (const c of arrayOf('columns')) push('column', staticText(prop(c, 'header')), c)
          // Buttons and choices inside RosterTable cells.
          const cells = attr(opening, 'cells')
          if (cells) {
            const walk = (n: ts.Node) => {
              if (ts.isObjectLiteralExpression(n)) {
                const kind = staticText(prop(n, 'kind'))
                if (kind === 'button') push('button', staticText(prop(n, 'label')), n)
                const options = prop(n, 'options')
                if (kind === 'choice' && options && ts.isArrayLiteralExpression(options))
                  for (const o of options.elements.filter(ts.isObjectLiteralExpression)) push('option', staticText(prop(o, 'label')), o)
              }
              ts.forEachChild(n, walk)
            }
            walk(cells)
          }
          break
        }
        case 'Badge':
          push('badge', childText(node))
          break
        case 'Alert':
          push('alert', staticText(attr(opening, 'title')))
          break
        case 'Empty':
          push('state', staticText(attr(opening, 'title')))
          break
        case 'ProgressBar':
        case 'BarChart':
        case 'List':
          push('label', staticText(attr(opening, 'label')))
          break
        case 'ListItem':
          push('text', staticText(attr(opening, 'title')))
          break
        case 'Text':
          push('text', childText(node))
          break
        default:
          if (FIELD_COMPONENTS.has(component)) {
            push('field', staticText(attr(opening, 'label')))
            for (const o of arrayOf('options')) push('option', staticText(prop(o, 'label')), o)
          }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return claims
}

// ── Cross-check ──

const norm = (s: string) =>
  ` ${s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `

/**
 * Where on the page a claim of each kind can show. A column counts only in a table's
 * headers, a button only on a button or in a roster cell, and so on: the words "Points
 * Today" on a stat card don't make a "Points Today" column appear.
 */
function placesFor(kind: ClaimKind, i: RenderItem): string[] {
  const cells = (i.rows ?? []).flat()
  switch (kind) {
    case 'column':
      return i.kind === 'table' ? (i.headers ?? []) : []
    case 'button':
      return i.kind === 'button' ? [i.text, i.label ?? ''] : i.kind === 'table' ? cells : []
    case 'tab':
      return i.kind === 'tab' ? [i.text] : []
    case 'heading':
      return i.kind === 'heading' ? [i.text] : []
    case 'stat':
      return i.kind === 'stat' ? [i.text] : []
    case 'field':
      return i.kind === 'control' ? [i.label ?? '', i.text] : i.kind === 'option' ? [i.label ?? ''] : i.kind === 'button' ? [i.text, i.label ?? ''] : []
    case 'option':
      return i.kind === 'option' ? [i.text] : i.kind === 'control' ? (i.options ?? []) : i.kind === 'table' ? cells : i.kind === 'button' ? [i.text] : []
    case 'badge':
      return i.kind === 'badge' ? [i.text] : i.kind === 'table' ? cells : []
    case 'alert':
      return i.kind === 'alert' ? [i.text] : []
    case 'state':
      return i.kind === 'state' || i.kind === 'text' ? [i.text] : []
    case 'label':
      return ['table', 'progress', 'chart', 'list'].includes(i.kind) ? [i.label ?? '', i.text] : []
    case 'text':
      return ['text', 'heading', 'state', 'alert'].includes(i.kind) ? [i.text] : []
  }
}

const seenAt = (kind: ClaimKind, text: string, items: readonly IndexedItem[]) =>
  items.filter((x) => placesFor(kind, x.item).some((place) => norm(place).includes(norm(text)))).map((x) => x.id)

export interface RenderCheck {
  id: string
  view: 'professor' | 'student'
  kind: 'missing-from-render' | 'screen-contradiction'
  /** What the judge reads. */
  detail: string
  /** The claim texts that never rendered (missing-from-render), for the citation guard. */
  missing: string[]
  /** Render items involved. */
  renderIds: string[]
  lines: number[]
}

export interface NotSeen {
  view: 'professor' | 'student'
  component: string
  kind: ClaimKind
  text: string
  line: number
}

export interface CrossCheck {
  claims: (SourceClaim & { seenIn: string[] })[]
  checks: RenderCheck[]
  notSeen: NotSeen[]
}

// An action whose purpose needs the thing the screen says isn't there.
const UNAVAILABLE = /\b(no (options|choices|answers|data|items|questions|records|entries|results|slots|stages|steps)( (available|yet|found|left))?|nothing (to show|here|available)|not available|unavailable)\b/i
const COMMIT_ACTION = /^(submit|save|send|confirm|vote|answer|book|reserve|join|record|finish|done|continue|next|choose|select)\b/i

const quoted = (s: string) => `“${s}”`

export function crossCheck(ledger: RenderLedger, files: { professor: string; student: string }): CrossCheck {
  const indexed = indexLedger(ledger)
  const checks: RenderCheck[] = []
  const notSeen: NotSeen[] = []
  const claims: CrossCheck['claims'] = []
  for (const view of ['professor', 'student'] as const) {
    const items = indexed.filter((x) => x.view === view)
    const own = sourceClaims(view, files[view]).map((c) => ({ ...c, seenIn: seenAt(c.kind, c.text, items) }))
    claims.push(...own)
    const counter = () => `check:${view}:${checks.filter((c) => c.view === view).length + 1}`

    // Claims grouped by the element they belong to.
    const byElement = new Map<number, typeof own>()
    for (const c of own) byElement.set(c.elementAt, [...(byElement.get(c.elementAt) ?? []), c])
    for (const group of byElement.values()) {
      const element = group[0].element
      const missing = group.filter((c) => c.seenIn.length === 0)
      if (missing.length === 0) continue
      const shown = group.filter((c) => c.seenIn.length > 0)
      const component = group[0].component
      if (shown.length > 0 || !group[0].conditional) {
        const what = missing.map((c) => `${c.kind} ${quoted(c.text)}`).join(', ')
        checks.push({
          id: counter(),
          view,
          kind: 'missing-from-render',
          detail:
            shown.length > 0
              ? `${component} at views/${view}.tsx:${element} is on screen (${quoted(shown[0].text)}), but its ${what} ${missing.length === 1 ? 'is' : 'are'} not on screen in any captured state.`
              : `views/${view}.tsx:${element} always renders ${component} with ${what}, but no captured state shows ${missing.length === 1 ? 'it' : 'them'}.`,
          missing: missing.map((c) => c.text),
          renderIds: shown.flatMap((c) => c.seenIn).slice(0, 3),
          lines: missing.map((c) => c.line),
        })
      } else {
        for (const c of missing) notSeen.push({ view, component: c.component, kind: c.kind, text: c.text, line: c.line })
      }
    }

    // A screen that says something isn't there next to an action that needs it.
    const seen = new Set<string>()
    for (const shot of new Set(items.map((x) => x.key))) {
      const onShot = items.filter((x) => x.key === shot)
      for (const msg of onShot.filter((x) => ['text', 'state', 'alert'].includes(x.item.kind) && UNAVAILABLE.test(x.item.text))) {
        const action = onShot.find((x) => x.item.kind === 'button' && !x.item.disabled && x.item.group !== null && x.item.group === msg.item.group && COMMIT_ACTION.test(x.item.text))
        if (!action) continue
        const sig = `${norm(msg.item.text)}|${norm(action.item.text)}`
        if (seen.has(sig)) continue
        seen.add(sig)
        checks.push({
          id: counter(),
          view,
          kind: 'screen-contradiction',
          detail: `On ${shot}, ${quoted(msg.item.text)} is shown in the same container as an enabled ${quoted(action.item.text)} button.`,
          missing: [],
          renderIds: [msg.id, action.id],
          lines: [],
        })
      }
    }
  }
  return { claims, checks, notSeen }
}

// ── What the judge reads ──

const SCENARIO_LABEL: Record<RenderShot['scenario'], string> = { normal: 'on sample data', empty: 'with no data', slow: 'while loading', failing: 'when every request fails' }

function describe(i: RenderItem): string {
  const bits: string[] = []
  if (i.kind === 'table') {
    bits.push(`table${i.label ? ` ${quoted(i.label)}` : ''} headers: ${(i.headers ?? []).map(quoted).join(', ') || 'none'}; ${i.rowCount ?? 0} rows`)
    const first = (i.rows ?? [])[0]
    if (first) bits.push(`first row: ${first.map((c) => quoted(c.slice(0, 40))).join(', ')}`)
  } else if (i.kind === 'control') {
    bits.push(`${i.control ?? 'field'} labelled ${quoted(i.label || i.text || '(no label)')}`)
    if (i.placeholder) bits.push(`placeholder ${quoted(i.placeholder)}`)
    if (i.options?.length) bits.push(`options ${i.options.map(quoted).join(', ')}`)
    if (i.value) bits.push(`showing ${quoted(String(i.value))}`)
  } else if (i.kind === 'progress') {
    bits.push(`progress ${quoted(i.text)} ${i.value ?? '?'} of ${i.max ?? '?'}`)
  } else if (i.kind === 'list') {
    bits.push(`list${i.label ? ` ${quoted(i.label)}` : ''} of ${i.rowCount ?? 0} items`)
  } else {
    bits.push(`${i.kind}${i.kind === 'state' && i.state ? ` (${i.state})` : ''} ${quoted(i.text.slice(0, 120))}`)
    if (i.label && i.label !== i.text) bits.push(`label ${quoted(i.label)}`)
  }
  if (i.disabled) bits.push('disabled')
  if (i.selected !== undefined) bits.push(i.selected ? 'selected' : 'not selected')
  if (i.visibility !== 'visible') bits.push(i.visibility)
  if (i.textCut) bits.push('text cut off')
  if (i.frame === 'host') bits.push('drawn by Scholera')
  return bits.join('; ')
}

/** The rendered evidence and the deterministic checks, as the judge reads them. */
export function renderText(ledger: RenderLedger, cross: CrossCheck): string {
  const indexed = indexLedger(ledger)
  const lines: string[] = []
  for (const s of ledger.shots) {
    const key = shotKey(s)
    const mine = indexed.filter((x) => x.key === key)
    const head = `[${key}] ${s.view} view, ${s.device}, ${SCENARIO_LABEL[s.scenario]}${s.tab ? `, after opening the tab ${quoted(s.tab)}` : ''}`
    if (s.failed) {
      lines.push(`${head}: could not be read.`)
      continue
    }
    // A phone screen lists only what differs from the desktop one, and anything clipped.
    const desktop = s.device === 'phone' ? indexed.filter((x) => x.view === s.view && x.device === 'desktop' && x.scenario === s.scenario && x.tab === null) : []
    const same = new Set(desktop.map((x) => `${x.item.kind}|${norm(x.item.text)}`))
    const shown = s.device === 'phone' ? mine.filter((x) => !same.has(`${x.item.kind}|${norm(x.item.text)}`) || x.item.visibility !== 'visible' || x.item.textCut) : mine
    lines.push(`${head}${s.device === 'phone' ? `: the same items as on desktop, except these (${mine.length} items in all)` : ''}${s.truncated ? `; ${s.truncated} more items not listed` : ''}`)
    for (const x of shown) lines.push(`  ${x.id} | ${describe(x.item)}`)
    if (shown.length === 0) lines.push('  (nothing different)')
  }
  lines.push('')
  lines.push('Checks (decided from the rendered page and the source, not by you):')
  if (cross.checks.length === 0) lines.push('  none')
  for (const c of cross.checks) lines.push(`  ${c.id} | ${c.kind} | ${c.detail}${c.renderIds.length ? ` See ${c.renderIds.join(', ')}.` : ''}`)
  if (cross.notSeen.length) {
    lines.push('')
    lines.push('In the source but on no captured screen, only shown under a condition the capture did not reach (no credit unless a rendered control leads to it):')
    for (const n of cross.notSeen.slice(0, 30)) lines.push(`  views/${n.view}.tsx:${n.line} ${n.component} ${n.kind} ${quoted(n.text)}`)
  }
  return lines.join('\n')
}

/** Everything the judge gets from the rendered screens: the text it reads, the citable items and the checks. */
export function judgeRender(ledger: RenderLedger, files: { professor: string; student: string }) {
  const cross = crossCheck(ledger, files)
  const indexed = indexLedger(ledger)
  return {
    cross,
    indexed,
    render: {
      text: renderText(ledger, cross),
      items: indexed.map((x) => ({ id: x.id, view: x.view, device: x.device, scenario: x.scenario, kind: x.item.kind })),
      checks: cross.checks.map(({ id, view, kind, missing, detail }) => ({ id, view, kind, missing, detail })),
    },
  }
}
