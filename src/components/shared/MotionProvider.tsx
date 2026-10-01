'use client'

/**
 * One reduced-motion decision for a whole route group.
 *
 * `reducedMotion="user"` makes framer skip transform and layout animations for
 * anyone who has asked their OS for less motion, while KEEPING opacity ones.
 * That split is deliberate: fading is what carries "this changed", so removing
 * it entirely leaves people who need the accommodation with less information
 * than everyone else, not the same amount more calmly.
 *
 * This exists as a client component because the layouts that need it stay
 * server components — (dashboard)/layout.tsx authenticates and fetches a
 * profile, so it can never carry 'use client' itself.
 *
 * Applied once per route group rather than at every call site, which is the
 * pattern src/lib/motion.ts documents and the three Live Classroom roots
 * already follow.
 *
 * Imports from 'framer-motion' to match the 38 files that already do. The
 * package was renamed to 'motion', and `motion/react` is the going-forward
 * import, but that rename is a separate mechanical change across the whole
 * codebase — introducing it here alone would leave two conventions instead of
 * replacing one.
 */

import { MotionConfig } from 'framer-motion'

export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}
