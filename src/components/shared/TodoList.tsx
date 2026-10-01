// System-generated action feed for dashboards. Items are auto-surfaced
// based on role (e.g. ungraded submissions, pending requests). Interactive
// dismiss with smooth animations. Not a user-created reminder list.

'use client'

import { useState, useCallback, useRef, useLayoutEffect } from 'react'
import Link from 'next/link'
import {
  Check,
  X,
  ListTodo,
  ClipboardCheck,
  ListChecks,
  BarChart3,
  FileText,
  FolderKanban,
  CalendarDays,
  CircleAlert,
  Clock,
  Eye,
  ChevronDown,
  Presentation,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { computeAutoCollapse, type TodoItem } from '@/lib/dashboard/todos'
import type { ProfessorTodoItem } from '@/lib/dashboard/professor-todos'
import { tintStyle, TODO_KIND_CATEGORY, PROFESSOR_TODO_KIND_CATEGORY } from '@/lib/calendar/category-colors'

type TimeGroup = 'attention' | 'upcoming' | 'later'

/** Both dashboards render through this component; the student list carries
 *  per-assessment items, the professor list carries per-(course × kind) rows. */
type AnyTodoItem = TodoItem | ProfessorTodoItem
type AnyTodoKind = AnyTodoItem['kind']

interface ActionItem {
  id: string
  title: string
  description: string
  dueLabel: string
  group: TimeGroup
  icon: React.ComponentType<{ className?: string }>
  /** When set, the row links here (real to-dos); mock items have none. */
  href?: string
  /** Real to-do kind — drives the category-colored icon; absent for mock items. */
  kind?: AnyTodoKind
}

/** Icon per real to-do kind (mock items carry their own icons). Matches the
 *  notification system's icons so iconography is uniform across the app. */
const KIND_ICON: Record<AnyTodoKind, React.ComponentType<{ className?: string }>> = {
  // Student
  assignment: FileText,
  quiz: ListChecks,
  project: FolderKanban,
  // Professor
  grading: ClipboardCheck,
  deadline: CalendarDays,
  class_prep: Presentation,
  class_report: BarChart3,
}

/** Kind → calendar category, so a row's icon takes the same colour as the
 *  matching calendar event on either dashboard. */
const KIND_CATEGORY = { ...TODO_KIND_CATEGORY, ...PROFESSOR_TODO_KIND_CATEGORY }

const GROUP_CONFIG: Record<TimeGroup, {
  label: string
  icon: React.ComponentType<{ className?: string }>
}> = {
  attention: { label: 'Needs Attention', icon: CircleAlert },
  upcoming:  { label: 'Coming Up',      icon: Clock },
  later:     { label: 'On Your Radar',  icon: Eye },
}

const DUE_STYLE: Record<TimeGroup, string> = {
  attention: 'bg-destructive-muted text-destructive-muted-foreground',
  upcoming:  'bg-warning-muted text-warning-muted-foreground',
  later:     'bg-muted text-muted-foreground',
}

// ── Single action row ───────────────────────────────────────────────────────
// A calm, Linear/Things-style task row: a dedicated complete-circle as the
// primary affordance (separated from the category icon), a prominent title with
// the due chip right-aligned, and the category icon moved small + inline onto
// the description line. Borderless with a soft hover fill — urgency is carried
// by the group + the due-chip color, so priority isn't triple-encoded.

function ActionRow({
  item,
  dismissible,
  dismissed,
  onDismiss,
}: {
  item: ActionItem
  /** Mock system-feed rows (professor/admin) can be checked off; real student to-dos cannot. */
  dismissible: boolean
  dismissed: boolean
  onDismiss: (id: string) => void
}) {
  // Dismissal is owned by the parent (so Undo can restore rows); only the brief
  // "checking off" animation is local. Reset it whenever the row is un-dismissed.
  const [completing, setCompleting] = useState(false)
  const Icon = item.icon

  const handleComplete = useCallback(() => {
    if (dismissed || completing) return
    setCompleting(true)
    // After the check animation, hand dismissal to the parent (so Undo can
    // restore the row) and clear the local animation flag.
    setTimeout(() => {
      onDismiss(item.id)
      setCompleting(false)
    }, 400)
  }, [dismissed, completing, item.id, onDismiss])

  const contentClass = cn(
    'min-w-0 flex-1 transition-opacity duration-300 motion-reduce:transition-none',
    completing && 'opacity-50',
  )
  const content = (
    <>
      <div className="flex items-start justify-between gap-2.5">
        <p
          className={cn(
            'min-w-0 flex-1 text-[13px] font-semibold leading-snug text-foreground',
            completing && 'text-muted-foreground line-through',
          )}
        >
          {item.title}
        </p>
        <span
          className={cn(
            'mt-px shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums',
            completing
              ? 'bg-success-muted text-success-muted-foreground'
              : DUE_STYLE[item.group],
          )}
        >
          {completing ? 'Done' : item.dueLabel}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {/* Real to-dos carry a leading icon instead; only the mock feed shows it inline. */}
        {dismissible && <Icon className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />}
        <span className="truncate">{item.description}</span>
      </div>
    </>
  )

  // Leading element: a "mark done" control for the mock feed; a category icon
  // for real to-dos (which leave the list only on real completion). The icon is
  // non-interactive, so real-to-do rows can be a single edge-to-edge link.
  const leading = dismissible ? (
    <button
      onClick={handleComplete}
      aria-label="Mark as done"
      className={cn(
        'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition duration-200 ease-out motion-reduce:transition-none',
        completing
          ? 'border-success bg-success'
          : 'border-muted-foreground/30 hover:border-success/60',
      )}
    >
      <Check
        className={cn(
          'h-3 w-3 transition duration-200 motion-reduce:transition-none',
          completing
            ? 'scale-100 text-success-foreground'
            : 'scale-90 text-success/0 group-hover:text-success/70',
        )}
        strokeWidth={3}
      />
    </button>
  ) : (
    <div
      className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"
      style={item.kind ? tintStyle(KIND_CATEGORY[item.kind]) : undefined}
      aria-hidden="true"
    >
      <Icon className="h-3.5 w-3.5" />
    </div>
  )

  const rowClass = cn(
    'group flex items-start gap-3 rounded-xl px-2.5 py-2.5 transition duration-200 ease-out motion-reduce:transition-none',
    completing ? 'bg-success-muted/60' : 'hover:bg-muted/60',
  )
  const inner = (
    <>
      {leading}
      <div className={contentClass}>{content}</div>
    </>
  )

  return (
    <div
      className={cn(
        'overflow-hidden transition-[max-height,opacity] duration-300 ease-out motion-reduce:transition-none',
        dismissed ? 'max-h-0 opacity-0' : 'max-h-40 opacity-100',
      )}
    >
      {/* Real to-dos are one full-row link so the whole highlighted row is the
          click target (no dead zones). The mock feed has no destination and keeps
          its check-off button as the sole affordance. */}
      {item.href ? (
        <Link
          href={item.href}
          className={cn(rowClass, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40')}
        >
          {inner}
        </Link>
      ) : (
        <div className={rowClass}>{inner}</div>
      )}
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

export function TodoList({
  items,
  courseCodeBySection,
  enableCollapse = false,
  loadError = false,
}: {
  /** Required: there is no fallback feed. A caller with nothing to show passes []. */
  items: AnyTodoItem[]
  /** section_id → course code; when provided, real to-dos show their course code as subtext.
   *  Student-only: professor rows already lead with the course code in their description. */
  courseCodeBySection?: Record<string, string>
  /**
   * Student-only for now: makes each group header a collapse toggle and auto-fits
   * the list to the available height (collapse "On Your Radar", then "Coming Up",
   * never "Needs Attention") so the container scrolls internally instead of the page.
   * Off for the professor/admin mock feed, which stays unchanged.
   */
  enableCollapse?: boolean
  /**
   * When the caller's feed fetch failed, render a distinct error state instead of
   * the "all caught up" empty state — otherwise a failed load looks identical to
   * having no work, which could hide real pending to-dos from a student.
   */
  loadError?: boolean
}) {
  // Every to-do is real data now — `items` is required, so there is no fallback branch.
  const allItems: ActionItem[] = items.map((it) => {
        // Subtext = the owning course code (falls back to the feed body).
        const code = it.sectionId ? courseCodeBySection?.[it.sectionId] : undefined
        return {
          id: it.id,
          title: it.title,
          description: code ?? it.description,
          dueLabel: it.dueLabel,
          group: it.group,
          icon: KIND_ICON[it.kind],
          href: it.href,
          kind: it.kind,
        }
      })
  /* Every to-do now comes from real data, and real work is completed by doing it
     (submit, attempt, resolve) rather than by ticking it off — so nothing here is
     dismissible. The check-off + undo affordance belonged to the removed mock feed. */
  const dismissible = false
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const activeItems = allItems.filter((i) => !dismissed.has(i.id))
  const dismissedCount = dismissed.size

  // Counts by group
  const urgentCount = activeItems.filter((i) => i.group === 'attention').length
  const upcomingCount = activeItems.filter((i) => i.group === 'upcoming').length
  const laterCount = activeItems.filter((i) => i.group === 'later').length

  // Group items
  const groups: TimeGroup[] = ['attention', 'upcoming', 'later']
  const grouped = groups
    .map((g) => ({ key: g, items: allItems.filter((i) => i.group === g) }))
    .filter((g) => g.items.some((i) => !dismissed.has(i.id)))

  // ── Collapse + auto-fit (student view only) ───────────────────────────────
  // `overrides` are the student's explicit toggles; `autoCollapsed` is what the
  // fit computation decides. Effective state = override if set, else auto.
  const [overrides, setOverrides] = useState<Partial<Record<TimeGroup, boolean>>>({})
  const [autoCollapsed, setAutoCollapsed] = useState<Set<TimeGroup>>(new Set())

  const feedRef = useRef<HTMLDivElement>(null)
  const headerRefs = useRef<Partial<Record<TimeGroup, HTMLElement | null>>>({})
  const bodyRefs = useRef<Partial<Record<TimeGroup, HTMLElement | null>>>({})

  const isCollapsed = (key: TimeGroup) =>
    enableCollapse && (overrides[key] ?? autoCollapsed.has(key))

  const toggleGroup = (key: TimeGroup) => {
    const collapsed = overrides[key] ?? autoCollapsed.has(key)
    setOverrides((prev) => ({ ...prev, [key]: !collapsed }))
  }

  // Signature of what's rendered — re-fit only when the visible items change.
  const activeSignature = activeItems.map((i) => `${i.group}:${i.id}`).join('|')

  // Auto-fit: if the groups overflow the container, collapse the lowest-priority
  // groups (On Your Radar, then Coming Up; never Needs Attention) until they fit.
  // Measurements (available height, natural body heights, header heights) don't
  // change when a group collapses, so this settles in one pass — no reflow loop.
  // useLayoutEffect (not useEffect) so the fit is applied before paint — otherwise
  // the first frame shows every group expanded and then visibly collapses on load.
  useLayoutEffect(() => {
    if (!enableCollapse) return
    const feed = feedRef.current
    if (!feed) return

    const measure = () => {
      // Read the DOM here; the fit decision is the pure computeAutoCollapse.
      const avail = feed.clientHeight
      if (avail === 0) return
      const present = grouped.map((g) => g.key)
      const bodyHeights: Partial<Record<TimeGroup, number>> = {}
      let chrome = 0
      for (const key of present) {
        bodyHeights[key] = bodyRefs.current[key]?.scrollHeight ?? 0
        chrome += headerRefs.current[key]?.offsetHeight ?? 0
      }

      const next = computeAutoCollapse({ available: avail, chrome, bodyHeights, present, overrides })
      setAutoCollapsed((prev) =>
        prev.size === next.size && [...next].every((k) => prev.has(k)) ? prev : next,
      )
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(feed)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableCollapse, activeSignature, overrides])

  return (
    // flex-auto + min-h-0 (not h-full): h-full needs a definite parent height, but
    // the student section is capped with max-h (auto height), so percentage height
    // wouldn't resolve there and the feed couldn't scroll. flex-auto hugs content when
    // short and shrinks-to-scroll when the parent clamps it — and fills a fixed-height
    // parent (professor/admin) just like h-full did.
    <div className="flex flex-col flex-auto min-h-0">
      {/* ── Integrated header: title + segment counts on one line ── */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2.5">
          <ListTodo className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold tracking-tight text-foreground">To-do&apos;s</h2>
          <span className="text-[11px] font-semibold text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 tabular-nums">
            {activeItems.length}
          </span>
        </div>

        <div className="flex items-center gap-3.5">
          {urgentCount > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-1.5 rounded-full bg-destructive" />
              <span className="text-[10px] font-semibold text-muted-foreground">{urgentCount} urgent</span>
            </div>
          )}
          {upcomingCount > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-1.5 rounded-full bg-warning" />
              <span className="text-[10px] font-semibold text-muted-foreground">{upcomingCount} upcoming</span>
            </div>
          )}
          {laterCount > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
              <span className="text-[10px] font-semibold text-muted-foreground">{laterCount} later</span>
            </div>
          )}
          {dismissedCount > 0 && (
            <>
              <div className="h-3.5 w-px bg-border" />
              <button
                onClick={() => setDismissed(new Set())}
                className="text-[10px] text-muted-foreground hover:text-foreground font-semibold transition-colors flex items-center gap-1"
              >
                <X className="h-3 w-3" />
                Undo ({dismissedCount})
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Error state ─────────────────────────────────────────── */}
      {/* A failed feed load must NOT masquerade as "all caught up" — that could
          hide real pending work and cause a missed deadline. */}
      {loadError && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 py-12">
          <div className="h-12 w-12 rounded-2xl bg-destructive-muted flex items-center justify-center">
            <CircleAlert className="h-6 w-6 text-destructive-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground">Couldn&apos;t load your to-dos</p>
            <p className="text-[12px] text-muted-foreground mt-1">Refresh the page to try again</p>
          </div>
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────── */}
      {!loadError && activeItems.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 py-12">
          <div className="h-12 w-12 rounded-2xl bg-success-muted flex items-center justify-center">
            <Check className="h-6 w-6 text-success-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground">You&apos;re all caught up</p>
            <p className="text-[12px] text-muted-foreground mt-1">No pending actions right now</p>
          </div>
        </div>
      )}

      {/* ── Action feed ─────────────────────────────────────────── */}
      {/* min-h-0 is load-bearing: without it a flex child grows to its content
          height instead of scrolling, which clips overflow and makes the auto-fit
          measurement read the available height as unbounded. */}
      <div ref={feedRef} className="flex-1 min-h-0 overflow-y-auto">
        {grouped.map((group, gi) => {
          const config = GROUP_CONFIG[group.key]
          const GroupIcon = config.icon
          const collapsed = isCollapsed(group.key)
          const activeCount = group.items.filter((i) => !dismissed.has(i.id)).length
          const bodyId = `todo-group-${group.key}`

          const headerInner = (
            <>
              <GroupIcon className="h-3.5 w-3.5 text-muted-foreground/50" />
              <span className="text-[11px] font-semibold text-muted-foreground/70 uppercase tracking-[0.12em]">
                {config.label}
              </span>
              <span className="text-[10px] font-medium text-muted-foreground/40 ml-auto tabular-nums">
                {activeCount}
              </span>
              {enableCollapse && (
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground/50 transition-transform duration-200 motion-reduce:transition-none',
                    collapsed && '-rotate-90',
                  )}
                  aria-hidden="true"
                />
              )}
            </>
          )

          const body = (
            <div
              ref={(el) => { bodyRefs.current[group.key] = el }}
              className="px-3 pb-2"
            >
              {group.items.map((item) => (
                <ActionRow
                  key={item.id}
                  item={item}
                  dismissible={dismissible}
                  dismissed={dismissed.has(item.id)}
                  onDismiss={dismiss}
                />
              ))}
            </div>
          )

          return (
            <div key={group.key} className={cn(gi > 0 && 'border-t border-border/40')}>
              {/* Group header — a collapse toggle when enabled, else a plain label */}
              {enableCollapse ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={!collapsed}
                  aria-controls={bodyId}
                  ref={(el) => { headerRefs.current[group.key] = el }}
                  className="sticky top-0 z-10 w-full text-left bg-card/95 backdrop-blur-sm flex items-center gap-2 px-5 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
                >
                  {headerInner}
                </button>
              ) : (
                <div className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm flex items-center gap-2 px-5 py-2.5">
                  {headerInner}
                </div>
              )}

              {/* Items — animated collapse (grid-rows trick) when enabled. `inert` +
                  aria-hidden when collapsed so the hidden rows (and their links) leave
                  the tab order and screen-reader flow, matching aria-expanded. */}
              {enableCollapse ? (
                <div
                  id={bodyId}
                  inert={collapsed}
                  aria-hidden={collapsed}
                  className={cn(
                    'grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none',
                    collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
                  )}
                >
                  <div className="overflow-hidden">{body}</div>
                </div>
              ) : (
                body
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
