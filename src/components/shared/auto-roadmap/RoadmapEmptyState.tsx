/**
 * RoadmapEmptyState — "nothing to draw": the course has no modules to derive a
 * map from. Drawn on the live canvas's own paper (RoadmapPaper, §19 styles);
 * each role page supplies its own words and its own exit.
 *
 * Type: Server-safe presentational component
 */

import Link from 'next/link'
import { Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { safeAppPath } from '@/lib/roadmap/concept-links'
import { RoadmapPaper, type RoadmapAudience } from './RoadmapPaper'

interface RoadmapEmptyStateProps {
  audience: RoadmapAudience
  title: string
  body: string
  ctaHref: string
  ctaLabel: string
}

export function RoadmapEmptyState({ audience, title, body, ctaHref, ctaLabel }: RoadmapEmptyStateProps) {
  /* Shared component, caller-supplied href: gate to same-origin app paths so a
     future caller passing a user-derived value can't turn the CTA into an open
     redirect. Both current callers pass literal /role/courses/… paths, so the
     fallback is never hit today. */
  const href = safeAppPath(ctaHref) ?? '/dashboard'
  return (
    <RoadmapPaper audience={audience}>
      <div className="rmp-note">
        <span className="rmp-ic">
          <Layers aria-hidden />
        </span>
        {/* h2: the paper's h1 is "Course Roadmap", and this is its direct
            subsection — an h3 would skip a level for assistive tech. */}
        <h2>{title}</h2>
        <p>{body}</p>
        <Button asChild className="rmp-cta">
          <Link href={href}>{ctaLabel}</Link>
        </Button>
      </div>
    </RoadmapPaper>
  )
}
