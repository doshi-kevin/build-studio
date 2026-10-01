/**
 * useExitGuard — prompts the professor before leaving a draft assignment.
 *
 * Active only when `active` is true (i.e. assignment is a draft, not published).
 * Covers three exit vectors:
 *   1. Browser close / reload  → beforeunload
 *   2. Browser Back            → history.pushState sentinel + popstate (best-effort)
 *   3. In-app header back link → passes `onRequestExit` to StudioHeader / StudioChrome
 *      so those components call it instead of navigating directly.
 *
 * The caller shows the SaveAssignmentDialog with `onDiscard` wired to the returned
 * `confirmDiscard` function, and `onSave` to its normal save path.
 *
 * "Exit preview" is NOT an exit — this guard only fires for navigation away from the studio.
 */
'use client'

import { useEffect, useCallback, useRef } from 'react'

interface UseExitGuardOptions {
  /** Activate the guard only for drafts; pass false for published assignments. */
  active: boolean
  /** Called when any guarded exit vector fires — the caller should open the save dialog. */
  onRequestExit: () => void
}

export function useExitGuard({ active, onRequestExit }: UseExitGuardOptions) {
  const onRequestExitRef = useRef(onRequestExit)
  useEffect(() => { onRequestExitRef.current = onRequestExit })

  // 1. Browser close / reload.
  useEffect(() => {
    if (!active) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Chrome requires returnValue to show the native dialog.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [active])

  // 2. Browser Back via history sentinel.
  // We push a no-op state so the first back press returns to that entry (not the previous page).
  // On the popstate event we intercept and prompt instead of navigating.
  useEffect(() => {
    if (!active) return
    // Push the sentinel on mount.
    history.pushState({ __studioSentinel: true }, '')
    const handler = (e: PopStateEvent) => {
      if (!e.state?.__studioSentinel) {
        // The user navigated past the sentinel — re-push it and prompt.
        history.pushState({ __studioSentinel: true }, '')
        onRequestExitRef.current()
      }
    }
    window.addEventListener('popstate', handler)
    return () => {
      window.removeEventListener('popstate', handler)
    }
  }, [active])

  /**
   * Call this from the header back button when the guard is active.
   * If the guard is inactive (published assignment) it returns false and the caller should
   * navigate normally.
   */
  const guardedExit = useCallback(
    (e?: { preventDefault?: () => void }) => {
      if (!active) return false
      e?.preventDefault?.()
      onRequestExitRef.current()
      return true
    },
    [active],
  )

  return { guardedExit }
}
