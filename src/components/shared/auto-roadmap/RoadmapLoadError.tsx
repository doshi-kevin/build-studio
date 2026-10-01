/**
 * RoadmapLoadError — the roadmap's own failure surface.
 *
 * Rendered by `roadmap/error.tsx` in both role trees so a failed roadmap fetch
 * is caught INSIDE `courses/[sectionId]/layout.tsx` and keeps the course icon
 * rail. Without a boundary at this segment the throw reaches
 * `(dashboard)/error.tsx`, which sits above that layout — and because course
 * URLs also suppress the main sidebar (HIDE_SIDEBAR_PATTERN), the reader was
 * left on a "Dashboard Error" card with no way back into the course. See the
 * "boundary above the section layout" note in .claude/rules/dead-ends.md.
 *
 * Spoken in the annotation layer's hand — an italic aside written straight on
 * the paper (not the module cards' white-card voice), the retry an inked link:
 * names what failed in the reader's words, reassures that nothing is lost, and
 * never surfaces the underlying error.
 *
 * Type: Client Component (error boundaries must be)
 */
'use client'

import { RefreshCw } from 'lucide-react'
import { RoadmapPaper, type RoadmapAudience } from './RoadmapPaper'

export function RoadmapLoadError({ reset, audience }: { reset: () => void; audience: RoadmapAudience }) {
  return (
    <RoadmapPaper audience={audience}>
      <div className="rmp-ann" role="alert">
        {/* a real heading — the error region's landmark for AT navigation */}
        <h2>Couldn’t load the roadmap</h2>
        <p>Something went wrong — nothing about the course has changed. Check your connection and try again.</p>
        <button type="button" className="rmp-ann-link" onClick={reset}>
          <RefreshCw aria-hidden />
          try again
        </button>
      </div>
    </RoadmapPaper>
  )
}
