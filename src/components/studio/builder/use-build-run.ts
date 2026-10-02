'use client'

import { useEffect, useRef, useState } from 'react'
import { STUDIO_BUILDER_PROGRESS_POLL_MS } from '@/lib/studio/limits'
import { ACTIVE_STATUSES, type ProgressRead } from './types'

interface RunState {
  runId: string | null
  progress: ProgressRead | null
  events: ProgressRead['events']
  unreachable: boolean
  /** This page saw the run active, so its ending is news worth announcing. */
  sawActive: boolean
}

const isActive = (status: string) => (ACTIVE_STATUSES as readonly string[]).includes(status)

/**
 * Polls one build's progress from its owner-checked route. Durable state is the
 * authority: a closed tab or a reload loses nothing, polling simply picks up again.
 * Faster while the build works and the tab is visible, slower when hidden or waiting for
 * the professor, and not at all once the build has ended.
 */
export function useBuildRun(runId: string | null) {
  const [state, setState] = useState<RunState>({ runId, progress: null, events: [], unreachable: false, sawActive: false })
  const [tick, setTick] = useState(0)
  const lastSeq = useRef<{ runId: string | null; seq: number }>({ runId, seq: 0 })

  useEffect(() => {
    if (!runId) return
    if (lastSeq.current.runId !== runId) lastSeq.current = { runId, seq: 0 }
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      let next: ProgressRead | null = null
      let ok = false
      try {
        const res = await fetch(`/api/studio/builder/runs/${runId}?after=${lastSeq.current.seq}`, { cache: 'no-store' })
        ok = res.ok
        if (res.ok) next = (await res.json()) as ProgressRead
      } catch {
        ok = false
      }
      if (!live) return
      if (next) lastSeq.current = { runId, seq: next.lastSeq }
      const fresh = next
      setState((prev) => {
        // A state from another run starts over.
        const base = prev.runId === runId ? prev : { runId, progress: null, events: [], unreachable: false, sawActive: false }
        if (!fresh) return { ...base, unreachable: !ok }
        const events = [...base.events, ...fresh.events.filter((e) => !base.events.some((p) => p.seq === e.seq))]
        return { runId, progress: fresh, events, unreachable: false, sawActive: base.sawActive || isActive(fresh.status) }
      })
      const status = next?.status
      if (status && !isActive(status)) return
      const waiting = status === 'waiting_for_approval' || status === 'waiting_for_professor'
      const delay = waiting ? 10_000 : document.hidden ? 5_000 : STUDIO_BUILDER_PROGRESS_POLL_MS
      timer = setTimeout(poll, delay)
    }
    void poll()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [runId, tick])

  const current = state.runId === runId ? state : { runId, progress: null, events: [], unreachable: false, sawActive: false }
  /** Poll again now, for example after approving or answering. */
  const refresh = () => setTick((n) => n + 1)
  return { progress: current.progress, events: current.events, unreachable: current.unreachable, sawActive: current.sawActive, refresh }
}
