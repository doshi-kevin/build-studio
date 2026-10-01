/**
 * TrackedSkillsDrawer — the "Tracked skills" feature on the redesigned
 * roadmap, in a bottom DRAWER (the same slide-up chrome as Class analytics).
 * The trigger button lives in RoadmapPrototype's right tools cluster (this
 * component feeds it the live badge count via onUnconfirmedChange — the
 * drawer must mount at the canvas root, not inside the cluster, so its
 * absolute scrim/panel anchor to the canvas). Everything here is the SAME
 * feature as the old roadmap's control (ProfessorRoadmapClient), wiring
 * preserved verbatim:
 *
 *  · SkillMasteryExperience (curate the skill hierarchy, confirm AI
 *    suggestions, scoring config) — the component, unchanged
 *  · `?review=topics` deep-link (the extraction toast's "Review" action)
 *    opens the drawer; closing strips the param
 *  · closing re-derives the unconfirmed badge from the server
 *  · realtime badge bump on AI skill INSERTs + a debounced router.refresh()
 *    so the SSR-provided tree doesn't go stale against the badge
 *  · clicking a skill inside the experience layers the concept-detail
 *    MaterialViewer on top (score · assessed by · taught in), with the
 *    dismiss guards that keep the drawer underneath open
 *
 * Open state is CONTROLLED by RoadmapPrototype (one bottom panel at a time —
 * this drawer and Class analytics never stack).
 *
 * Type: Client Component (rendered in RoadmapPrototype's right tools
 * cluster, professor only)
 */
'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'
import { MaterialViewer } from '@/components/ui/material-viewer'
import { SkillMasteryExperience } from '@/components/professor/skills/SkillMasteryExperience'
import { conceptSourceHref } from '@/lib/roadmap/concept-links'
import type { SkillTreeNode } from '@/lib/validations/skill'
import type { SkillMasteryConfig } from '@/lib/skills/config'
import type { AutoRoadmapData } from '@/lib/validations/auto-roadmap'
import type { ConceptAnalyticsData, ConceptSource } from './actions'
import { getUnconfirmedSkillCount } from '../skills/actions'

export interface TrackedSkillsSetup {
  initialTree: SkillTreeNode[]
  config: SkillMasteryConfig
  hasMaterials: boolean
}

/** A skill the professor opened from inside the experience — its class score
 *  plus the activities that assess it and the lectures that teach it. */
type ConceptDetailData = {
  id: string
  name: string
  score: number | null
  sources: ConceptSource[]
  taughtIn: { title: string; href?: string }[]
}

const norm = (s: string) => s.trim().toLowerCase()

interface TrackedSkillsDrawerProps {
  sectionId: string
  topicSetup: TrackedSkillsSetup
  /** AI skills extracted but not yet confirmed — seeds the review badge. */
  unconfirmedCount: number
  /** For the concept-detail layer (score / assessed-by); null degrades to name-only. */
  concepts: ConceptAnalyticsData | null
  /** Roadmap structure — resolves which lectures teach each skill. */
  roadmapData: AutoRoadmapData
  /** Controlled drawer state (the mount site keeps one bottom panel at a time). */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Live badge feed for the trigger button (realtime bumps + post-close
   *  re-derives land here). Mounted at the canvas root — the trigger lives
   *  in the tools cluster, so the count travels up via this callback. */
  onUnconfirmedChange: (count: number) => void
}

export const TrackedSkillsDrawer = memo(function TrackedSkillsDrawer({ sectionId, topicSetup, unconfirmedCount, concepts, roadmapData, open, onOpenChange, onUnconfirmedChange }: TrackedSkillsDrawerProps) {
  const [unconfirmed, setUnconfirmed] = useState(unconfirmedCount)
  /* useState only seeds on first mount, so a server-side change to unconfirmedCount — which
     is exactly what router.refresh() delivers after a skill mutation — never reached this
     state, and the badge stayed stale until a full reload (#602). Re-sync when the prop moves,
     using the adjust-during-render pattern already used for everOpened below rather than an
     effect (no cascading render, no lint exception). */
  const [lastCountProp, setLastCountProp] = useState(unconfirmedCount)
  if (unconfirmedCount !== lastCountProp) {
    setLastCountProp(unconfirmedCount)
    setUnconfirmed(unconfirmedCount)
  }
  useEffect(() => { onUnconfirmedChange(unconfirmed) }, [unconfirmed, onUnconfirmedChange])
  const [selectedConcept, setSelectedConcept] = useState<ConceptDetailData | null>(null)
  // True during the brief transition while the concept viewer (layered over the
  // Tracked-skills modal) is closing — keeps the dialog's dismiss guard armed
  // through the focus/pointer shuffle that follows.
  const conceptClosingRef = useRef(false)
  const closeConcept = useCallback(() => {
    conceptClosingRef.current = true
    setSelectedConcept(null)
    setTimeout(() => { conceptClosingRef.current = false }, 200)
  }, [])

  // Arriving via the extraction toast's "Review" action (?review=topics) opens
  // the modal; closing strips the param so a refresh / back-nav won't reopen it.
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  /* ?review=topics opens the drawer on load, but reading it DURING render made the server
     render the drawer closed and the first client render open — a hydration mismatch (#602).
     Gated behind a post-mount flag (false on the server AND the first client render) so both
     renders agree, then the drawer opens in a follow-up commit. Same pattern and same reason
     as CalendarFeedCard's origin gate. */
  const [mounted, setMounted] = useState(false)
  // A mount gate is the one legitimate setState-in-effect: the whole point is that the first
  // client render must match the server's. Same disable and same reason as DashboardHeader.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setMounted(true) }, [])
  const reviewParam = mounted && searchParams.get('review') === 'topics'

  // Re-derive the badge from the server after the modal closes (a Confirm
  // stamps topicsReviewedAt → count drops to 0).
  const refreshUnconfirmed = useCallback(async () => {
    const { count } = await getUnconfirmedSkillCount(sectionId)
    setUnconfirmed(count)
  }, [sectionId])

  const drawerOpen = open || reviewParam

  /* Mount the experience on FIRST open, and keep it mounted after. It is by far
     the heaviest thing on the canvas — SkillsManager nests a DndContext +
     useSortable per skill row, and it fires getSkillIndex() on mount. Rendered
     behind a closed drawer it cost every roadmap visit that fetch, and made the
     whole tree reconcile on each of the canvas' many state changes (React Flow
     reports node dimensions in bursts). Latched during render so the content
     lands in the SAME commit that flips the drawer open — no empty first frame. */
  const [everOpened, setEverOpened] = useState(false)
  if (drawerOpen && !everOpened) setEverOpened(true)

  const closeTopics = useCallback(() => {
    onOpenChange(false)
    if (reviewParam) router.replace(pathname, { scroll: false })
    void refreshUnconfirmed()
  }, [onOpenChange, reviewParam, router, pathname, refreshUnconfirmed])

  /* Escape closes the drawer — unless the concept viewer is layered on top
     (it owns that Escape; the closing-ref covers its dismiss transition). */
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (selectedConcept || conceptClosingRef.current) return
      closeTopics()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawerOpen, selectedConcept, closeTopics])

  // Live-bump the badge when background extraction inserts new AI skills, and
  // debounce a router.refresh() so the SSR-provided tree catches up too.
  const treeRefresh = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const supabase = createClient()
    let mounted = true
    let cleanup: (() => void) | null = null
    ;(async () => {
      try {
        const { data: sess } = await supabase.auth.getSession()
        if (!mounted) return
        const token = sess.session?.access_token
        if (token) supabase.realtime.setAuth(token)
        const channel = supabase
          .channel(`topics-badge:${sectionId}`)
          .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'skills', filter: `section_id=eq.${sectionId}` },
            (payload) => {
              if ((payload.new as { source?: string }).source !== 'ai') return
              setUnconfirmed((c) => c + 1)
              if (treeRefresh.current) clearTimeout(treeRefresh.current)
              treeRefresh.current = setTimeout(() => router.refresh(), 1500)
            },
          )
          .subscribe()
        cleanup = () => { supabase.removeChannel(channel) }
      } catch (err) {
        logger.error('TrackedSkills: badge subscribe failed', err, { sectionId })
      }
    })()
    return () => {
      mounted = false
      if (treeRefresh.current) clearTimeout(treeRefresh.current)
      cleanup?.()
    }
  }, [sectionId, router])

  // Skill lookups for the concept-detail layer (same derivation as the old
  // client): class score + curated id by name, and which lectures teach it.
  const { classScoreByName, topicByName, taughtInByName } = useMemo(() => {
    const classScoreByName: Record<string, number | null> = {}
    const topicByName = new Map<string, { id: string; name: string }>()
    if (concepts) {
      for (const main of concepts.view.ordered) {
        classScoreByName[norm(main.name)] = main.classScore
        for (const sub of main.subtopics) classScoreByName[norm(sub.name)] = sub.classScore
      }
      for (const t of concepts.topics) topicByName.set(norm(t.name), { id: t.id, name: t.name })
    }
    const taughtInByName = new Map<string, { title: string; href?: string }[]>()
    const addNode = (title: string, topics: string[] | undefined, href?: string) => {
      for (const label of topics ?? []) {
        const k = norm(label)
        taughtInByName.set(k, [...(taughtInByName.get(k) ?? []), { title, href }])
      }
    }
    for (const w of roadmapData.weeks)
      for (const it of w.items) addNode(it.title, it.topics, `/professor/courses/${sectionId}/modules/${w.id}`)
    return { classScoreByName, topicByName, taughtInByName }
  }, [concepts, roadmapData, sectionId])

  const openConcept = useCallback((name: string) => {
    const match = topicByName.get(norm(name))
    if (!match || !concepts) return
    setSelectedConcept({
      id: match.id,
      name: match.name,
      score: classScoreByName[norm(name)] ?? null,
      sources: concepts.sources[match.id] ?? [],
      taughtIn: taughtInByName.get(norm(name)) ?? [],
    })
  }, [topicByName, concepts, classScoreByName, taughtInByName])

  return (
    <>
      {/* the drawer — same slide-up chrome as Class analytics. A scrim click
          that dismisses the layered concept viewer must not also close this
          (the viewer's own overlay swallows those clicks; the guard covers
          the dismiss transition). */}
      <div className={`ascrim${drawerOpen ? ' on' : ''}`} aria-hidden onClick={() => { if (!selectedConcept && !conceptClosingRef.current) closeTopics() }} />
      {/* `inert` rather than `aria-hidden` — same reason as the class-analytics panel:
          the drawer stays mounted to animate out, and aria-hidden over a subtree that
          still holds focus is what Chromium blocks. `inert` moves focus out itself. */}
      <div className={`analytics skillsdrawer${drawerOpen ? ' on' : ''}`} role="dialog" aria-modal="true" aria-label="Tracked skills" inert={!drawerOpen}>
        <button type="button" className="aclose" aria-label="Close" onClick={closeTopics}><X aria-hidden /></button>
        <div className="tsbody">
          {everOpened && (
            <SkillMasteryExperience
              sectionId={sectionId}
              initialTree={topicSetup.initialTree}
              config={topicSetup.config}
              hasMaterials={topicSetup.hasMaterials}
              onConfirmed={closeTopics}
              onOpenConcept={openConcept}
            />
          )}
        </div>
      </div>

      {selectedConcept && (
        <MaterialViewer
          open
          onOpenChange={(o) => { if (!o) closeConcept() }}
          url=""
          fileName=""
          concept={{
            name: selectedConcept.name,
            score: selectedConcept.score,
            sources: selectedConcept.sources.map((s) => ({
              key: `${s.type}:${s.id}`,
              title: s.title,
              typeLabel: s.type === 'live_quiz' ? 'Live quiz' : s.type,
              href: conceptSourceHref(sectionId, s),
            })),
            taughtIn: selectedConcept.taughtIn,
          }}
        />
      )}
    </>
  )
})
