// Grading queue card for the professor dashboard right rail.
//
// Answers "what do I grade next?", not "how much is there?". An aggregate total
// across every course can't name the pile to open, so this lists one row per
// ASSIGNMENT with work waiting — count, how long the oldest submission has
// waited, and a link straight into that assignment's grading tab.
//
// The professor's counterpart to the student's WeeklyCompletion ring, and
// deliberately not a ring: a percentage transplanted from the student view
// measures nothing a professor controls, and reads as a scorecard rather than a
// prompt.
//
// Client component for one reason — the header's sort dropdown. Rows arrive
// already ordered oldest-first from the server, so the first paint is correct
// and re-ordering never costs a round trip. It receives finished, plain data
// only; nothing server-side comes near it, and its one runtime import
// (`sortGradingQueue`) is a pure function whose own import graph is type-only.

'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ClipboardCheck, ArrowRight, CheckCircle2, AlertTriangle, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu'
import {
  sortGradingQueue,
  type GradingQueueEntry,
  type GradingQueueSort,
} from '@/lib/dashboard/professor-todos'

/**
 * The two orderings. `trigger` is the compact label on the header control;
 * `menu` is the fuller one, since the open menu has room the header doesn't.
 */
const SORT_OPTIONS: ReadonlyArray<{ value: GradingQueueSort; trigger: string; menu: string }> = [
  { value: 'oldest', trigger: 'Oldest', menu: 'Longest wait first' },
  { value: 'most', trigger: 'Most', menu: 'Most waiting first' },
]

/** Matches the to-do list's escalation point: past 3 days a wait stops being
 *  normal turnaround and starts being a student wondering. */
const ATTENTION_DAYS = 3
/**
 * Where the age turns red. Deliberately later than ATTENTION_DAYS, which is
 * tuned for `TodoList` — there, grading rows are a minority of a mixed feed, so
 * red marks a small subset. Here EVERY row is a grading row, so colouring
 * everything past 3 days makes red the background rather than the signal, and
 * under the default oldest-first sort it would just restate the row order.
 */
const URGENT_DAYS = 7

interface GradingQueueCardProps {
  /** One row per assignment with ungraded submissions, oldest-first. */
  entries: GradingQueueEntry[]
  /**
   * The fetch failed. Renders an explicit error rather than an empty list,
   * because a confident "nothing waiting" on a broken load is how a professor
   * misses a week of ungraded work. Checked BEFORE the empty state, and there's
   * a test pinning that order — it currently holds only because that branch
   * comes first.
   */
  loadError?: boolean
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="@container flex flex-col h-full min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
      {children}
    </section>
  )
}

/** `children` carries the sort controls, so they sit on the title row rather
 *  than costing the list a second row of vertical space. */
function CardHeader({ total, children }: { total: number | null; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
      {/* Order of sacrifice, measured against a real container width. At the
          dashboard's default split this card gets ~237px:
            1440 − 240 (sidebar, lg:w-60) − 64 (main lg:p-8) = 1136 content
            rail 40% ≈ 454 → −12 (pl-3) = 442 → grading 55% ≈ 243 → −6 = ~237
          The icon goes first (the title already says what it says), then the
          total. The TITLE never truncates at the default width and the sort
          control never disappears — those two were the Major findings. */}
      <ClipboardCheck className="h-4 w-4 text-muted-foreground shrink-0 @max-[250px]:hidden" />
      <h2 className="min-w-0 truncate text-base font-semibold tracking-tight text-foreground">Grading queue</h2>
      {/* A bare number beside a title has no unit, so the accessible name spells
          it out. Hidden below 285px, which means it is NOT visible at the
          default 1440px split — every row carries its own count, so this is the
          nice-to-have that loses the contest for header space. */}
      {total != null && total > 0 && (
        <span
          aria-label={`${total} submissions waiting in total`}
          className="shrink-0 text-sm font-semibold tabular-nums text-muted-foreground @max-[285px]:hidden"
        >
          {total}
        </span>
      )}
      {children && <div className="ml-auto shrink-0">{children}</div>}
    </div>
  )
}

export function GradingQueueCard({ entries, loadError = false }: GradingQueueCardProps) {
  const [sort, setSort] = useState<GradingQueueSort>('oldest')

  const rows = useMemo(() => sortGradingQueue(entries, sort), [entries, sort])
  const total = useMemo(() => entries.reduce((sum, e) => sum + e.waiting, 0), [entries])
  const activeSort = SORT_OPTIONS.find((o) => o.value === sort) ?? SORT_OPTIONS[0]

  if (loadError) {
    return (
      <CardShell>
        <CardHeader total={null} />
        {/* Same container queries as the empty state below — both are an 80px
            tile beside a sentence, so both have to fail the same way when the
            panel is dragged in. An icon rather than the old "—": that dash
            stood in for a big number this card no longer has, and on its own it
            doesn't read as "load failed". */}
        <div className="flex-1 min-h-0 flex items-center gap-4 overflow-hidden px-4 py-4 @max-[240px]:flex-col @max-[240px]:justify-center @max-[240px]:gap-2">
          <div className="grid h-20 w-20 shrink-0 place-items-center rounded-2xl bg-destructive-muted">
            <AlertTriangle className="h-8 w-8 text-destructive-muted-foreground" aria-hidden="true" />
          </div>
          <div className="min-w-0 @max-[240px]:text-center">
            <p className="text-sm font-semibold text-foreground">Couldn&apos;t load your grading queue</p>
            <p className="mt-0.5 text-xs text-muted-foreground @max-[200px]:hidden">Refresh the page to try again.</p>
          </div>
        </div>
      </CardShell>
    )
  }

  if (rows.length === 0) {
    return (
      <CardShell>
        <CardHeader total={null} />
        {/* No sort controls here — a control that reorders nothing makes an
            empty state look broken rather than finished.
            The icon and text stack below 240px: side by side, an 80px block
            plus a sentence has nowhere to go once the panel is dragged in. */}
        <div className="flex-1 min-h-0 flex items-center gap-4 overflow-hidden px-4 py-4 @max-[240px]:flex-col @max-[240px]:justify-center @max-[240px]:gap-2">
          <div className="grid h-20 w-20 shrink-0 place-items-center rounded-2xl bg-success-muted">
            <CheckCircle2 className="h-8 w-8 text-success-muted-foreground" aria-hidden="true" />
          </div>
          <div className="min-w-0 @max-[240px]:text-center">
            <p className="text-sm font-semibold text-foreground">Nothing waiting to be graded</p>
            <p className="mt-0.5 text-xs text-muted-foreground @max-[200px]:hidden">
              New submissions show up here as students hand them in.
            </p>
          </div>
        </div>
      </CardShell>
    )
  }

  return (
    <CardShell>
      {/* Present whenever there's anything to grade, even at a single row where
          reordering is a no-op: the buttons are how a professor learns the list
          IS sortable, and a control that only appears once the backlog grows is
          a control nobody finds. */}
      <CardHeader total={total}>
        {/* One trigger rather than two pills. Two ~20px targets 2px apart meant
            a mis-tap silently reordered the list, and the pair cost enough
            header width to truncate the card's own title. The trigger's label
            doubles as the current-state readout, so one control communicates
            both. Radix supplies the single-select semantics (radiogroup, arrow
            keys, checked-state announcement) that hand-rolled aria-pressed
            buttons described incorrectly. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Sort the grading queue — currently ${activeSort.menu.toLowerCase()}`}
            /* Same string as the aria-label: once the trigger is icon-only, a bare
               chevron is all a mouse user has, and they get no aria. */
            title={`Sort the grading queue — currently ${activeSort.menu.toLowerCase()}`}
            className={cn(
              /* min-h-11 sm:min-h-8 — the house idiom (10+ sites) — lifts the touch
                 target to the 44px floor on a phone; it was 32px. min-height beats
                 height, so it holds regardless of utility order. The container-query
                 sizing below is the card's own width, a different axis, unchanged. */
              'inline-flex min-h-11 sm:min-h-8 shrink-0 items-center gap-1 rounded-full px-2 py-1.5',
              'text-[11px] font-semibold text-muted-foreground cursor-pointer',
              'transition-colors duration-200 ease-out motion-reduce:transition-none',
              'hover:bg-accent hover:text-accent-foreground',
              'data-[state=open]:bg-accent data-[state=open]:text-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            {/* Below ~170px of card the header can't hold both the title and a
                worded trigger, and it used to be the TITLE that lost — the card
                rendered with no label at all, only "Oldest ⌄" (#722). The
                chevron plus the aria-label carry the control on their own, so
                the label is what gives way and the card keeps its name. */}
            <span className="truncate @max-[215px]:hidden">{activeSort.trigger}</span>
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as GradingQueueSort)}>
              {SORT_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.menu}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>

      {/* Rows visibly move when the sort changes; without this that feedback has
          no non-visual equivalent, since aria-pressed only announces that a
          button turned on. */}
      <span className="sr-only" aria-live="polite">
        {sort === 'oldest' ? 'Sorted by longest wait' : 'Sorted by most waiting'}
      </span>

      {/* The list scrolls rather than truncating: a "+8 more" would hide exactly
          the backlog this card exists to surface. */}
      <ul className="flex-1 min-h-0 overflow-y-auto p-1.5">
        {rows.map((entry) => (
          <li key={entry.assessmentId}>
            <GradingQueueRow entry={entry} />
          </li>
        ))}
      </ul>
    </CardShell>
  )
}

function GradingQueueRow({ entry }: { entry: GradingQueueEntry }) {
  const { title, courseCode, waiting, oldestDays, href } = entry
  const ageLabel = oldestDays >= 1 ? `${oldestDays}d` : 'New'

  // Three tiers, not two. Weight carries the middle tier so red stays reserved
  // for the genuinely old row — the one worth spotting when it's buried
  // mid-list under the "Most" sort, which is the only time colour beats
  // position at telling you where to look.
  const ageTone =
    oldestDays >= URGENT_DAYS ? 'text-destructive-muted-foreground'
    : oldestDays >= ATTENTION_DAYS ? 'text-foreground'
    : 'text-muted-foreground'

  // Spelled out for the screen reader, because the visible row compresses to
  // "9d" and "12 waiting" — accurate but not a sentence.
  const spokenAge = oldestDays >= 1
    ? `oldest submitted ${oldestDays} day${oldestDays === 1 ? '' : 's'} ago`
    : 'all submitted today'

  return (
    <Link
      href={href}
      aria-label={`Grade ${title}${courseCode ? ` in ${courseCode}` : ''} — ${waiting} submission${waiting === 1 ? '' : 's'} waiting, ${spokenAge}`}
      className={cn(
        'group flex flex-col gap-0.5 rounded-xl px-2.5 py-2',
        'hover:bg-accent/50 transition duration-200 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <div className="flex items-baseline gap-2">
        {/* This card sits in a resizable panel that can be dragged narrow
            enough to clip the title, so carry the full text in `title` —
            screen readers already have it via the link's aria-label, but
            sighted users need a way to recover it. */}
        <p
          title={title}
          className="flex-1 min-w-0 truncate text-sm font-medium leading-snug text-foreground"
        >
          {title}
        </p>
        {/* The age never drops — it's the reason to open this row rather than
            the next one. Colour is a second signal on top of the number
            itself, never the only one. */}
        <span className={cn('shrink-0 text-xs font-semibold tabular-nums', ageTone)}>
          {ageLabel}
        </span>
        <ArrowRight
          className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground/0 group-hover:text-muted-foreground/50
                     -translate-x-1 group-hover:translate-x-0 transition duration-200 ease-out
                     motion-reduce:transition-none"
          aria-hidden="true"
        />
      </div>

      {/* Never hidden. Rows are per-assignment, and several assignments can
          share a title across courses ("Problem Set 4"), so without the course
          code a row can be genuinely ambiguous about which class it belongs to.
          It truncates instead — short enough to survive the narrowest drag. */}
      {/* The count is emphasised and the course code isn't: under the "Most"
          sort the count is what the list is ordered by, and at equal size and
          colour it would read as a peer of an identifier instead of the
          decision input. */}
      <p className="truncate text-[11px] text-muted-foreground">
        {courseCode && <span className="font-mono">{courseCode}</span>}
        {courseCode && ' · '}
        <span className="font-medium text-foreground">{waiting} waiting</span>
      </p>
    </Link>
  )
}
