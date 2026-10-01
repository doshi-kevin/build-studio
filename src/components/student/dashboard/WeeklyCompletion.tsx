// Weekly completion tracker for the student dashboard right rail.
// A donut showing how much of this week's workload is done: assignments/quizzes
// (from the feed's is_done, via getWeeklyCompletion) plus project deliverables
// (phase status, via getStudentProjectDeliverables) — combined by the page.
//
// Lives in a resizable half-column, so it's a container-query card: the ring sits
// left of its text, and when the column is dragged too narrow for the text it drops
// just that text (ring centers). The "Weekly completion" heading always stays.

import { PieChart } from 'lucide-react'

interface WeeklyCompletionProps {
  done: number
  total: number
}

const RADIUS = 26
const CIRC = 2 * Math.PI * RADIUS

export function WeeklyCompletion({ done, total }: WeeklyCompletionProps) {
  const hasWork = total > 0
  const pct = hasWork ? Math.round((done / total) * 100) : 0
  const dash = (pct / 100) * CIRC

  return (
    <section className="@container flex flex-col h-full min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
      {/* Heading always visible — its width sets a sensible floor for how narrow the card shrinks. */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <PieChart className="h-4 w-4 text-muted-foreground shrink-0" />
        <h2 className="truncate text-base font-semibold tracking-tight text-foreground">Weekly completion</h2>
      </div>

      {/* Ring left, text right. Below ~210px the text won't fit, so it drops out and the ring centers. */}
      <div className="flex-1 min-h-0 flex items-center gap-4 overflow-hidden px-4 py-4 @max-[210px]:justify-center @max-[210px]:gap-0">
        <div className="relative h-20 w-20 shrink-0">
          <svg viewBox="0 0 64 64" className="h-20 w-20 -rotate-90">
            <circle cx="32" cy="32" r={RADIUS} fill="none" strokeWidth="7" stroke="currentColor" className="text-muted" />
            {hasWork && (
              <circle
                cx="32" cy="32" r={RADIUS} fill="none" strokeWidth="7" strokeLinecap="round"
                stroke="currentColor" className="text-chart-1"
                strokeDasharray={`${dash} ${CIRC}`}
              />
            )}
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums text-foreground">
            {hasWork ? `${pct}%` : '—'}
          </span>
        </div>

        <div className="min-w-0 @max-[210px]:hidden">
          <p className="text-sm font-medium text-foreground">
            {hasWork ? `${done} of ${total} done` : 'Nothing due this week'}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">Assignments, quizzes &amp; projects due this week.</p>
          <p className="mt-1 text-[11px] text-muted-foreground/70">Resets Monday morning.</p>
        </div>
      </div>
    </section>
  )
}
