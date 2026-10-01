/**
 * AutoRoadmapSkeleton — the roadmap's loading state, drawn in the live
 * canvas's own design language (RoadmapPaper chrome, §19 styles).
 *
 * The title is REAL text, inked immediately — only the map is a silhouette:
 * the completion station, the spine, and the first module band, breathing
 * quietly. Deliberately no fake wires or node clusters: the old skeleton's
 * hand-drawn edges read as a broken page, not a loading one.
 *
 * Type: Server-safe presentational component
 */

import { RoadmapPaper, type RoadmapAudience } from './RoadmapPaper'

export function AutoRoadmapSkeleton({ audience }: { audience: RoadmapAudience }) {
  return (
    <RoadmapPaper audience={audience}>
      {/* The silhouette is aria-hidden, so this is the wait's only non-visual
          signal — without it a screen reader hears a heading, then silence,
          then a full page. */}
      <p className="sr-only" role="status">
        Loading your roadmap…
      </p>
      <div className="rmp-skel" aria-hidden>
        {/* the completion station: big % block + delivery meter */}
        <div className="rmp-skel-rollup">
          <span className="rmp-ghost" style={{ width: 76, height: 40 }} />
          <span className="rmp-ghost bar" />
        </div>
        {/* the map at rest: spine, first module card, one resource per side */}
        <div className="rmp-skel-map">
          <span className="rmp-ghost spine" style={{ top: 0 }} />
          {/* top: 40 puts the card at 360px from the paper's top edge — where
              the real first module lands at the default view (see §19 CSS) */}
          <span className="rmp-ghost mod" style={{ top: 40 }} />
          <span className="rmp-ghost res l" style={{ top: 180 }} />
          <span className="rmp-ghost res l" style={{ top: 252 }} />
          <span className="rmp-ghost res r" style={{ top: 180 }} />
          <span className="rmp-ghost res r" style={{ top: 252 }} />
        </div>
      </div>
    </RoadmapPaper>
  )
}
