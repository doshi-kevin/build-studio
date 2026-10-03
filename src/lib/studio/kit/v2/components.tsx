/**
 * The Studio plugin kit, v2 (docs/designs/studio/studio-builder-quality.md 3.6). Trusted
 * Scholera code that runs inside the plugin frame and ships in vendor.js v2, never in a
 * plugin's bundle. A superset of v1, so a v1 draft upgrades on its next build.
 *
 * The same rules as v1, over a larger vocabulary:
 *   - No component takes `style` or `className`. Colours come only from kit.css tokens,
 *     chosen through `tone` props (rule 7.1). The few `style` props below are the kit's
 *     own geometry (a bar's width, the roster's reserved height), applied through CSSOM,
 *     which the frame's style-src allows; none is reachable from plugin code.
 *   - Every control is at least 44 px and labelled (rules 7.3, 7.4).
 *   - Loading, Empty and ErrorState carry `data-kit-state` (rule 7.5). ErrorState still
 *     takes no message: a raw error never reaches the screen.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ROSTER_LIMITS, rosterHeight } from '../../runtime/roster-layout'

type Children = { children?: ReactNode }
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
type Gap = 'xsmall' | 'small' | 'medium' | 'large'

// ── Icons: inline SVG, since the frame's img-src is 'none' ──────────────────

function Icon({ name }: { name: 'info' | 'success' | 'warning' | 'danger' | 'empty' | 'search' | 'chevron' }) {
  const paths = {
    info: ['M12 16v-4', 'M12 8h.01', 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z'],
    success: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z', 'm9 12 2 2 4-4'],
    warning: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
    danger: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z', 'm15 9-6 6', 'm9 9 6 6'],
    empty: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
    search: ['m21 21-4.34-4.34', 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z'],
    chevron: ['m6 9 6 6 6-6'],
  }[name]
  return (
    <svg className={`kit-icon kit-icon-${name}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

const toneIcon = (tone: Tone) => (tone === 'neutral' ? 'info' : tone)

// ── Layout ──────────────────────────────────────────────────────────────────

type Heading = { title?: string; description?: string; actions?: ReactNode }

function Header({ title, description, actions, level, id }: Heading & { level: 1 | 2 | 3; id?: string }) {
  if (!title && !description && !actions) return null
  const Tag = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'
  return (
    <header className={`kit-header kit-header-${level}`}>
      <div className="kit-header-text">
        {title ? (
          <Tag id={id} className={`kit-heading kit-heading-${level}`}>
            {title}
          </Tag>
        ) : null}
        {description ? <p className="kit-description">{description}</p> : null}
      </div>
      {actions ? <div className="kit-actions">{actions}</div> : null}
    </header>
  )
}

export function Screen({ title, description, actions, width = 'normal', children }: Heading & { width?: 'normal' | 'wide' } & Children) {
  return (
    <main className={`kit-screen kit-screen-${width}`}>
      <Header title={title} description={description} actions={actions} level={1} />
      {children}
    </main>
  )
}

export function Section({ title, description, actions, children }: Heading & Children) {
  const id = useId()
  return (
    <section className="kit-section" aria-labelledby={title ? id : undefined}>
      <Header title={title} description={description} actions={actions} level={2} id={id} />
      {children}
    </section>
  )
}

export function Card({ title, description, actions, tone = 'neutral', children }: Heading & { tone?: Tone } & Children) {
  const id = useId()
  return (
    <section className={`kit-card kit-tone-${tone}`} aria-labelledby={title ? id : undefined}>
      <Header title={title} description={description} actions={actions} level={3} id={id} />
      {children}
    </section>
  )
}

export function Stack({
  direction = 'column',
  gap = 'medium',
  align,
  justify = 'start',
  wrap,
  children,
}: {
  direction?: 'row' | 'column'
  gap?: Gap
  align?: 'start' | 'center' | 'end' | 'stretch'
  justify?: 'start' | 'between' | 'end'
  wrap?: boolean
} & Children) {
  // v1 rows wrapped and centred; that stays the default.
  const a = align ?? (direction === 'row' ? 'center' : 'stretch')
  const w = wrap ?? direction === 'row'
  return <div className={`kit-stack kit-stack-${direction} kit-gap-${gap} kit-align-${a} kit-justify-${justify}${w ? ' kit-wrap' : ''}`}>{children}</div>
}

export function Grid({ columns, gap = 'medium', children }: { columns: 1 | 2 | 3 | 4; gap?: Gap } & Children) {
  return <div className={`kit-grid kit-grid-${columns} kit-gap-${gap}`}>{children}</div>
}

export function Divider() {
  return <hr className="kit-divider" />
}

// ── Text ────────────────────────────────────────────────────────────────────

export function Heading({ level = 2, children }: { level?: 2 | 3 } & Children) {
  const Tag = level === 2 ? 'h2' : 'h3'
  return <Tag className={`kit-heading kit-heading-${level}`}>{children}</Tag>
}

export function Text({
  tone = 'default',
  size = 'medium',
  weight = 'regular',
  children,
}: {
  tone?: 'default' | 'muted' | 'success' | 'warning' | 'danger'
  size?: 'small' | 'medium' | 'large'
  weight?: 'regular' | 'medium' | 'bold'
} & Children) {
  return <p className={`kit-text kit-text-${tone} kit-size-${size} kit-weight-${weight}`}>{children}</p>
}

// ── Data ────────────────────────────────────────────────────────────────────

export function Badge({ tone = 'neutral', children }: { tone?: Tone } & Children) {
  return <span className={`kit-badge kit-tone-${tone}`}>{children}</span>
}

export function StatCard({ label, value, hint, tone = 'neutral' }: { label: string; value: string | number; hint?: string; tone?: Tone }) {
  return (
    <div className={`kit-stat kit-stat-${tone}`}>
      <p className="kit-stat-label">{label}</p>
      <p className="kit-stat-value">{typeof value === 'number' ? formatNumber(value) : value}</p>
      {hint ? <p className="kit-stat-hint">{hint}</p> : null}
    </div>
  )
}

type Align = 'start' | 'center' | 'end'

export function DataTable({
  label,
  columns,
  rows,
  emptyText = 'Nothing here yet.',
}: {
  label: string
  columns: readonly { key: string; header: string; align?: Align }[]
  rows: readonly { key: string; cells: Record<string, ReactNode> }[]
  emptyText?: string
}) {
  // The table scrolls inside its own box, never the page. A scrolling region must be
  // reachable by keyboard, so it takes focus and carries the table's name.
  return (
    <div className="kit-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="kit-table">
        <caption className="kit-sr-only">{label}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`kit-cell-${c.align ?? 'start'}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="kit-table-empty" colSpan={Math.max(columns.length, 1)}>
                {emptyText}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.key}>
                {columns.map((c) => (
                  <td key={c.key} className={`kit-cell-${c.align ?? 'start'}`}>
                    {row.cells[c.key] ?? null}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

export function List({ label, children }: { label?: string } & Children) {
  return (
    <ul className="kit-list" aria-label={label}>
      {children}
    </ul>
  )
}

export function ListItem({ title, description, meta, actions }: { title: string; description?: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <li className="kit-list-item">
      <div className="kit-list-main">
        <p className="kit-list-title">{title}</p>
        {description ? <p className="kit-list-description">{description}</p> : null}
      </div>
      {meta !== undefined && meta !== null ? <div className="kit-list-meta">{meta}</div> : null}
      {actions ? <div className="kit-actions">{actions}</div> : null}
    </li>
  )
}

const share = (value: number, max: number) => (max > 0 && Number.isFinite(value) ? Math.min(Math.max(value / max, 0), 1) * 100 : 0)

export function ProgressBar({ label, value, max = 100, tone = 'info', showValue = true }: { label: string; value: number; max?: number; tone?: Tone; showValue?: boolean }) {
  const id = useId()
  const pct = share(value, max)
  return (
    <div className="kit-progress">
      <div className="kit-progress-head">
        <span id={id} className="kit-progress-label">
          {label}
        </span>
        {showValue ? <span className="kit-progress-value">{Math.round(pct)}%</span> : null}
      </div>
      <div className="kit-progress-track" role="progressbar" aria-labelledby={id} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(Math.max(value, 0), max)}>
        <div className={`kit-progress-fill kit-fill-${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function BarChart({
  label,
  data,
  max,
  tone = 'info',
  valueSuffix = '',
}: {
  label: string
  data: readonly { label: string; value: number }[]
  max?: number
  tone?: Tone
  valueSuffix?: string
}) {
  const id = useId()
  const top = max ?? Math.max(0, ...data.map((d) => d.value))
  // Each row reads as text ("Week 3 12"); the bars are decoration over it.
  return (
    <figure className="kit-chart" aria-labelledby={id}>
      <figcaption id={id} className="kit-chart-label">
        {label}
      </figcaption>
      {data.length === 0 ? (
        <p className="kit-text kit-text-muted kit-size-small">No data yet.</p>
      ) : (
        <ul className="kit-bars">
          {data.map((d, i) => (
            <li key={`${i}-${d.label}`} className="kit-bar-row">
              <span className="kit-bar-label">{d.label}</span>
              <span className="kit-bar-track" aria-hidden="true">
                <span className={`kit-bar-fill kit-fill-${tone}`} style={{ width: `${share(d.value, top)}%` }} />
              </span>
              <span className="kit-bar-value">
                {formatNumber(d.value)}
                {valueSuffix}
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  )
}

// ── Inputs ──────────────────────────────────────────────────────────────────

export function Button({
  onPress,
  variant = 'primary',
  disabled = false,
  fullWidth = false,
  children,
}: { onPress?: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; disabled?: boolean; fullWidth?: boolean } & Children) {
  return (
    <button type="button" className={`kit-button kit-button-${variant}${fullWidth ? ' kit-button-full' : ''}`} onClick={onPress} disabled={disabled}>
      {children}
    </button>
  )
}

/** Arrow keys, Home and End over a row of options: the next index, or null. */
function rovingKey(e: KeyboardEvent, index: number, count: number): number | null {
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return (index + 1) % count
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') return (index - 1 + count) % count
  if (e.key === 'Home') return 0
  if (e.key === 'End') return count - 1
  return null
}

function useRoving(values: readonly string[], value: string, onChange: (value: string) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const selected = values.indexOf(value)
  return {
    ref: (i: number) => (el: HTMLButtonElement | null) => {
      refs.current[i] = el
    },
    tabIndex: (i: number) => (i === (selected === -1 ? 0 : selected) ? 0 : -1),
    onKeyDown: (i: number) => (e: KeyboardEvent) => {
      const next = rovingKey(e, i, values.length)
      if (next === null) return
      e.preventDefault()
      onChange(values[next])
      refs.current[next]?.focus()
    },
  }
}

export function SegmentedControl({ label, value, options, onChange }: { label: string; value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void }) {
  const roving = useRoving(
    options.map((o) => o.value),
    value,
    onChange,
  )
  return (
    <div className="kit-segmented" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={roving.ref(i)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={roving.tabIndex(i)}
          className="kit-segment"
          onClick={() => onChange(o.value)}
          onKeyDown={roving.onKeyDown(i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Tabs({ label, value, onChange, tabs }: { label: string; value: string; onChange: (value: string) => void; tabs: readonly { value: string; label: string; count?: number }[] }) {
  const roving = useRoving(
    tabs.map((t) => t.value),
    value,
    onChange,
  )
  return (
    <div className="kit-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.value}
          ref={roving.ref(i)}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          tabIndex={roving.tabIndex(i)}
          className="kit-tab"
          onClick={() => onChange(t.value)}
          onKeyDown={roving.onKeyDown(i)}
        >
          {t.label}{' '}
          {t.count !== undefined ? <span className="kit-tab-count">{formatNumber(t.count)}</span> : null}
        </button>
      ))}
    </div>
  )
}

function Field({ id, label, hint, hintId, hideLabel = false, children }: { id: string; label: string; hint?: string; hintId: string; hideLabel?: boolean } & Children) {
  return (
    <div className="kit-field">
      <label className={hideLabel ? 'kit-sr-only' : 'kit-label'} htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? (
        <p id={hintId} className="kit-hint">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function TextField({
  label,
  value,
  onChange,
  multiline = false,
  placeholder,
  hint,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  multiline?: boolean
  placeholder?: string
  hint?: string
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const describedBy = hint ? hintId : undefined
  return (
    <Field id={id} label={label} hint={hint} hintId={hintId}>
      {multiline ? (
        <textarea id={id} className="kit-input kit-textarea" value={value} placeholder={placeholder} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={id} className="kit-input" value={value} placeholder={placeholder} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  )
}

export function NumberField({ label, value, onChange, min, max, step }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number }) {
  const id = useId()
  // The box keeps what was typed ("", "1.", "-") and reports only whole numbers in
  // range, so the plugin's state is always a usable number.
  const [text, setText] = useState(String(value))
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    if (Number(text) !== value || text.trim() === '') setText(String(value))
  }
  return (
    <Field id={id} label={label} hintId={`${id}-hint`}>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        className="kit-input kit-input-number"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value.trim() === '' || !Number.isFinite(n)) return
          if ((min !== undefined && n < min) || (max !== undefined && n > max)) return
          onChange(n)
        }}
      />
    </Field>
  )
}

export function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId()
  return (
    <Field id={id} label={label} hintId={`${id}-hint`}>
      <input id={id} type="date" className="kit-input" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  )
}

export function SearchField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  const id = useId()
  return (
    <Field id={id} label={label} hintId={`${id}-hint`} hideLabel>
      <div className="kit-input-wrap">
        <Icon name="search" />
        <input id={id} type="search" className="kit-input kit-input-search" value={value} placeholder={placeholder ?? label} onChange={(e) => onChange(e.target.value)} />
      </div>
    </Field>
  )
}

export function Select({
  label,
  value,
  options,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
  placeholder?: string
}) {
  const id = useId()
  return (
    <Field id={id} label={label} hintId={`${id}-hint`}>
      <div className="kit-input-wrap">
        <select id={id} className="kit-input kit-select" value={value} onChange={(e) => onChange(e.target.value)}>
          {placeholder !== undefined || !options.some((o) => o.value === value) ? (
            <option value="" disabled>
              {placeholder ?? 'Choose…'}
            </option>
          ) : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevron" />
      </div>
    </Field>
  )
}

export function Checkbox({ label, checked, onChange, description }: { label: string; checked: boolean; onChange: (checked: boolean) => void; description?: string }) {
  const id = useId()
  return (
    <div className="kit-check">
      <input id={id} type="checkbox" className="kit-checkbox" checked={checked} aria-describedby={description ? `${id}-d` : undefined} onChange={(e) => onChange(e.target.checked)} />
      <div className="kit-check-text">
        <label className="kit-label" htmlFor={id}>
          {label}
        </label>
        {description ? (
          <p id={`${id}-d`} className="kit-hint">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export function Switch({ label, checked, onChange, description }: { label: string; checked: boolean; onChange: (checked: boolean) => void; description?: string }) {
  const id = useId()
  return (
    <div className="kit-switch-row">
      <div className="kit-check-text">
        <label className="kit-label" htmlFor={id}>
          {label}
        </label>
        {description ? (
          <p id={`${id}-d`} className="kit-hint">
            {description}
          </p>
        ) : null}
      </div>
      <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={description ? `${id}-d` : undefined} className="kit-switch" onClick={() => onChange(!checked)}>
        <span className="kit-switch-track" aria-hidden="true">
          <span className="kit-switch-thumb" />
        </span>
      </button>
    </div>
  )
}

// ── Feedback ────────────────────────────────────────────────────────────────

export function Alert({ tone, title, children }: { tone: Tone; title: string } & Children) {
  return (
    <div className={`kit-alert kit-tone-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={toneIcon(tone)} />
      <div className="kit-alert-text">
        <p className="kit-alert-title">{title}</p>
        {children ? <div className="kit-alert-body">{children}</div> : null}
      </div>
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="kit-state kit-loading" data-kit-state="loading" role="status" aria-live="polite">
      <span className="kit-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

export function Empty({ title, description, children }: { title: string; description?: string } & Children) {
  return (
    <div className="kit-state kit-empty" data-kit-state="empty">
      <span className="kit-state-icon">
        <Icon name="empty" />
      </span>
      <p className="kit-state-title">{title}</p>
      {description ? <p className="kit-state-description">{description}</p> : null}
      {children ? <div className="kit-actions">{children}</div> : null}
    </div>
  )
}

/** Plain language only, by construction: there is no prop for an error's text. */
export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="kit-state kit-error" data-kit-state="error" role="alert">
      <span className="kit-state-icon">
        <Icon name="danger" />
      </span>
      <p className="kit-state-title">Something went wrong</p>
      <p className="kit-state-description">This didn’t load. Try again in a moment.</p>
      {onRetry ? (
        <button type="button" className="kit-button kit-button-secondary" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  )
}

// ── Roster (host-rendered, 3.4) ─────────────────────────────────────────────

export type RosterCell =
  | { kind: 'text'; text: string }
  | { kind: 'badge'; text: string; tone: Tone }
  | { kind: 'choice'; value: string | null; options: readonly { value: string; label: string; tone: Tone }[] }
  | { kind: 'select'; value: string | null; placeholder: string; options: readonly { value: string; label: string }[] }
  | { kind: 'button'; label: string; value: string; variant: 'primary' | 'secondary' | 'danger' }

type RosterPayload = {
  label: string
  sort: 'name' | 'given'
  searchable: boolean
  columns: { key: string; header: string }[]
  rows: { student: string; cells: Record<string, RosterCell> }[]
  emptyText: string
}
type RosterRect = { x: number; y: number; width: number; height: number }
type RosterApi = { render(slot: string, payload: RosterPayload): void; place(slot: string, rect: RosterRect): void; remove(slot: string): void }
type RosterAction = { slot: string; student: string; column: string; value: string }
type StudioRuntime = {
  context?: { view?: string }
  roster?: RosterApi
  on?: (name: 'roster.action', handler: (data: RosterAction) => void) => () => void
}

const L = ROSTER_LIMITS
const cut = (s: unknown, n: number) => String(s ?? '').slice(0, n)

/** Clamps a cell to the host's strict parse, so a long label shortens instead of
 * striking the frame. Unknown kinds are dropped. */
function clampCell(cell: RosterCell): RosterCell | null {
  switch (cell?.kind) {
    case 'text':
      return { kind: 'text', text: cut(cell.text, L.text) }
    case 'badge':
      return { kind: 'badge', text: cut(cell.text, L.badge), tone: cell.tone }
    case 'choice':
      // Fewer than two options isn't a choice; the host would refuse the whole payload.
      if (cell.options.length < L.choiceOptions.min) return null
      return {
        kind: 'choice',
        value: cell.value === null ? null : cut(cell.value, L.value),
        options: cell.options.slice(0, L.choiceOptions.max).map((o) => ({ value: cut(o.value, L.value), label: cut(o.label, L.optionLabel), tone: o.tone })),
      }
    case 'select':
      return {
        kind: 'select',
        value: cell.value === null ? null : cut(cell.value, L.value),
        placeholder: cut(cell.placeholder, L.selectPlaceholder),
        options: cell.options.slice(0, L.selectOptions).map((o) => ({ value: cut(o.value, L.value), label: cut(o.label, L.optionLabel) })),
      }
    case 'button':
      return { kind: 'button', label: cut(cell.label, L.buttonLabel), value: cut(cell.value, L.value), variant: cell.variant }
    default:
      return null
  }
}

function runtime(): StudioRuntime | null {
  return (globalThis as { ScholeraStudio?: StudioRuntime }).ScholeraStudio ?? null
}

type RosterTableProps = {
  label: string
  students: readonly string[]
  columns: readonly { key: string; header: string }[]
  cells: (student: string) => Record<string, RosterCell>
  onAction?: (student: string, column: string, value: string) => void
  sort?: 'name' | 'given'
  searchable?: boolean
  emptyText?: string
}

/**
 * The class list with names. The plugin passes handles and cells; Scholera draws the
 * table, names included, over the box this reserves (3.4). Names, the name order and
 * the search query never enter the frame. Outside a professor view on a v2 runtime
 * there is no roster to draw, so it shows Empty.
 */
export function RosterTable(props: RosterTableProps) {
  const studio = runtime()
  if (studio?.context?.view !== 'professor' || !studio.roster) {
    return <Empty title="Class list unavailable" description="Scholera shows the class list to instructors here." />
  }
  return <RosterSlot {...props} api={studio.roster} on={studio.on} />
}

const PLACE_MS = 100

function RosterSlot({ label, students, columns, cells, onAction, sort = 'name', searchable, emptyText = 'No students yet.', api, on }: RosterTableProps & { api: RosterApi; on: StudioRuntime['on'] }) {
  const slot = `r${useId().replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 16)
  const box = useRef<HTMLDivElement>(null)
  const search = searchable ?? students.length > 10
  // A key the host's parse would refuse drops its column rather than the frame.
  const shown = columns.filter((c, i) => L.columnKey.test(c.key) && columns.findIndex((d) => d.key === c.key) === i).slice(0, L.columns)
  const keys = shown.map((c) => c.key)
  const payload: RosterPayload = {
    label: cut(label, L.label),
    sort,
    searchable: search,
    columns: shown.map((c) => ({ key: c.key, header: cut(c.header, L.header) })),
    rows: students.slice(0, L.rows).map((student) => {
      const given = cells(student) ?? {}
      const out: Record<string, RosterCell> = {}
      for (const key of keys) {
        const cell = Object.hasOwn(given, key) ? clampCell(given[key]) : null
        if (cell) out[key] = cell
      }
      return { student, cells: out }
    }),
    emptyText: cut(emptyText, L.emptyText),
  }
  const json = JSON.stringify(payload)

  useEffect(() => {
    api.render(slot, JSON.parse(json) as RosterPayload)
  }, [api, slot, json])

  const action = useRef(onAction)
  useEffect(() => {
    action.current = onAction
  })
  useEffect(() => {
    if (!on) return
    return on('roster.action', (data) => {
      if (data && data.slot === slot) action.current?.(data.student, data.column, data.value)
    })
  }, [on, slot])

  // Placement: the host draws over this box, so it learns the box's frame-viewport rect
  // whenever it moves. Deduplicated, and throttled to 10 a second with a trailing call so
  // the last position always lands within the host's 20-a-second bound.
  useEffect(() => {
    const el = box.current
    if (!el) return
    let last = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const place = () => {
      timer = null
      const r = el.getBoundingClientRect()
      const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
      if (key === last) return
      last = key
      api.place(slot, rect)
    }
    const schedule = () => {
      timer ??= setTimeout(place, PLACE_MS)
    }
    place()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    observer?.observe(el)
    observer?.observe(document.body)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      if (timer) clearTimeout(timer)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      api.remove(slot)
    }
  }, [api, slot])

  return <div ref={box} className="kit-roster-slot" data-kit-roster={slot} aria-hidden="true" style={{ height: rosterHeight(payload.rows.length, search) }} />
}

// ── Data hooks ──────────────────────────────────────────────────────────────

type RequestFn = (method: string, args?: unknown) => Promise<unknown>

export interface PluginRecord<D = Record<string, unknown>> {
  id: string
  data: D
  mine: boolean
  student?: string
  createdAt: string
  updatedAt: string
}

export type RecordChange<D> = { op: 'create'; data: D; student?: string } | { op: 'update'; record: PluginRecord<D>; data: D } | { op: 'delete'; record: PluginRecord<D> }

const PAGE = 100
const RECORDS_MAX = 1000
const BATCH_MAX = 50

async function listAll<D>(request: RequestFn, collection: string): Promise<PluginRecord<D>[]> {
  const all: PluginRecord<D>[] = []
  for (let offset = 0; offset < RECORDS_MAX; offset += PAGE) {
    const page = await request('records.list', { collection, limit: PAGE, offset })
    if (!Array.isArray(page)) throw new Error('records.list returned no list')
    all.push(...(page as PluginRecord<D>[]))
    if (page.length < PAGE) break
  }
  return all.slice(0, RECORDS_MAX)
}

type BatchResult = { ok: true; record: PluginRecord | null } | { ok: false; code: string }

/**
 * A collection as UI state. It loads every page (up to 1000 records), and each write
 * patches the list with what the server returned. A failed write reloads instead, since
 * the list may then be stale. Writes never reject, so a forgotten `.catch` can't crash
 * the frame: they resolve to whether everything was saved.
 */
export function makeUseRecords(request: RequestFn) {
  return function useRecords<D = Record<string, unknown>>(collection: string) {
    const [attempt, setAttempt] = useState(0)
    const key = `${collection}\n${attempt}`
    const [state, setState] = useState<{ key: string; status: 'ready' | 'error'; records: PluginRecord<D>[] } | null>(null)
    const retry = useCallback(() => setAttempt((n) => n + 1), [])

    useEffect(() => {
      let live = true
      listAll<D>(request, collection).then(
        (records) => live && setState({ key, status: 'ready', records }),
        () => live && setState({ key, status: 'error', records: [] }),
      )
      return () => {
        live = false
      }
    }, [collection, key])

    const patch = useCallback(
      (f: (records: PluginRecord<D>[]) => PluginRecord<D>[]) => setState((s) => (s && s.key === key && s.status === 'ready' ? { ...s, records: f(s.records) } : s)),
      [key],
    )
    const reload = useCallback(() => {
      listAll<D>(request, collection).then(
        (records) => setState((s) => (s && s.key === key ? { key, status: 'ready', records } : s)),
        () => undefined,
      )
    }, [collection, key])
    const write = useCallback(
      (method: string, args: object, apply: (result: unknown) => void) =>
        request(method, { collection, ...args }).then(
          (result) => {
            apply(result)
            return true
          },
          () => {
            reload()
            return false
          },
        ),
      [collection, reload],
    )

    const create = useCallback(
      (data: D, student?: string) => write('records.create', student === undefined ? { data } : { data, student }, (r) => patch((list) => [...list, r as PluginRecord<D>])),
      [write, patch],
    )
    const update = useCallback(
      (record: PluginRecord<D>, data: D) => write('records.update', { recordId: record.id, data }, (r) => patch((list) => list.map((x) => (x.id === record.id ? (r as PluginRecord<D>) : x)))),
      [write, patch],
    )
    const remove = useCallback((record: PluginRecord<D>) => write('records.delete', { recordId: record.id }, () => patch((list) => list.filter((x) => x.id !== record.id))), [write, patch])
    const saveMany = useCallback(
      async (items: readonly RecordChange<D>[]) => {
        let allSaved = true
        for (let i = 0; i < items.length; i += BATCH_MAX) {
          const chunk = items.slice(i, i + BATCH_MAX)
          const wire = chunk.map((item) =>
            item.op === 'create'
              ? item.student === undefined
                ? { op: 'create', data: item.data }
                : { op: 'create', data: item.data, student: item.student }
              : item.op === 'update'
                ? { op: 'update', recordId: item.record.id, data: item.data }
                : { op: 'delete', recordId: item.record.id },
          )
          const saved = await write('records.batch', { items: wire }, (result) => {
            const results = (result as { results?: BatchResult[] } | null)?.results ?? []
            patch((list) => {
              let next = list
              chunk.forEach((item, j) => {
                const r = results[j]
                if (!r?.ok) return
                const record = r.record as PluginRecord<D> | null
                if (item.op === 'create' && record) next = [...next, record]
                else if (item.op === 'update' && record) next = next.map((x) => (x.id === item.record.id ? record : x))
                else if (item.op === 'delete') next = next.filter((x) => x.id !== item.record.id)
              })
              return next
            })
            if (results.length !== chunk.length || results.some((r) => !r?.ok)) {
              allSaved = false
              reload()
            }
          })
          if (!saved) allSaved = false
        }
        return allSaved
      },
      [write, patch, reload],
    )

    const current = state?.key === key ? state : null
    return {
      status: current?.status ?? ('loading' as const),
      records: current?.records ?? [],
      retry,
      create,
      update,
      remove,
      saveMany,
    }
  }
}

type UseRequest = <T>(method: string, args?: unknown) => { status: 'loading' | 'ready' | 'error'; data?: T; retry: () => void }

/** The class as handles, in handle order (never name order). Professor views only. */
export function makeUseRoster(useRequest: UseRequest) {
  return function useRoster() {
    const r = useRequest<{ students?: { handle?: unknown }[] }>('course.roster')
    const students = useMemo(
      () => (Array.isArray(r.data?.students) ? r.data.students.map((s) => s?.handle).filter((h): h is string => typeof h === 'string') : []),
      [r.data],
    )
    return { status: r.status, students, retry: r.retry }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  return Number.isFinite(n) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n) : '–'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Today as YYYY-MM-DD, in the viewer's time zone. */
export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A date for people. A bare YYYY-MM-DD is a calendar day, not UTC midnight, so it never
 * shifts a day in the viewer's zone. Anything unparseable comes back as it was. */
export function formatDate(iso: string, style: 'short' | 'long' = 'short'): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  const d = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const options: Intl.DateTimeFormatOptions =
    style === 'long'
      ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }
  return new Intl.DateTimeFormat(undefined, options).format(d)
}
