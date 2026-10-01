// Client-side date/time renderer. Server components can't format with the
// viewer's timezone (Node renders in UTC), so date strings are passed through
// here to be formatted in the browser's locale + timezone.

'use client'

import { useSyncExternalStore } from 'react'

type Mode = 'datetime' | 'date' | 'time' | 'longdate'

interface Props {
  iso: string
  mode?: Mode
  /** Text shown on the server / before hydration (avoids mismatch). */
  fallback?: string
  className?: string
  /** Optional prefix like "Started" or "Ended" rendered alongside the time. */
  prefix?: string
}

// Worded month + numeric day/year (e.g. "Jun 15, 2026") instead of the
// ambiguous all-numeric mm/dd/yyyy. Still formatted in the viewer's locale +
// timezone in the browser.
const DATE_OPTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
// Full month name (e.g. "June 30, 2026") — used for the default session name.
const LONG_DATE_OPTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' }
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }

function format(iso: string, mode: Mode): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  if (mode === 'date') return d.toLocaleDateString(undefined, DATE_OPTS)
  if (mode === 'longdate') return d.toLocaleDateString(undefined, LONG_DATE_OPTS)
  if (mode === 'time') return d.toLocaleTimeString(undefined, TIME_OPTS)
  return d.toLocaleString(undefined, { ...DATE_OPTS, ...TIME_OPTS })
}

// Empty subscribe — the formatted string never changes after hydration for a
// given (iso, mode) pair, so we don't need to notify React of updates.
const noopSubscribe = () => () => {}

export function LocalDateTime({ iso, mode = 'datetime', fallback = '…', className, prefix }: Props) {
  // useSyncExternalStore drives the SSR/CSR split: server snapshot returns
  // the stable fallback (no Intl access at render-time), client snapshot
  // formats with the browser's locale + timezone. Avoids the
  // set-state-in-effect anti-pattern that React 19 flags.
  const text = useSyncExternalStore(
    noopSubscribe,
    () => format(iso, mode) ?? fallback,
    () => fallback,
  )

  const body = prefix && text ? `${prefix} ${text}` : text
  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {body}
    </time>
  )
}
