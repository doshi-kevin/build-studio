/**
 * The host-rendered RosterTable (docs/designs/studio/studio-builder-quality.md 3.4).
 * Framework-free, like host.ts, which creates it on a v2 frame's first roster message.
 *
 * A plugin describes the table with handles and cells; this draws it, names included,
 * in a layer over the plugin frame, exactly on the box the kit's placeholder reserved.
 * Names, the order by name and the search query stay in this page. The plugin learns
 * only which control the professor used, for which handle.
 *
 * Everything the plugin sent is text: it goes in through textContent and attributes,
 * never markup, and styles are set through the CSSOM. The colors mirror the kit v2
 * tokens (public/studio-runtime/v2/kit.css) rather than the app's, because the table
 * sits inside the plugin's light-themed box and should read as part of the tool.
 */
import type { RosterAction, RosterCell, RosterPayload, RosterRect, RosterTone } from './protocol'
import { ROSTER_HEADER_PX, ROSTER_ROW_PX, ROSTER_SEARCH_PX } from './roster-layout'

export const UNKNOWN_STUDENT = 'Unknown student'
/** More tables than any one view needs. A frame asking for more is refused. */
export const ROSTER_MAX_SLOTS = 8

const C = {
  card: 'oklch(1 0 0)',
  foreground: 'oklch(0.21 0.015 255)',
  muted: 'oklch(0.967 0.003 247)',
  mutedForeground: 'oklch(0.47 0.013 257)',
  border: 'oklch(0.922 0.004 247)',
  inputBorder: 'oklch(0.7 0.01 255)',
  primary: 'oklch(0.56 0.19 260)',
  onSolid: 'oklch(0.99 0 0)',
  danger: 'oklch(0.52 0.21 27)',
}
const TONE: Record<RosterTone, { bg: string; fg: string }> = {
  neutral: { bg: C.muted, fg: C.foreground },
  info: { bg: 'oklch(0.95 0.03 255)', fg: 'oklch(0.45 0.16 262)' },
  success: { bg: 'oklch(0.95 0.035 152)', fg: 'oklch(0.45 0.11 152)' },
  warning: { bg: 'oklch(0.95 0.05 78)', fg: 'oklch(0.48 0.1 65)' },
  danger: { bg: 'oklch(0.95 0.04 25)', fg: 'oklch(0.5 0.18 27)' },
}
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
const TARGET = '44px'

export interface RosterOverlayOptions {
  /** The element holding the plugin iframe. The layer covers it and is clipped to it. */
  container: HTMLElement
  /** Display names by handle. Asked once, on the first render. */
  names?: () => Promise<Record<string, string>>
  onAction: (action: RosterAction) => void
}

export interface RosterOverlay {
  /** False when the frame already has ROSTER_MAX_SLOTS tables. */
  render(slot: string, payload: RosterPayload): boolean
  place(slot: string, rect: RosterRect): void
  remove(slot: string): void
  destroy(): void
}

interface Slot {
  slot: string
  payload: RosterPayload
  box: HTMLDivElement
  searchBar: HTMLDivElement | null
  search: HTMLInputElement | null
  query: string
  body: HTMLDivElement
}

type Style = Partial<Record<keyof CSSStyleDeclaration, string>>

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Style = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node.style, style)
  if (text !== undefined) node.textContent = text
  return node
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
const focusKey = (...parts: string[]) => JSON.stringify(parts)

export function createRosterOverlay(options: RosterOverlayOptions): RosterOverlay {
  const slots = new Map<string, Slot>()
  const rects = new Map<string, RosterRect>()
  let layer: HTMLDivElement | null = null
  /** Null until the provider answers. */
  let names: Map<string, string> | null = null
  let asked = false
  let destroyed = false

  function ensureLayer(): HTMLDivElement {
    if (layer) return layer
    const position = getComputedStyle(options.container).position
    if (!position || position === 'static') options.container.style.position = 'relative'
    // Covers the frame and is clipped to it; only the tables themselves take clicks.
    layer = el('div', { position: 'absolute', top: '0', left: '0', right: '0', bottom: '0', overflow: 'hidden', pointerEvents: 'none', zIndex: '1' })
    layer.dataset.studioRoster = 'layer'
    options.container.appendChild(layer)
    return layer
  }

  function askForNames() {
    if (asked) return
    asked = true
    const loading = options.names ? options.names() : Promise.resolve({})
    loading
      .then(
        (got) => new Map(Object.entries(got ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim().length > 0)),
        () => new Map<string, string>(),
      )
      .then((loaded) => {
        if (destroyed) return
        names = loaded
        slots.forEach((_, slot) => draw(slot))
      })
  }

  const nameOf = (student: string) => names?.get(student) ?? UNKNOWN_STUDENT

  function ordered(payload: RosterPayload) {
    if (payload.sort !== 'name' || !names) return payload.rows
    return [...payload.rows].sort((a, b) => collator.compare(nameOf(a.student), nameOf(b.student)) || (a.student < b.student ? -1 : 1))
  }

  function act(slot: string, student: string, column: string, value: string) {
    if (!destroyed && slots.has(slot)) options.onAction({ slot, student, column, value })
  }

  function controlStyle(pressed: boolean, tone: RosterTone | null): Style {
    const t = tone ? TONE[tone] : null
    return {
      minHeight: TARGET,
      minWidth: TARGET,
      padding: '0 10px',
      borderRadius: '10px',
      font: `500 14px/1.2 ${FONT}`,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      background: pressed && t ? t.bg : C.card,
      color: pressed && t ? t.fg : C.foreground,
      // The pressed ring is a shadow, so pressing never changes a button's width.
      border: `1px solid ${pressed && t ? t.fg : C.inputBorder}`,
      boxShadow: pressed && t ? `inset 0 0 0 1px ${t.fg}` : 'none',
    }
  }

  function cellContent(slot: string, student: string, name: string, column: { key: string; header: string }, cell: RosterCell): HTMLElement {
    switch (cell.kind) {
      case 'text':
        return el('span', { color: C.foreground }, cell.text)
      case 'badge': {
        const t = TONE[cell.tone]
        return el('span', { display: 'inline-flex', alignItems: 'center', padding: '2px 10px', borderRadius: '9999px', background: t.bg, color: t.fg, font: `500 13px/1.4 ${FONT}`, whiteSpace: 'nowrap' }, cell.text)
      }
      case 'choice': {
        const group = el('div', { display: 'flex', gap: '4px', flexWrap: 'nowrap' })
        group.setAttribute('role', 'group')
        group.setAttribute('aria-label', `${column.header}, ${name}`)
        for (const option of cell.options) {
          const pressed = cell.value === option.value
          const button = el('button', controlStyle(pressed, option.tone), option.label)
          button.type = 'button'
          button.setAttribute('aria-pressed', String(pressed))
          button.setAttribute('aria-label', `Mark ${name} ${option.label}`)
          button.dataset.rosterKey = focusKey(student, column.key, option.value)
          button.addEventListener('click', () => act(slot, student, column.key, option.value))
          group.appendChild(button)
        }
        return group
      }
      case 'select': {
        const select = el('select', { ...controlStyle(false, null), cursor: 'pointer', maxWidth: '220px' })
        select.setAttribute('aria-label', `${column.header}, ${name}`)
        select.dataset.rosterKey = focusKey(student, column.key)
        const placeholder = el('option', {}, cell.placeholder || 'Choose…')
        placeholder.value = ''
        placeholder.disabled = true
        select.appendChild(placeholder)
        for (const option of cell.options) {
          const node = el('option', {}, option.label)
          node.value = option.value
          select.appendChild(node)
        }
        select.value = cell.value !== null && cell.options.some((o) => o.value === cell.value) ? cell.value : ''
        select.addEventListener('change', () => {
          if (select.value) act(slot, student, column.key, select.value)
        })
        return select
      }
      case 'button': {
        const solid = cell.variant === 'primary' ? C.primary : cell.variant === 'danger' ? C.danger : null
        const button = el('button', {
          ...controlStyle(false, null),
          ...(solid ? { background: solid, color: C.onSolid, border: `1px solid ${solid}` } : { background: C.muted }),
        }, cell.label)
        button.type = 'button'
        button.setAttribute('aria-label', `${cell.label}, ${name}`)
        button.dataset.rosterKey = focusKey(student, column.key, cell.value)
        button.addEventListener('click', () => act(slot, student, column.key, cell.value))
        return button
      }
    }
  }

  const cellStyle = (header: boolean): Style => ({
    padding: '0 10px',
    textAlign: 'left',
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
    borderTop: header ? '0' : `1px solid ${C.border}`,
    ...(header ? { font: `600 13px/1.2 ${FONT}`, color: C.mutedForeground, height: `${ROSTER_HEADER_PX}px` } : {}),
  })

  function buildTable(s: Slot): HTMLTableElement {
    const { slot, payload } = s
    const table = el('table', { width: '100%', borderCollapse: 'collapse' })
    table.setAttribute('aria-label', payload.label)
    if (!names) table.setAttribute('aria-busy', 'true')

    const head = el('tr')
    for (const header of ['Student', ...payload.columns.map((c) => c.header)]) {
      const th = el('th', cellStyle(true), header)
      th.scope = 'col'
      head.appendChild(th)
    }
    table.appendChild(el('thead')).appendChild(head)

    const body = table.appendChild(el('tbody'))
    const rowStyle: Style = { height: `${ROSTER_ROW_PX}px` }
    if (payload.rows.length === 0) {
      const td = el('td', { ...cellStyle(false), color: C.mutedForeground }, payload.emptyText || 'No students yet.')
      td.colSpan = payload.columns.length + 1
      body.appendChild(el('tr', rowStyle)).appendChild(td)
      return table
    }

    const query = fold(s.query.trim())
    let shown = 0
    for (const row of ordered(payload)) {
      const tr = el('tr', rowStyle)
      const name = nameOf(row.student)
      // Up to two lines, so a phone-width table still fits its controls.
      const th = el('th', { ...cellStyle(false), font: `500 15px/1.25 ${FONT}`, color: C.foreground, whiteSpace: 'normal', minWidth: '7rem', maxWidth: '16rem' })
      th.scope = 'row'
      if (names) {
        th.appendChild(el('span', { display: '-webkit-box', webkitLineClamp: '2', webkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }, name))
        th.title = name
      } else {
        // Names are still loading: a placeholder bar, and words for screen readers.
        th.appendChild(el('span', { display: 'inline-block', width: '9rem', height: '14px', borderRadius: '6px', background: C.muted })).setAttribute('aria-hidden', 'true')
        th.appendChild(el('span', { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' }, 'Loading name'))
      }
      tr.appendChild(th)
      const label = names ? name : 'student'
      for (const column of payload.columns) {
        const td = el('td', cellStyle(false))
        const cell = Object.hasOwn(row.cells, column.key) ? row.cells[column.key] : null
        if (cell) td.appendChild(cellContent(slot, row.student, label, column, cell))
        tr.appendChild(td)
      }
      // Search filters here and nowhere else: the plugin never hears about it.
      const match = !query || (names !== null && fold(name).includes(query))
      if (!match) tr.style.display = 'none'
      else shown += 1
      body.appendChild(tr)
    }
    if (shown === 0) {
      const td = el('td', { ...cellStyle(false), color: C.mutedForeground }, 'No students match your search.')
      td.colSpan = payload.columns.length + 1
      body.appendChild(el('tr', rowStyle)).appendChild(td)
    }
    return table
  }

  function syncSearch(s: Slot) {
    if (!s.payload.searchable) {
      s.searchBar?.remove()
      s.searchBar = null
      s.search = null
      s.query = ''
      return
    }
    if (!s.search) {
      const bar = el('div', { height: `${ROSTER_SEARCH_PX}px`, display: 'flex', alignItems: 'center', padding: '0 10px', boxSizing: 'border-box' })
      const input = el('input', { ...controlStyle(false, null), cursor: 'text', width: '100%', maxWidth: '320px', font: `400 15px/1.2 ${FONT}`, boxSizing: 'border-box' })
      input.type = 'search'
      input.placeholder = 'Search students'
      input.setAttribute('aria-label', 'Search students')
      input.addEventListener('input', () => {
        s.query = input.value
        drawTable(s)
      })
      bar.appendChild(input)
      s.box.insertBefore(bar, s.body)
      s.searchBar = bar
      s.search = input
    }
    s.search.disabled = names === null
  }

  function drawTable(s: Slot) {
    // A re-render replaces the table; keep keyboard focus on the same control.
    const active = document.activeElement
    const key = active instanceof HTMLElement && s.body.contains(active) ? active.dataset.rosterKey : undefined
    s.body.replaceChildren(buildTable(s))
    if (key) [...s.body.querySelectorAll<HTMLElement>('[data-roster-key]')].find((n) => n.dataset.rosterKey === key)?.focus()
  }

  function position(s: Slot, rect: RosterRect | undefined) {
    if (!rect) {
      s.box.style.display = 'none'
      return
    }
    Object.assign(s.box.style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  }

  function draw(slot: string) {
    const s = slots.get(slot)
    if (!s) return
    syncSearch(s)
    drawTable(s)
  }

  return {
    render(slot, payload) {
      if (destroyed) return true
      let s = slots.get(slot)
      if (!s) {
        if (slots.size >= ROSTER_MAX_SLOTS) return false
        const box = el('div', {
          position: 'absolute',
          boxSizing: 'border-box',
          overflowX: 'auto',
          overflowY: 'hidden',
          pointerEvents: 'auto',
          background: C.card,
          color: C.foreground,
          font: `400 14px/1.4 ${FONT}`,
          borderRadius: '14px',
          // Inset, so the border takes none of the height the kit reserved.
          boxShadow: `inset 0 0 0 1px ${C.border}`,
        })
        box.dataset.studioRoster = slot
        const body = box.appendChild(el('div'))
        s = { slot, payload, box, searchBar: null, search: null, query: '', body }
        slots.set(slot, s)
        ensureLayer().appendChild(box)
        position(s, rects.get(slot))
      }
      s.payload = payload
      askForNames()
      draw(slot)
      return true
    },
    place(slot, rect) {
      if (destroyed || (!slots.has(slot) && !rects.has(slot) && rects.size >= ROSTER_MAX_SLOTS)) return
      rects.set(slot, rect)
      const s = slots.get(slot)
      if (s) position(s, rect)
    },
    remove(slot) {
      slots.get(slot)?.box.remove()
      slots.delete(slot)
      rects.delete(slot)
    },
    destroy() {
      destroyed = true
      slots.clear()
      rects.clear()
      layer?.remove()
      layer = null
    },
  }
}
