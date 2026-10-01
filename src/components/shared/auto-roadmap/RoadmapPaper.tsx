/**
 * RoadmapPaper — the roadmap's dotted-paper chrome for its OFF-CANVAS states
 * (loading skeleton, load error, empty course). Redraws the live canvas's
 * first frame — same paper, same inked serif title — so none of these states
 * swaps visual worlds with RoadmapPrototype, and the loading → loaded
 * transition holds "Course Roadmap" still while the map fades in behind it.
 *
 * Styles: §19 of roadmap-prototype.css (shared with the live canvas so the
 * two can never drift apart).
 *
 * Type: Server-safe presentational components (no hooks)
 */

import type { ReactNode } from 'react'
import '@/app/(dashboard)/professor/courses/[sectionId]/roadmap/roadmap-prototype.css'

export type RoadmapAudience = 'prof' | 'stu'

/** The page-title description per audience — one source for the live canvas
 *  header AND the off-canvas states, so the words never differ mid-load. */
export const HEADER_DESC: Record<RoadmapAudience, string> = {
  stu: 'Your whole course at a glance: what’s been covered, what’s due next, and what’s new since you last looked.',
  prof: 'Your whole course at a glance: what you’ve delivered, which activities are pending, and how your students are doing.',
}

/** The inked page title: serif h1, the hand-drawn double swash drawing itself
 *  in underneath, and the marginalia-voice description. Rendered inside an
 *  `.hd` wrapper — RoadmapPrototype supplies its own (positioned on the flow),
 *  RoadmapPaper the static one. */
export function RoadmapTitleInk({ desc }: { desc: string }) {
  return (
    <>
      <h1 className="hd-title">Course Roadmap</h1>
      <svg className="hd-swash" viewBox="0 0 300 13" width="300" height="13" aria-hidden>
        <path d="M4 7 C 80 3, 200 3, 296 6" />
        <path className="d2" d="M10 11 C 92 8, 180 8, 252 9.5" />
      </svg>
      <div className="hd-desc">{desc}</div>
    </>
  )
}

/** The paper itself: the canvas surface with a static dot grid, the inked
 *  title top-left of a centred sheet, and whatever state the caller draws on it. */
export function RoadmapPaper({ audience, children }: { audience: RoadmapAudience; children?: ReactNode }) {
  return (
    <div className="rmproto rmp-paper">
      <div className="rmp-sheet">
        <div className="hd">
          <RoadmapTitleInk desc={HEADER_DESC[audience]} />
        </div>
        {children}
      </div>
    </div>
  )
}
