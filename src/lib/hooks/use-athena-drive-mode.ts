'use client'

/**
 * Athena's drive mode — her ONE autonomy axis, persisted per browser.
 *
 *   • 'copilot' (default) — she opens pages and highlights what she's explaining.
 *   • 'chat'              — she answers and leaves the screen exactly where it is.
 *
 * There is no third notch, and that is a design decision, not an omission: every
 * Athena tool is read-only and every write still needs the student's click on the
 * real page, so "how much can she do that I can't take back" has only one axis —
 * may she move my screen. A control that gates nothing trains people to click
 * through it.
 *
 * localStorage, not the DB: a per-browser preference with no tenant or security
 * implication (cf. useSidebarOpenMode). Read through useSyncExternalStore rather
 * than a mount effect so SSR and hydration agree on 'copilot' and the stored
 * value lands on the first post-hydration read — no mismatch, no setState in an
 * effect.
 */

import { useCallback, useSyncExternalStore } from 'react'

export type DriveMode = 'copilot' | 'chat'

const STORAGE_KEY = 'athena-drive-mode'
/** Same-tab notification; the native `storage` event only fires in OTHER tabs. */
const MODE_EVENT = 'scholera:athena-drive-mode'

function readMode(): DriveMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'chat' ? 'chat' : 'copilot'
  } catch {
    // Storage blocked (private mode, embedded webview) — fall back to the default.
    return 'copilot'
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(MODE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(MODE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/** Every mounted consumer stays in sync, in this tab and across tabs. */
export function useAthenaDriveMode(): [DriveMode, (mode: DriveMode) => void] {
  // A primitive snapshot, so React's identity check needs no caching.
  const mode = useSyncExternalStore(subscribe, readMode, () => 'copilot' as DriveMode)

  const setMode = useCallback((next: DriveMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* storage unavailable — the preference just won't persist */
    }
    window.dispatchEvent(new CustomEvent(MODE_EVENT))
  }, [])

  return [mode, setMode]
}
