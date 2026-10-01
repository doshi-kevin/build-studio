'use client'

/**
 * SkillMasteryExperience — the professor's Skills hub, shown as the roadmap's
 * "Tracked skills" drawer. ONE unified view: the editable skill list (add with
 * AI placement, drag to reorder, track/untrack, rename, delete) with each row
 * carrying its live coverage badges + class-mastery dot. A read-only Matrix
 * toggle gives the coverage gap-audit. Activity→skill mapping and imported
 * concepts are auto-placed under the best-fitting main; mastery analytics live
 * on the roadmap.
 *
 * Dressed in the roadmap drawer's own design language (roadmap-prototype.css
 * §17): the analytics header strip, segmented toggle, pill buttons. Wiring is
 * unchanged from the old dialog.
 */

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Check, FileText, Loader2, ListTree, Grid3x3, Lock, AlertTriangle } from 'lucide-react'
import { SkillsManager } from './SkillsManager'
import { SkillMasterySettings } from './SkillMasterySettings'
import { CoverageMatrix } from './SkillIndexView'
import { markSkillsReviewed, getSkillIndex } from '@/app/(dashboard)/professor/courses/[sectionId]/skills/actions'
import type { SkillTreeNode } from '@/lib/validations/skill'
import type { SkillMasteryConfig } from '@/lib/skills/config'
import { sortSkillIndex, type SkillIndexData, type SkillIndexNode } from '@/lib/skills/index-view'

interface Props {
  sectionId: string
  initialTree: SkillTreeNode[]
  config: SkillMasteryConfig
  hasMaterials: boolean
  /** Called after the professor confirms — lets the parent close + clear the badge. */
  onConfirmed?: () => void
  /** Open the shared ConceptDetail modal for a skill — layered ABOVE this modal
   *  (which stays open behind it), so closing detail returns here. */
  onOpenConcept?: (name: string) => void
}

export function SkillMasteryExperience({ sectionId, initialTree, config, hasMaterials, onConfirmed, onOpenConcept }: Props) {
  const hasSkills = initialTree.length > 0
  const [confirming, setConfirming] = useState(false)
  const [mode, setMode] = useState<'list' | 'matrix'>('list')

  // Coverage index — fetched once on mount; the list stays editable while it
  // loads and the badges fill in when it arrives.
  const [coverage, setCoverage] = useState<SkillIndexData | null>(null)
  // Starts true: the fetch fires on mount, so the Matrix shows a spinner until
  // it lands (avoids a synchronous setState in the effect body).
  const [coverageLoading, setCoverageLoading] = useState(true)

  // Signature of the current skill set (ids + names + excluded). Changes on any
  // add / delete / rename / track-toggle — which is exactly when coverage (and
  // the Matrix built from it) must be refetched so it never goes stale against
  // the List. Reorder-only edits don't change it (the Matrix sorts itself).
  const treeSig = useMemo(
    () => initialTree.flatMap((m) => [`${m.id}:${m.name}:${m.excluded}`, ...m.subtopics.map((s) => `${s.id}:${s.name}:${s.excluded}`)]).join('|'),
    [initialTree],
  )

  useEffect(() => {
    let alive = true
    // Keep the current badges visible while refetching (only the initial load
    // shows the spinner) so edits don't flicker the list.
    getSkillIndex(sectionId).then((res) => {
      if (!alive) return
      setCoverageLoading(false)
      if (res.error || !res.data) return
      setCoverage(res.data)
    })
    return () => { alive = false }
  }, [sectionId, treeSig])

  const coverageById = useMemo(() => {
    if (!coverage) return undefined
    return new Map<string, SkillIndexNode>(coverage.flat.map((n) => [n.id, n]))
  }, [coverage])

  /** Which way each skill is moving, beside how high it is. Undefined for a
   *  section without enough snapshot history to compare two days. */
  const trendById = useMemo(() => {
    const t = coverage?.trendBySkillId
    if (!t) return undefined
    return new Map<string, number>(Object.entries(t))
  }, [coverage])

  // The header kicker: how many skills are actually being tracked right now —
  // non-suppressed, non-excluded mains plus their non-excluded subtopics.
  const activeCount = useMemo(
    () => initialTree.reduce(
      (sum, m) => (m.suppressed || m.excluded ? sum : sum + 1 + m.subtopics.filter((s) => !s.excluded).length),
      0,
    ),
    [initialTree],
  )

  const handleConfirm = async () => {
    setConfirming(true)
    const res = await markSkillsReviewed(sectionId)
    setConfirming(false)
    if ('error' in res) { toast.error(res.error); return }
    toast.success('Skills confirmed')
    onConfirmed?.()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header — the analytics drawer's dotted strip: live-count kicker (its
          "{n} STUDENTS" voice) + serif title, the settings gear as a round
          pebble (the corner close sits absolutely to its right). The what-is-
          this explainer lives inside the gear's panel, out of the every-visit
          path. */}
      <div className="ahead">
        <div className="hgrp">
          <span className="akick">{activeCount} {activeCount === 1 ? 'SKILL' : 'SKILLS'}</span>
          <span className="atitle">Tracked skills</span>
        </div>
        <SkillMasterySettings sectionId={sectionId} config={config} />
      </div>

      {/* AI off: mastery still scores from the professor's own tags and skills, but
          concept extraction and AI placement are off. Without this the professor
          just sees fewer skills arriving and no reason why.
          The two refusals get different words AND a different icon. A padlock means
          permission, so wearing one while saying "temporarily unavailable, try again
          shortly" tells the professor their institution switched AI off — they may
          stop trying. The outage message is already complete on its own, so it gets
          no reassurance sentence appended to it. */}
      {coverage?.aiNotice && (
        <div className="tsai" role="status">
          {coverage.aiNoticeIsPolicy ? <Lock aria-hidden /> : <AlertTriangle aria-hidden />}
          <span>
            {coverage.aiNotice}
            {coverage.aiNoticeIsPolicy && (
              <> Skills you add yourself still count, and tagged questions still score.
              Scholera just won’t find new concepts or file them under a main skill for you.</>
            )}
          </span>
        </div>
      )}

      {/* Toolbar: the List/Matrix toggle */}
      {hasSkills && (
        <div className="tsbar">
          <div className="seg" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={mode === 'list'} className={mode === 'list' ? 'on' : undefined} onClick={() => setMode('list')}>
              <ListTree aria-hidden />List
            </button>
            <button type="button" role="tab" aria-selected={mode === 'matrix'} className={mode === 'matrix' ? 'on' : undefined} onClick={() => setMode('matrix')}>
              <Grid3x3 aria-hidden />Matrix
            </button>
          </div>
        </div>
      )}

      {/* Body (scrolls) */}
      <div className="tscroll">
        {mode === 'list' ? (
          <>
            {hasMaterials && !hasSkills && (
              <div className="tsmat">
                <span className="ic"><FileText aria-hidden /></span>
                <div>
                  <div className="tt">You’ve uploaded course material</div>
                  <div className="ss">Review the skills it covers — Scholera will track them all semester.</div>
                </div>
              </div>
            )}
            <SkillsManager sectionId={sectionId} initialTree={initialTree} coverageById={coverageById} trendById={trendById} onOpenConcept={onOpenConcept} />
          </>
        ) : coverageLoading ? (
          <div className="aempty"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : coverage && coverage.flat.length > 0 ? (
          <CoverageMatrix nodes={sortSkillIndex(coverage.flat, 'least-covered')} onOpen={(name) => onOpenConcept?.(name)} />
        ) : (
          /* Two causes, two sentences. "No coverage to show yet" was one bare
             line that could not tell a professor whether they had no skills to
             cover or no graded work covering them, and offered no way forward
             for either. */
          <div className="aempty tsempty">
            <span className="ic"><ListTree aria-hidden /></span>
            <div className="tt">{hasSkills ? 'Nothing graded against these skills yet' : 'No skills to cover yet'}</div>
            <div className="ss">
              {hasSkills
                ? 'The matrix fills in as students submit graded work. Each cell shows how well one skill is covered by one activity.'
                : 'Upload course material in Modules and Scholera extracts the skills it covers, or add one yourself from the list view.'}
            </div>
          </div>
        )}
      </div>

      {/* Footer (pinned) */}
      {hasSkills && (
        <div className="tsfoot">
          <button type="button" className="tsbtn" onClick={handleConfirm} disabled={confirming}>
            {confirming ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
            Confirm skills
          </button>
        </div>
      )}
    </div>
  )
}
