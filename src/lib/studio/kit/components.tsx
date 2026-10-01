/**
 * The Studio plugin kit, v1: the only components plugin screens are built from (rule
 * 7.1). Trusted Scholera code. It runs inside the plugin frame, but it ships in the
 * runtime's own vendor.js, never in a plugin's bundle, so the validator scans plugin
 * code alone (docs/reference/studio-plugin-validator.md).
 *
 * Deliberately small: what the rules require and nothing more.
 *   - Colors and spacing come only from kit.css tokens. No component takes `style` or
 *     `className`, so a plugin has no way to hard-code a color (rule 7.1).
 *   - Every control is at least 44 px and labelled (rules 7.3, 7.4).
 *   - Loading, Empty and ErrorState carry `data-kit-state`, which the runtime validator
 *     looks for (rule 7.5). ErrorState takes no message: a raw error never reaches the
 *     screen.
 */
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'

type Children = { children?: ReactNode }

export function Screen({ title, children }: { title?: string } & Children) {
  return (
    <main className="kit-screen">
      {title ? <h1 className="kit-heading kit-heading-1">{title}</h1> : null}
      {children}
    </main>
  )
}

export function Stack({ direction = 'column', gap = 'medium', children }: { direction?: 'row' | 'column'; gap?: 'small' | 'medium' | 'large' } & Children) {
  return <div className={`kit-stack kit-stack-${direction} kit-gap-${gap}`}>{children}</div>
}

export function Card({ children }: Children) {
  return <section className="kit-card">{children}</section>
}

export function Heading({ level = 2, children }: { level?: 2 | 3 } & Children) {
  const Tag = level === 2 ? 'h2' : 'h3'
  return <Tag className={`kit-heading kit-heading-${level}`}>{children}</Tag>
}

export function Text({ tone = 'default', children }: { tone?: 'default' | 'muted' } & Children) {
  return <p className={`kit-text kit-text-${tone}`}>{children}</p>
}

export function Button({
  onPress,
  variant = 'primary',
  disabled = false,
  children,
}: { onPress?: () => void; variant?: 'primary' | 'secondary'; disabled?: boolean } & Children) {
  return (
    <button type="button" className={`kit-button kit-button-${variant}`} onClick={onPress} disabled={disabled}>
      {children}
    </button>
  )
}

export function TextField({
  label,
  value,
  onChange,
  multiline = false,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  multiline?: boolean
  placeholder?: string
}) {
  const id = useId()
  return (
    <div className="kit-field">
      <label className="kit-label" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea id={id} className="kit-input kit-textarea" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={id} className="kit-input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  )
}

export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId()
  return (
    <div className="kit-check">
      <input id={id} type="checkbox" className="kit-checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label className="kit-label" htmlFor={id}>
        {label}
      </label>
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
      <p className="kit-heading kit-heading-3">{title}</p>
      {description ? <p className="kit-text kit-text-muted">{description}</p> : null}
      {children}
    </div>
  )
}

/** Plain language only, by construction: there is no prop for an error's text. */
export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="kit-state kit-error" data-kit-state="error" role="alert">
      <p className="kit-heading kit-heading-3">Something went wrong</p>
      <p className="kit-text kit-text-muted">This didn’t load. Try again in a moment.</p>
      {onRetry ? (
        <button type="button" className="kit-button kit-button-secondary" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  )
}

type RequestFn = (method: string, args?: unknown) => Promise<unknown>

/** One Bridge request as UI state: loading, then ready or error, with retry. */
export function makeUseRequest(request: RequestFn) {
  return function useRequest<T = unknown>(method: string, args?: unknown) {
    const key = JSON.stringify(args ?? null)
    const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; data?: T }>({ status: 'loading' })
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
      let live = true
      setState({ status: 'loading' })
      // Rebuilt from `key`, so callers can pass arguments built inline without a loop.
      request(method, JSON.parse(key) as unknown).then(
        (data) => live && setState({ status: 'ready', data: data as T }),
        () => live && setState({ status: 'error' }),
      )
      return () => {
        live = false
      }
    }, [method, key, attempt])
    const retry = useCallback(() => setAttempt((n) => n + 1), [])
    return { ...state, retry }
  }
}
