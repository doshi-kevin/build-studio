// Notes hook — owns the student's rich-text notes for a room: loads on mount,
// holds the working draft, and autosaves it (debounced) via the saveNotes
// server action. Content is TipTap/Novel JSON, persisted as a stringified JSON
// blob in lc_notes.content (a plain text column).
//
// State lives here (not in the editor) so the draft survives the sidebar tab
// unmounting on switch, and so the same notes render on the post-session
// insights page. The editor itself is uncontrolled (Novel seeds from
// initialContent once per mount), so the hook tracks the latest content in a
// ref and re-seeds the editor from it on remount via getInitialContent().
//
// Saves are serialized (one in flight at a time; the latest draft is saved
// again when the current save returns) so rapid typing on a slow connection
// can't land an older write after a newer one. The draft is also flushed when
// the tab is backgrounded or the component unmounts, so the last debounce
// window isn't lost on close.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSONContent } from 'novel'
import { getNotes, saveNotes } from './actions'

export type NoteSaveState = 'idle' | 'saving' | 'saved' | 'error'

const AUTOSAVE_DEBOUNCE_MS = 800

// Turn a stored blob into editor content. Valid JSON docs pass through;
// anything else (empty, or a legacy plain-text note) becomes an empty doc /
// a single paragraph so nothing is lost.
function deserialize(raw: string): JSONContent | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.type === 'doc') return parsed
  } catch {
    // not JSON — fall through to the plain-text wrap
  }
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: raw }] }] }
}

export function useLiveNotes(roomId: string) {
  const [loaded, setLoaded] = useState(false)
  const [saveState, setSaveState] = useState<NoteSaveState>('idle')

  // Latest content (re-seeds the editor on remount); the serialized form drives
  // the dirty check; bookkeeping refs gate the serialized autosave.
  const initialRef = useRef<JSONContent | null>(null)
  const serializedRef = useRef('')
  const lastSavedRef = useRef('')
  const inFlightRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    getNotes(roomId).then((res) => {
      if (cancelled) return
      const raw = res.content ?? ''
      initialRef.current = deserialize(raw)
      serializedRef.current = raw
      lastSavedRef.current = raw
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [roomId])

  const doSave = useCallback(async () => {
    if (inFlightRef.current) return // a save is already running; it'll pick up the latest
    inFlightRef.current = true
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    let ok = true
    try {
      // Loop until the draft stops moving, so edits made while a save is in
      // flight get persisted (and an older write can't land after a newer one).
      while (serializedRef.current !== lastSavedRef.current) {
        const value = serializedRef.current
        setSaveState('saving')
        const res = await saveNotes(roomId, value)
        if (!res.success) {
          // Leave lastSaved untouched; the next edit/flush retries.
          setSaveState('error')
          ok = false
          break
        }
        lastSavedRef.current = value
        setSaveState('saved')
      }
    } finally {
      inFlightRef.current = false
    }
    // "Saved" is a transient confirmation, not pinned chrome — fade it back to
    // idle once the dust settles (errors stay visible until the next edit).
    if (ok) {
      savedTimerRef.current = setTimeout(() => setSaveState('idle'), 2000)
    }
  }, [roomId])

  const onChange = useCallback(
    (json: JSONContent) => {
      initialRef.current = json
      serializedRef.current = JSON.stringify(json)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        void doSave()
      }, AUTOSAVE_DEBOUNCE_MS)
    },
    [doSave],
  )

  // Flush the pending draft when the tab is hidden (backgrounded/closing) or
  // when this hook unmounts, so a half-typed debounce window isn't dropped.
  useEffect(() => {
    const flush = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      void doSave()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      flush()
    }
  }, [doSave])

  // Read once per editor mount — Novel seeds initialContent at init, so the
  // editor wrapper captures this and ignores later changes (no mid-typing reset).
  const getInitialContent = useCallback(() => initialRef.current, [])

  return { getInitialContent, onChange, saveState, loaded }
}
