/**
 * CourseSidebar — course-level navigation within the professor course container.
 *
 * Shows EVERY course feature by default, in the professor's custom order.
 * Features are removed via an inline X button and reordered by dragging.
 *
 * Professor nav is deliberately decoupled from student visibility. A feature
 * has three states:
 *   - draft     — in this sidebar, hidden from students (the default; the
 *                 professor can build it out before anyone sees it)
 *   - published — in this sidebar and in the student sidebar
 *   - hidden    — in neither; the professor removed it with the X button
 * "Manage Features" controls publishing; the X controls this sidebar.
 *
 * Type: Client Component (needs usePathname + useTransition + DnD)
 */
'use client'

import { useState, useTransition, useCallback, useMemo, useOptimistic } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowLeft, X, GripVertical, Home, SlidersHorizontal, PanelLeftClose, PanelLeftOpen, EyeOff } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  COURSE_FEATURES,
  courseAssistantCanSee,
  PROFESSOR_SIDEBAR_FEATURES,
  orderFeatures,
  orderWithTools,
  activeFeatureKey,
  classifyFeatureToggle,
  studioToolFeature,
  type CourseFeature,
  type StudioTool,
} from '@/lib/course-features'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toggleCourseFeature, reorderCourseFeatures, setCourseSidebarVisibility } from '@/app/(dashboard)/professor/courses/[sectionId]/actions'
import { useSidebarRail } from '@/lib/hooks/use-sidebar-rail'

interface CourseSidebarProps {
  sectionId: string
  courseName: string
  courseCode: string
  /** Features published to students. Drives the popover checkboxes, not this sidebar. */
  enabledFeatures: string[]
  /** Features the professor removed from this sidebar. Empty = show everything. */
  sidebarHidden?: string[]
  /**
   * Feature keys the INSTITUTION has not bought. A different axis from
   * enabledFeatures (the professor's per-section student-visibility toggle) and
   * a strictly harder one: entitlement is the ceiling, so an unentitled feature
   * is not in the nav and not in Manage Features either. There is nothing for a
   * professor to decide about a feature the school does not have.
   */
  unentitledFeatures?: string[]
  /** Display order; may be partial. Unlisted features append in registry order. */
  sidebarOrder?: string[]
  /** The section's active Studio plugins, professor only. Marked when hidden from
   * students. Display only: the plugin page checks access itself. */
  studioTools?: StudioTool[]
  /** Caller's role for this section. Defaults to 'professor' for backwards
   * compatibility; 'ta'/'grader' hides feature-management controls. */
  userRole?: 'professor' | 'ta' | 'grader'
}

export function CourseSidebar({
  sectionId,
  courseName,
  courseCode,
  enabledFeatures,
  sidebarHidden = [],
  unentitledFeatures = [],
  sidebarOrder = [],
  studioTools = [],
  userRole = 'professor',
}: CourseSidebarProps) {
  const pathname = usePathname()
  const basePath = `/professor/courses/${sectionId}`
  const isProfessor = userRole === 'professor'

  /* Hover/click-to-expand rail; open mode is a persisted per-browser
     preference (see useSidebarRail). In click mode the mouse handlers no-op. */
  const { mode, expanded, docked, animate, collapsed, expand, scheduleCollapse, handleBlurCapture, toggle } = useSidebarRail()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  /* The drop has to land instantly. Without this the row snapped back to its
   * old slot for ~1.5s while the action round-tripped, which reads as "the drag
   * failed" — so the professor drags again, and that second drag computes its
   * array from the stale order and silently discards the first. */
  const [optimisticOrder, setOptimisticOrder] = useOptimistic(sidebarOrder)
  const [, startReorder] = useTransition()

  // Every feature shows unless the professor explicitly hid it — professors
  // shouldn't have to go hunting in a popover to discover what the course can
  // do. Student-only features (AI Tutor, Course Intel, Class Primers) have no
  // professor page and are excluded by PROFESSOR_SIDEBAR_FEATURES.
  // Show-everything applies to the OWNING professor only. Course assistants
  // keep the old rule — allowlist ∩ (basics + what the professor published) —
  // so a TA never sees a feature the professor is still drafting.
  const activeFeatures = useMemo(() => {
    const hidden = new Set(sidebarHidden)
    const unentitled = new Set(unentitledFeatures)
    const visible = PROFESSOR_SIDEBAR_FEATURES.filter(
      (f) => !hidden.has(f.key) && !unentitled.has(f.key),
    )
    if (!isProfessor) {
      return orderFeatures(visible, optimisticOrder).filter((f) => courseAssistantCanSee(f, enabledFeatures))
    }
    // Plugin tabs ride the same drag order. They aren't entitled features: a school
    // that lost Studio keeps them, read-only, so its history stays reachable.
    const tools = studioTools.map((t) => studioToolFeature(t, 'professor'))
    return orderWithTools(visible, tools, optimisticOrder)
  }, [sidebarHidden, unentitledFeatures, optimisticOrder, isProfessor, enabledFeatures, studioTools])

  const activeKey = useMemo(() => activeFeatureKey(activeFeatures, basePath, pathname), [activeFeatures, basePath, pathname])

  // All toggleable features (additional + professor) for the Manage Features
  // popover, minus anything the institution has not bought.
  const toggleableFeatures = COURSE_FEATURES.filter(
    (f) => f.category !== 'basic' && !unentitledFeatures.includes(f.key),
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const fromIndex = activeFeatures.findIndex((f) => f.key === active.id)
    const toIndex = activeFeatures.findIndex((f) => f.key === over.id)
    if (fromIndex === -1 || toIndex === -1) return

    const reordered = [...activeFeatures]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(toIndex, 0, moved)
    const orderedKeys = reordered.map((f) => f.key)

    startReorder(async () => {
      // Paint first, then persist — the next drag reads this order, not the stale one.
      setOptimisticOrder(orderedKeys)
      const result = await reorderCourseFeatures(sectionId, orderedKeys)
      // On failure the optimistic value is dropped automatically and the
      // sidebar falls back to the server order.
      if (result.error) toast.error(result.error)
    })
  }, [activeFeatures, sectionId, setOptimisticOrder, startReorder])

  return (
    <TooltipProvider>
    {/* The placeholder carries the layout footprint. When DOCKED (click mode, md+)
        it grows with the panel so the page reflows beside the rail instead of being
        covered — that was the "screen should fit-to-page" ask. Hover mode, and any
        narrow viewport, keep the old overlay: reflowing on a hover pass thrashes the
        layout, and 224px of a 390px screen leaves no page to read. */}
    <div className={cn(
      'relative shrink-0 h-full w-14',
      // no transition on the first tick, or a restored rail slides the page across
      animate && 'transition-[width] duration-300 ease-in-out',
      docked && 'md:w-56',
    )}>
      <aside
        onMouseEnter={expand}
        onMouseLeave={scheduleCollapse}
        onFocusCapture={expand}
        onBlurCapture={handleBlurCapture}
        /* Column, not one big scroll box. The panel used to scroll as a whole,
           which pushed "Manage Features" off the bottom once the list grew to
           every feature — and on a hover-expanded rail you can't comfortably
           scroll to a footer, because reaching for it moves the pointer out and
           collapses the panel. Header and footer are pinned; only the links
           between them scroll. */
        className={cn(
          'absolute inset-y-0 left-0 z-30 flex h-full flex-col border-r border-sidebar-border bg-sidebar overflow-hidden ',
          animate && 'transition-[width,box-shadow] duration-300 ease-in-out',
          expanded ? 'w-56' : 'w-14',
          // Only float above the page when it is actually covering it.
          expanded && !docked && 'shadow-xl',
          docked && 'shadow-xl md:shadow-none',
        )}
      >

      {/* Explicit open/close toggle — only in click mode (hover mode uses the pointer) */}
      {mode === 'click' && (
        <div className={cn('pt-3', collapsed ? 'px-1.5 flex justify-center' : 'px-3 flex justify-end')}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={toggle}
                className="flex items-center justify-center p-2 rounded-md text-muted-foreground transition-colors hover:bg-background/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
                aria-expanded={expanded}
              >
                {expanded ? <PanelLeftClose className="h-4 w-4" aria-hidden="true" /> : <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{expanded ? 'Collapse sidebar' : 'Expand sidebar'}</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Back link — staff go back to their staff landing, professors to their course grid */}
      <div className={cn('pt-4 pb-2', collapsed ? 'px-2 flex justify-center' : 'px-3')}>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href={isProfessor ? '/professor/courses' : '/staff/courses'}
                className="flex items-center justify-center p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors"
                aria-label={isProfessor ? 'All Courses' : 'All Sections'}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">{isProfessor ? 'All Courses' : 'All Sections'}</TooltipContent>
          </Tooltip>
        ) : (
          <Link
            href={isProfessor ? '/professor/courses' : '/staff/courses'}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden="true" />
            {isProfessor ? 'All Courses' : 'All Sections'}
          </Link>
        )}
      </div>

      {/* Course header */}
      {!collapsed && (
        <div className="px-3 pb-3 border-b border-border">
          <p className="text-xs font-mono text-muted-foreground">{courseCode}</p>
          <h2 className="text-sm font-semibold text-foreground mt-0.5 line-clamp-2">{courseName}</h2>
        </div>
      )}
      {collapsed && <div className="border-b border-border" />}

      {/* Scroll region: everything above (back link, course header) and the
          Manage Features footer below stay pinned. min-h-0 is required — without
          it a flex child refuses to shrink below its content and the overflow
          escapes the panel instead of scrolling inside it. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">

      {/* Permanent About link — professor only. TAs don't see/edit the About
       * page (page builder is instructor-owned per v1 scope), so we hide it
       * for them rather than 404 when they click through. */}
      {isProfessor && (
        <nav className={cn('pt-3 pb-1', collapsed ? 'px-1.5' : 'px-2')}>
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href={basePath}
                  className={cn(
                    'flex items-center justify-center p-2 rounded-md transition-colors',
                    pathname === basePath
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                  )}
                  aria-label="About"
                >
                  <Home className="h-4 w-4" aria-hidden="true" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">About</TooltipContent>
            </Tooltip>
          ) : (
            <Link
              href={basePath}
              className={cn(
                'flex items-center gap-2.5 px-2.5 py-2 pl-5 text-sm font-medium rounded-md transition-colors',
                pathname === basePath
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              <Home className="h-4 w-4" aria-hidden="true" />
              About
            </Link>
          )}
        </nav>
      )}

      {/* DEPRECATED — the console Athena link is hidden (pilot D1).
          Every major feature now gets its own in-context Athena instance
          (assignments, quizzes, grading), so a separate general-purpose console is
          a second way to do the same thing — and the one place Athena has no
          context about what the professor is looking at.
          HIDDEN, NOT DELETED, on purpose: /assistant, its route, its saved
          conversations and its rate-limit pool all still work, so a bookmark keeps
          working and nothing has to be migrated yet. Remove the route and its
          components once every major feature has its own instance — tracked in
          docs/product/pilot-feedback-tracker.md (D1). */}

      {/* Enabled feature links — draggable (professor, full mode) or static (collapsed/staff) */}
      <nav className={cn('pb-3 space-y-0.5', collapsed ? 'px-1.5' : 'px-2')}>
        {collapsed || !isProfessor ? (
          // Collapsed: icon-only with tooltips. Staff (expanded): static links, no drag.
          activeFeatures.map((feature) => {
            const href = `${basePath}${feature.route}`
            const isActive = feature.key === activeKey
            const Icon = feature.icon
            if (collapsed) {
              return (
                <Tooltip key={feature.key}>
                  <TooltipTrigger asChild>
                    <Link
                      href={href}
                      className={cn(
                        'flex items-center justify-center p-2 rounded-md transition-colors',
                        isActive
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                      )}
                      aria-label={feature.studioTool?.hiddenFromStudents ? `${feature.label}, hidden from students` : feature.label}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {feature.label}
                    {feature.studioTool?.hiddenFromStudents ? ' · Hidden from students' : ''}
                  </TooltipContent>
                </Tooltip>
              )
            }
            return (
              <Link
                key={feature.key}
                href={href}
                className={cn(
                  'flex items-center gap-2.5 px-2.5 py-2 pl-5 text-sm font-medium rounded-md transition-colors',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {feature.label}
              </Link>
            )
          })
        ) : (
          // Professor (expanded): draggable links
          <DndContext
            id="sidebar-features-dnd"
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={activeFeatures.map((f) => f.key)}
              strategy={verticalListSortingStrategy}
            >
              {activeFeatures.map((feature) => (
                <SortableFeatureLink
                  key={feature.key}
                  feature={feature}
                  basePath={basePath}
                  isActive={feature.key === activeKey}
                  sectionId={sectionId}
                  // Plugin tabs leave the sidebar by archiving, not the X.
                  isBasic={feature.category === 'basic' || !!feature.studioTool}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </nav>

      </div>{/* end scroll region */}

      {/* Manage Features — professor only. Pinned outside the scroll region and
          shrink-0, so it stays reachable no matter how long the list gets or how
          short the viewport is. The top border separates it from links that
          scroll underneath it. */}
      {isProfessor && !collapsed && (
        <div className="shrink-0 border-t border-border bg-sidebar px-2 py-2">
          <ManageFeaturesPopover sectionId={sectionId} features={toggleableFeatures} enabledFeatures={enabledFeatures} sidebarHidden={sidebarHidden} />
        </div>
      )}
      {isProfessor && collapsed && (
        <div className="shrink-0 border-t border-border bg-sidebar px-1.5 py-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <ManageFeaturesPopover sectionId={sectionId} features={toggleableFeatures} enabledFeatures={enabledFeatures} sidebarHidden={sidebarHidden} collapsed />
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">Manage Features</TooltipContent>
          </Tooltip>
        </div>
      )}
    </aside>
    </div>
    </TooltipProvider>
  )
}

/** A single sortable sidebar feature link */
function SortableFeatureLink({ feature, basePath, isActive, sectionId, isBasic }: {
  feature: CourseFeature
  basePath: string
  isActive: boolean
  sectionId: string
  isBasic?: boolean
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: feature.key })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const href = `${basePath}${feature.route}`
  const Icon = feature.icon

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group relative flex items-center',
        isDragging && 'opacity-50 z-10',
      )}
      {...attributes}
    >
      {/* Drag handle */}
      <div
        className="absolute left-0 opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground transition-opacity z-10"
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </div>

      <Link
        href={href}
        className={cn(
          'flex-1 flex items-center gap-2.5 px-2.5 py-2 text-sm font-medium rounded-md transition-colors pl-5 group-hover:pl-5',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
        )}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate" title={feature.label}>{feature.label}</span>
        {feature.studioTool?.hiddenFromStudents && <HiddenFromStudentsMark />}
      </Link>
      {!isBasic && <RemoveFeatureButton sectionId={sectionId} featureKey={feature.key} label={feature.label} />}
    </div>
  )
}

/** Marks a Studio plugin tab students can't see. Icon plus words, not color alone. */
function HiddenFromStudentsMark() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center text-muted-foreground">
          <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">Hidden from students</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">Hidden from students</TooltipContent>
    </Tooltip>
  )
}

/** Badge describing who can currently see the feature, from live state rather
 *  than registry defaults — a shared feature sitting in draft would otherwise
 *  claim "You + Students" while students see nothing. */
function VisibilityBadge({ feature, isPublished, isHidden }: {
  feature: CourseFeature
  isPublished: boolean
  isHidden: boolean
}) {
  /* text-[10px], not 9px: the badge carries the feature's state and must not be
     smaller than the description line beneath it, or the secondary text outranks
     it while scanning. */
  const base = 'inline-flex items-center shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold'

  if (isHidden) {
    return <span className={cn(base, 'bg-muted text-muted-foreground')}>Hidden</span>
  }
  if (feature.studentOnly) {
    return (
      <span className={cn(base, 'bg-muted text-muted-foreground')}>
        {isPublished ? 'Students only' : 'Off'}
      </span>
    )
  }
  if (feature.professorOnly) {
    return <span className={cn(base, 'bg-secondary text-secondary-foreground')}>You only</span>
  }
  return isPublished ? (
    <span className={cn(base, 'bg-accent text-accent-foreground')}>You + Students</span>
  ) : (
    <span className={cn(base, 'bg-secondary text-secondary-foreground')}>Draft — you only</span>
  )
}

function ManageFeaturesPopover({ sectionId, features, enabledFeatures, sidebarHidden, collapsed }: {
  sectionId: string
  features: CourseFeature[]
  enabledFeatures: string[]
  sidebarHidden: string[]
  collapsed?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [, startTransition] = useTransition()
  /* Which single row is mid-flight. Drives a per-row dim — the rows are never
     `disabled`, because disabling the clicked one blurs it to <body> and Radix
     closes the popover (#13). */
  const [togglingKey, setTogglingKey] = useState<string | null>(null)
  const professorTools = features.filter((f) => f.category === 'professor')
  const studentFacing = features.filter((f) => f.category === 'additional' && !f.studentOnly)
  const studentOnly = features.filter((f) => f.category === 'additional' && f.studentOnly)

  /* Rows render from server props, so a tick used to appear only after
     revalidatePath + the router refresh landed — measured 1–5s behind its own
     success toast, long enough to read as "my click did nothing".
     Both sources are optimistic because the rows read from BOTH: a professor-only
     row's checkbox tracks sidebarHidden, everything else tracks enabledFeatures.
     The reducer mirrors handleToggle's three-way branch exactly; if they ever
     drift, the checkbox will lie for one round-trip. */
  const [optimistic, applyToggle] = useOptimistic(
    { published: enabledFeatures, hidden: sidebarHidden },
    (
      cur: { published: string[]; hidden: string[] },
      { feature, checked }: { feature: CourseFeature; checked: boolean },
    ) => {
      const drop = (arr: string[]) => arr.filter((k) => k !== feature.key)
      switch (classifyFeatureToggle(feature, cur.hidden)) {
        // professor-only: the checkbox IS sidebar presence
        case 'sidebar':
          return { ...cur, hidden: checked ? drop(cur.hidden) : [...cur.hidden, feature.key] }
        // restoring a hidden row returns it to draft WITHOUT publishing
        case 'restore':
          return { ...cur, hidden: drop(cur.hidden) }
        case 'publish':
          return { ...cur, published: checked ? [...cur.published, feature.key] : drop(cur.published) }
      }
    },
  )

  /* Three different meanings, by row:
     - professor-only tools have no student side, so the checkbox is "keep it in
       my sidebar"
     - a HIDDEN row restores to draft (back in my sidebar, still not published).
       Restoring must not publish: one click would otherwise put a feature the
       professor deliberately removed straight in front of students.
     - everything else publishes/unpublishes to students */
  const handleToggle = (feature: CourseFeature, checked: boolean) => {
    /* Read the branch off the OPTIMISTIC set, not the prop. Restore-then-publish
       is two quick clicks on the same row; against the stale prop the second one
       would restore again instead of publishing. */
    const kind = classifyFeatureToggle(feature, optimistic.hidden)
    const restoringHidden = kind === 'restore'
    setTogglingKey(feature.key)
    startTransition(async () => {
      applyToggle({ feature, checked })
      const result =
        kind === 'sidebar'
          ? await setCourseSidebarVisibility(sectionId, feature.key, checked)
          : kind === 'restore'
            ? await setCourseSidebarVisibility(sectionId, feature.key, true)
            : await toggleCourseFeature(sectionId, feature.key, checked)
      setTogglingKey(null)

      if (result.error) {
        toast.error(result.error)
        return
      }
      /* Always confirm. Restoring a hidden feature only flips a 9px badge and
         leaves the checkbox unchecked, so without this it reads as "nothing
         happened" — and the obvious next move, clicking again, publishes it to
         students. Say what changed instead. */
      if (restoringHidden) {
        toast.success(`${feature.label} is back in your sidebar`, {
          description: "Students still can't see it — publish when you're ready.",
        })
      } else if (kind === 'sidebar') {
        toast.success(checked ? `${feature.label} added to your sidebar` : `${feature.label} hidden`)
      } else if (checked) {
        toast.success(`${feature.label} is now visible to students`)
      } else {
        toast.success(`${feature.label} hidden from students`, {
          description: 'Still in your sidebar, so you can keep working on it.',
        })
      }
    })
  }

  const renderFeatureRow = (feature: CourseFeature) => {
    const Icon = feature.icon
    const isHidden = optimistic.hidden.includes(feature.key)
    const isPublished = optimistic.published.includes(feature.key)
    // Professor tools track sidebar presence; everything else tracks publishing.
    const isEnabled = feature.professorOnly ? !isHidden : isPublished
    const isToggling = togglingKey === feature.key

    return (
      <button
        key={feature.key}
        // The on/off state reaches the a11y tree ONLY through this — the checkbox is
        // a styled div and its tick is aria-hidden, so without it a screen reader
        // announces the row identically whether the feature is on or off.
        aria-pressed={isEnabled}
        onClick={() => handleToggle(feature, !isEnabled)}
        /* Deliberately NOT `disabled` while the toggle is in flight: disabling the
           row the professor just clicked blurs it to <body>, which Radix reads as
           focus leaving the popover and closes the whole panel — that was the
           "have to re-open it for every feature" bug (#13). The per-row `isToggling`
           dim below is the busy affordance instead; it doesn't touch focus. */
        className={cn(
          'flex items-center gap-3 w-full px-2 py-2 text-left rounded-md transition-colors',
          isEnabled ? 'bg-accent/50' : 'hover:bg-accent',
          isToggling && 'opacity-50',
        )}
      >
        {/* Checkbox */}
        <div className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
          isEnabled
            ? 'bg-primary border-primary'
            : 'border-muted-foreground/40',
        )}>
          {isEnabled && (
            <svg className="h-3 w-3 text-primary-foreground" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>

        {/* Icon */}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        </div>

        {/* Label + badge */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium leading-tight">{feature.label}</p>
            <VisibilityBadge feature={feature} isPublished={isPublished} isHidden={isHidden} />
          </div>
          <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">{feature.description}</p>
        </div>
      </button>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {collapsed ? (
          <button
            className="flex items-center justify-center p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors w-full"
            aria-label="Manage Features"
          >
            {/* Same icon as the expanded state — one control shouldn't change
                identity when the rail collapses. */}
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : (
          <button className="flex items-center gap-2 px-2.5 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full rounded-md hover:bg-background/50">
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            Manage Features
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="p-0 w-80">
        {/* Header */}
        <div className="px-3 pt-2.5 pb-1.5 border-b border-border bg-muted/30">
          <p className="text-xs font-semibold">Manage Features</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Everything is in your sidebar already. Check a feature to release it to students.
          </p>
        </div>

        {/* Scrollable feature list */}
        <div className="max-h-80 overflow-y-auto p-2">
          {/* Professor Tools */}
          {professorTools.length > 0 && (
            <>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-2 py-1">
                Professor Tools · in your sidebar
              </p>
              <div className="space-y-0.5">
                {professorTools.map(renderFeatureRow)}
              </div>
            </>
          )}

          {/* Shared features (professor + students) */}
          {studentFacing.length > 0 && (
            <>
              {professorTools.length > 0 && <div className="my-1.5 border-t border-border" />}
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-2 py-1">
                Course Features · visible to students
              </p>
              <div className="space-y-0.5">
                {studentFacing.map(renderFeatureRow)}
              </div>
            </>
          )}

          {/* Student-only features */}
          {studentOnly.length > 0 && (
            <>
              <div className="my-1.5 border-t border-border" />
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-2 py-1">
                Student Extras · visible to students
              </p>
              <div className="space-y-0.5">
                {studentOnly.map(renderFeatureRow)}
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Removes a feature from the professor's sidebar (and unpublishes it, so
 *  students aren't left with a feature the professor can no longer reach).
 *  Restored from the Manage Features popover. */
function RemoveFeatureButton({ sectionId, featureKey, label }: {
  sectionId: string
  featureKey: string
  label: string
}) {
  const [isPending, startTransition] = useTransition()

  const handleRemove = () => {
    startTransition(async () => {
      const result = await setCourseSidebarVisibility(sectionId, featureKey, false)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success(`${label} removed`, {
        description: 'Hidden from your sidebar and from students. Bring it back from Manage Features.',
      })
    })
  }

  return (
    <button
      onClick={handleRemove}
      disabled={isPending}
      className="absolute right-1 opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
      /* Copy must admit the full effect: this also unpublishes. Saying "from
         your sidebar" alone would understate it for a published feature. */
      title={`Remove ${label} — hides it from your sidebar and from students`}
      aria-label={`Remove ${label} — hides it from your sidebar and from students`}
    >
      <X className="h-3 w-3" aria-hidden="true" />
    </button>
  )
}
