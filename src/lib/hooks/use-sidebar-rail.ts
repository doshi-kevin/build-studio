'use client'

/**
 * Sidebar open-behavior preference + collapsible-rail state.
 *
 * Two open modes, persisted per-browser in localStorage:
 *   • 'click' (default) — the rail ignores mouse enter/leave; it only opens/closes
 *     via the explicit toggle button on the rail. Default because a rail that
 *     pops in and out under the pointer reads as jitter, not as an affordance.
 *   • 'hover' — the course rail expands on pointer/focus enter and collapses
 *     500ms after the pointer/focus leaves. Opt in from the Preferences dialog.
 *
 * The preference is set from the header Preferences dialog and consumed by the
 * course rails (professor + student), which live in a different part of the
 * tree. `useSidebarOpenMode` keeps them in sync in the same tab via a custom
 * event (the native `storage` event only fires in OTHER tabs). Persistence is
 * intentionally localStorage, not the DB: a cosmetic per-browser preference
 * with no tenant/security implications.
 */

import { useState, useEffect, useRef, useCallback } from 'react'

export type SidebarOpenMode = 'hover' | 'click'

const STORAGE_KEY = 'scholera_sidebar_open_mode'
const EXPANDED_KEY = 'scholera_sidebar_expanded'
const MODE_EVENT = 'scholera:sidebar-open-mode'
const COLLAPSE_DELAY_MS = 500

function readMode(): SidebarOpenMode {
  if (typeof window === 'undefined') return 'click'
  try {
    return localStorage.getItem(STORAGE_KEY) === 'hover' ? 'hover' : 'click'
  } catch {
    return 'click'
  }
}

function writeMode(mode: SidebarOpenMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* storage unavailable — the preference just won't persist */
  }
  // Notify same-tab listeners; the native 'storage' event only fires cross-tab.
  window.dispatchEvent(new CustomEvent(MODE_EVENT))
}

/**
 * Reactive access to the persisted open-mode preference. Shared by the rail and
 * the Preferences dialog; any setter call updates every mounted consumer.
 * Starts 'click' (the default) so SSR and the first client render agree (avoids a
 * hydration mismatch); the stored value is read after mount.
 */
export function useSidebarOpenMode(): [SidebarOpenMode, (mode: SidebarOpenMode) => void] {
  const [mode, setModeState] = useState<SidebarOpenMode>('click')

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModeState(readMode())
    const sync = () => setModeState(readMode())
    window.addEventListener(MODE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(MODE_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const setMode = useCallback((next: SidebarOpenMode) => {
    writeMode(next)
    setModeState(next)
  }, [])

  return [mode, setMode]
}

export function useSidebarRail() {
  const [mode] = useSidebarOpenMode()
  /* Starts collapsed so SSR and the first client render agree; the stored value is
     read after mount. In click mode the rail is a DOCKED panel that reflows the
     page, so "was it open" has to survive reload and course switches — otherwise
     the professor re-opens it on every navigation, which is the opposite of the
     "stay in a single place" they asked for. Hover mode never persists: it is
     transient by definition. */
  const [expanded, setExpanded] = useState(false)
  /* Width transitions are OFF for the first tick. The restore below runs in an
     effect (it has to — reading localStorage during render breaks hydration), so
     with transitions live the remembered-open rail animates from 56→224px on every
     reload and course switch, dragging the page content across with it. Enabling
     them a tick later means the restore lands instantly and only real user toggles
     animate. */
  const [animate, setAnimate] = useState(false)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setAnimate(true), 0)
    return () => clearTimeout(t)
  }, [])

  /* Tracks whether we've already reacted to a mode value, so the two concerns
     below stay separable. They MUST NOT be two effects both keyed on [mode]:
     since 'click' became the default, a collapse-on-click effect fires on every
     mount and would stamp out the restored state on the same commit. */
  const seenMode = useRef<SidebarOpenMode | null>(null)

  useEffect(() => {
    const first = seenMode.current === null
    const modeChanged = !first && seenMode.current !== mode
    seenMode.current = mode

    if (modeChanged) {
      /* Collapse on ANY mode change, in both directions. →click was the obvious
         one (a hover-expanded rail can't be closed by pointer once hover stops
         driving it). →hover matters just as much and was the miss: a DOCKED-open
         rail keeps its 224px panel but loses its layout placeholder the moment
         docking turns off, so it sits covering the content until the user happens
         to hover and leave. Either way the safe state after a mode change is
         closed. */
      if (collapseTimer.current) clearTimeout(collapseTimer.current)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpanded(false)
      return
    }
    if (first) {
      try {
        /* Read the stored MODE here rather than trusting `mode` — on this first
           commit it is still the SSR default ('click'), because useSidebarOpenMode
           defers its own read for hydration safety. Branching on it would restore
           a persisted open state into hover mode, where nothing docks and the
           pointer is supposed to control the rail. */
        if (readMode() === 'click' && localStorage.getItem(EXPANDED_KEY) === '1') {
          setExpanded(true)
        }
      } catch {
        /* storage unavailable — the rail just starts collapsed */
      }
    }
  }, [mode])

  const expand = useCallback(() => {
    if (mode !== 'hover') return
    if (collapseTimer.current) clearTimeout(collapseTimer.current)
    setExpanded(true)
  }, [mode])

  const scheduleCollapse = useCallback(() => {
    if (mode !== 'hover') return
    if (collapseTimer.current) clearTimeout(collapseTimer.current)
    collapseTimer.current = setTimeout(() => setExpanded(false), COLLAPSE_DELAY_MS)
  }, [mode])

  const handleBlurCapture = useCallback((e: React.FocusEvent<HTMLElement>) => {
    if (mode !== 'hover') return
    // Only collapse when focus leaves the sidebar entirely (not child→child).
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) scheduleCollapse()
  }, [mode, scheduleCollapse])

  // Explicit open/close for click mode's toggle button.
  const toggle = useCallback(() => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current)
    setExpanded((v) => {
      const next = !v
      try {
        localStorage.setItem(EXPANDED_KEY, next ? '1' : '0')
      } catch {
        /* storage unavailable — the choice just won't survive reload */
      }
      return next
    })
  }, [])

  useEffect(() => () => { if (collapseTimer.current) clearTimeout(collapseTimer.current) }, [])

  /* Docked = the rail takes layout width and the page reflows beside it. Only in
     click mode: reflowing on every hover pass would thrash the layout, and hover
     is meant to be a transient peek. Narrow screens stay an overlay regardless —
     see the `md:` guard at the call sites — because giving 224px of a 390px
     viewport to navigation leaves nothing to navigate to. */
  const docked = mode === 'click' && expanded

  return {
    mode,
    expanded,
    docked,
    /** False on the first tick so a restored rail doesn't animate into place. */
    animate,
    collapsed: !expanded,
    expand,
    scheduleCollapse,
    handleBlurCapture,
    toggle,
  }
}
