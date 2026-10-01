// "Focus areas" for the student dashboard right rail (#287).
//
// The three topics the student is weakest on, across every course, weakest first.
// A dashboard is scanned rather than studied — a student is here to work out what to
// do next, not to read a chart — so this is a short ranked list, not a visualisation.
//
// Anything at or above the "strong" threshold is dropped by the query, so a topic
// leaves this card by being learned. That is the point: the list stays a to-do rather
// than becoming a report card.
//
// Colours come from TIER_STYLES, the same tier vocabulary the roadmap and skills
// surfaces use, so a bar means the same thing everywhere in the product.

import Link from 'next/link'
import { Target, CircleAlert, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { masteryTier, masteryFillPct, scoreLabel } from '@/lib/skills/mastery'
import { TIER_STYLES } from '@/lib/skills/tier-styles'
import type { StudentFocusSkill } from '@/lib/supabase/queries'

interface FocusAreasProps {
  skills: StudentFocusSkill[]
  /**
   * True when the student HAS mastery data — used only to tell the two empty states
   * apart, since "not assessed yet" and "everything already strong" both arrive as an
   * empty `skills` array and mean opposite things.
   *
   * Named for the input rather than the conclusion on purpose: an earlier version took
   * `allStrong` and the page passed `hasAnyMastery` straight into it, so the card
   * congratulated a student while listing three weak topics above the message.
   */
  hasAnyMastery?: boolean
  /**
   * When the fetch failed, show a distinct error state instead of the empty state —
   * a failed load must not masquerade as a reassuring "nothing needs attention".
   */
  loadError?: boolean
}

/** A signed delta, or nothing when there is no old-enough snapshot to compare to. */
function Delta({ delta }: { delta: number | null }) {
  if (delta == null || Math.round(delta) === 0) return null
  const up = delta > 0
  return (
    <span
      className={cn(
        'shrink-0 text-[11px] font-medium tabular-nums',
        up ? 'text-success-muted-foreground' : 'text-muted-foreground',
      )}
      title={up ? 'Improved since your last check-in' : 'Slipped since your last check-in'}
    >
      {up ? '+' : ''}{Math.round(delta)}
    </span>
  )
}

function Row({ skill }: { skill: StudentFocusSkill }) {
  const tier = masteryTier(skill.score)
  const styles = TIER_STYLES[tier]

  /* One line per topic, with the bar inline rather than stacked beneath. Stacked rows
     were ~46px each, so three of them plus a header needed ~179px in a panel that gets
     ~156px at a 900px-tall window — the third row was always cut off. Inline is ~34px,
     fits all three, and reads left-to-right in one pass. */
  const body = (
    <div className="flex items-center gap-2 min-w-0">
      {skill.courseCode && (
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
          {skill.courseCode}
        </span>
      )}
      <span className="truncate text-sm text-foreground">{skill.name}</span>
      <span className="ml-auto h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className={cn('block h-full rounded-full', styles.bar)} style={{ width: `${masteryFillPct(skill.score)}%` }} />
      </span>
      <span className={cn('w-9 shrink-0 text-right text-xs font-semibold tabular-nums', styles.text)}>
        {scoreLabel(skill.score)}
      </span>
      <Delta delta={skill.delta} />
    </div>
  )

  // Unlinked when the professor has turned the roadmap off for that section: the
  // student roadmap page calls verifyFeatureEnabled and notFound()s, so a link there
  // would be a dead end rather than a shortcut.
  if (!skill.roadmapEnabled) {
    return <div className="px-4 py-2.5">{body}</div>
  }
  return (
    <Link
      href={`/student/courses/${skill.sectionId}/roadmap`}
      className="block px-4 py-2.5 transition-colors hover:bg-muted/50"
    >
      {body}
    </Link>
  )
}

export function FocusAreas({ skills, hasAnyMastery = false, loadError = false }: FocusAreasProps) {
  // Derived here, not taken as a prop: the conclusion depends on `skills` being empty,
  // and a caller cannot get that pairing wrong if it never supplies it.
  const allStrong = skills.length === 0 && hasAnyMastery
  return (
    <section className="flex flex-col h-full min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
        <Target className="h-4 w-4 text-muted-foreground shrink-0" />
        <h2 className="truncate min-w-0 text-base font-semibold tracking-tight text-foreground">Focus areas</h2>
        {skills.length > 0 && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            weakest {skills.length}
          </span>
        )}
      </div>

      {loadError ? (
        <div className="flex-1 flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <CircleAlert className="h-4 w-4 text-destructive-muted-foreground shrink-0" />
          Couldn&apos;t load your topics. Refresh to try again.
        </div>
      ) : allStrong ? (
        <div className="flex-1 flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <Check className="h-4 w-4 text-success shrink-0" />
          Nothing needs attention right now
        </div>
      ) : skills.length === 0 ? (
        /* The first-run state, and the most common one early in a term — every student
           starts here. Says what makes it fill up rather than just reporting emptiness. */
        <div className="flex-1 flex flex-col items-center justify-center gap-1 px-6 py-6 text-center">
          <p className="text-sm text-muted-foreground">No topics scored yet</p>
          <p className="text-xs text-muted-foreground/80">
            Your weakest topics show up here once your graded work has been marked.
          </p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-border">
          {skills.map((skill) => (
            <Row key={`${skill.sectionId}:${skill.skillId}`} skill={skill} />
          ))}
        </div>
      )}

    </section>
  )
}
