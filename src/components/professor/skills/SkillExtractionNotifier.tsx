// Mounted once in the professor course layout so it survives navigation between
// sub-pages (Modules, Quizzes, Roadmap…). Two jobs, both about skills that need
// the professor's confirmation:
//   1. A LIVE toast the moment background extraction inserts new AI skills —
//      works on any course page, debounced so a burst becomes one toast.
//   2. ONE gentle nudge per session if skills are already waiting at load.
// No recurring/scheduled popups — the persistent "Tracked skills" badge on the
// roadmap is the standing reminder; this is just the timely heads-up.
//
// Type: Client Component (renders nothing).

'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'

interface Props {
  sectionId: string
  /** Unconfirmed AI-skill count at load — drives the one-per-session nudge. */
  initialUnconfirmedCount: number
}

export function SkillExtractionNotifier({ sectionId, initialUnconfirmedCount }: Props) {
  const router = useRouter()
  // ?review=topics opens the Tracked-skills drawer on arrival — without it,
  // "Review" only lands on the page and the drawer stays shut. The param name has
  // to match what the drawer reads (roadmap-tracked-skills.tsx); it said `skills`
  // here, which nothing ever read, so this link had never opened anything.
  const roadmapHref = `/professor/courses/${sectionId}/roadmap?review=topics`

  // One gentle nudge per session if skills are already waiting (not recurring).
  useEffect(() => {
    if (initialUnconfirmedCount <= 0) return
    const key = `skill-nudge:${sectionId}`
    if (sessionStorage.getItem(key)) return
    sessionStorage.setItem(key, '1')
    toast(`${initialUnconfirmedCount} skill${initialUnconfirmedCount > 1 ? 's' : ''} waiting to review`, {
      description: 'Confirm your tracked skills so mastery scoring stays accurate.',
      action: { label: 'Review', onClick: () => router.push(roadmapHref) },
    })
  }, [initialUnconfirmedCount, sectionId, router, roadmapHref])

  // Live toast when extraction inserts new AI skills. RLS-scoped: only this
  // section's events arrive. Debounced so a multi-skill extraction = one toast.
  useEffect(() => {
    const supabase = createClient()
    let mounted = true
    let cleanup: (() => void) | null = null
    let pending = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
      const n = pending
      pending = 0
      timer = null
      if (n <= 0) return
      toast(`${n} skill${n > 1 ? 's' : ''} ready to review`, {
        action: { label: 'Review', onClick: () => router.push(roadmapHref) },
      })
    }

    ;(async () => {
      try {
        const { data: sess } = await supabase.auth.getSession()
        if (!mounted) return
        const token = sess.session?.access_token
        if (token) supabase.realtime.setAuth(token)
        const channel = supabase
          .channel(`skills-notify:${sectionId}`)
          .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'skills', filter: `section_id=eq.${sectionId}` },
            (payload) => {
              if ((payload.new as { source?: string }).source !== 'ai') return
              pending += 1
              if (timer) clearTimeout(timer)
              timer = setTimeout(flush, 1500)
            },
          )
          .subscribe()
        cleanup = () => { if (timer) clearTimeout(timer); supabase.removeChannel(channel) }
      } catch (err) {
        logger.error('SkillExtractionNotifier: subscribe failed', err, { sectionId })
      }
    })()

    return () => { mounted = false; cleanup?.() }
  }, [sectionId, router, roadmapHref])

  return null
}
