// Non-intrusive "this session is being recorded" notice for students. Shows
// only while a recording is actually active (consent notice, since audio is
// stored). Polls the recording status — recording can be toggled on mid-class.

'use client'

import { useEffect, useState } from 'react'
import { Circle } from 'lucide-react'
import { getRecording } from '@/lib/live-classroom/recording/actions'

const POLL_MS = 20000

export function RecordingBanner({ roomId }: { roomId: string }) {
  const [active, setActive] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      const result = await getRecording(roomId)
      if (cancelled) return
      setActive(result.status === 'recording')
      timer = setTimeout(() => void run(), POLL_MS)
    }
    void run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [roomId])

  if (!active) return null

  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-background/90 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur">
        <Circle className="h-2.5 w-2.5 animate-pulse motion-reduce:animate-none fill-destructive text-destructive" />
        This session is being recorded
      </span>
    </div>
  )
}
