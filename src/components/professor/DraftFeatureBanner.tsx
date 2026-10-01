/**
 * DraftFeatureBanner — tells the professor when the feature page they're on
 * isn't visible to students yet, and lets them release it from right there.
 *
 * Why this exists: the professor sidebar now lists every feature, so a feature
 * appearing there no longer implies students can reach it. Without this, a
 * professor could build and publish a quiz inside an unreleased Quizzes feature
 * and never learn students had no way to open it — the draft state was
 * communicated only by a badge inside the Manage Features popover.
 *
 * Rendered once in the course layout rather than per page: it derives the active
 * feature from the pathname, the same way CourseBreadcrumbs does, so all seven
 * releasable feature pages are covered without touching any of them.
 *
 * Type: Client Component (needs usePathname + useTransition)
 */
'use client'

import { useTransition } from 'react'
import { usePathname } from 'next/navigation'
import { EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { COURSE_FEATURES } from '@/lib/course-features'
import { toggleCourseFeature } from '@/app/(dashboard)/professor/courses/[sectionId]/actions'

/** Route segment → feature, for features that have a student side to release.
 *  Basics are always visible; professorOnly tools have no student side;
 *  studentOnly/inlineOnly features have no professor page to show a banner on. */
const RELEASABLE_BY_SEGMENT = new Map(
  COURSE_FEATURES
    .filter((f) => f.category === 'additional' && !f.studentOnly && !f.inlineOnly)
    .map((f) => [f.route.replace('/', ''), f])
)

interface DraftFeatureBannerProps {
  sectionId: string
  /** Features currently released to students. */
  enabledFeatures: string[]
  /**
   * Products the INSTITUTION does not have. Offering to release one is a
   * promise we cannot keep: the student gates subtract unentitled keys, so the
   * professor would see it "released" and no student would ever receive it.
   */
  unentitledFeatures?: string[]
}

export function DraftFeatureBanner({
  sectionId,
  enabledFeatures,
  unentitledFeatures = [],
}: DraftFeatureBannerProps) {
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  const segment = pathname.replace(`/professor/courses/${sectionId}`, '').split('/').filter(Boolean)[0] || ''
  const feature = RELEASABLE_BY_SEGMENT.get(segment)

  // Nothing to say on pages that have no student side, that are already live,
  // or whose product the school does not own.
  if (!feature || enabledFeatures.includes(feature.key)) return null
  if (unentitledFeatures.includes(feature.key)) return null

  const handleRelease = () => {
    startTransition(async () => {
      const result = await toggleCourseFeature(sectionId, feature.key, true)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success(`${feature.label} is now visible to students`)
    })
  }

  return (
    <Alert className="mb-4">
      <EyeOff className="h-4 w-4" aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        {/* Says only what releasing actually controls: the student nav entry.
            Claiming students "can't see this" would overpromise — the per-page
            `verifyFeatureEnabled` gate is still missing on most student feature
            pages, so a direct URL can render one. Tracked separately. */}
        <span>{`${feature.label} isn't released to students yet — it won't show in their course menu. Set it up here, then release it when you're ready.`}</span>
        <Button size="sm" onClick={handleRelease} disabled={isPending}>
          {isPending ? 'Releasing…' : 'Release to students'}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
