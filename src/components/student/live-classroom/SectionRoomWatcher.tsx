// Tiny client component the student landing page mounts to learn about
// live-room lifecycle in real time. Subscribes to the section-wide private
// topic `section:<id>:lc`. On `room_started` OR `room_ended` we call
// router.refresh() — Next.js re-runs the surrounding server component, which
// re-queries the active room and swaps the UI between "No active class" and
// the "LIVE NOW · Join Class" card without a manual reload (both when a class
// starts — start-now or scheduled — and when it ends).
//
// This is a one-trick component on purpose: keeping the landing page a
// server component (cheap, SEO-friendly) while still reacting to live
// state via a tiny client island.

'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { sectionTopic } from '@/lib/live-classroom/broadcast/types'
import { logger } from '@/lib/logger'

interface Props {
  sectionId: string
}

export function SectionRoomWatcher({ sectionId }: Props) {
  const router = useRouter()

  useEffect(() => {
    const supabase = createClient()
    let mounted = true

    // Make sure realtime has the auth token before opening a private
    // channel. Same pattern as useRoomChannel.
    let cleanup: (() => void) | null = null
    ;(async () => {
      try {
        const { data } = await supabase.auth.getSession()
        if (!mounted) return
        const token = data.session?.access_token
        if (token) supabase.realtime.setAuth(token)

        const channel = supabase
          .channel(sectionTopic(sectionId), { config: { private: true } })
          .on('broadcast', { event: 'room_started' }, () => {
            // Server component re-queries getActiveRoomForSection on
            // refresh, so the "LIVE NOW" card appears.
            router.refresh()
          })
          .on('broadcast', { event: 'room_ended' }, () => {
            // Class ended — refresh so the active-room query returns null and
            // the hub swaps back to "Waiting for class to start".
            router.refresh()
          })
          .subscribe((status) => {
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              logger.warn('SectionRoomWatcher: channel error', { status, sectionId })
            }
          })

        cleanup = () => {
          supabase.removeChannel(channel)
        }
      } catch (err) {
        logger.error('SectionRoomWatcher: setup failed', err, { sectionId })
      }
    })()

    return () => {
      mounted = false
      cleanup?.()
    }
  }, [sectionId, router])

  return null
}
