'use client'

// Read-only course navigation sidebar for enrolled students.
// Shows only professor-enabled features in their configured order.
// Hover-to-expand rail: collapsed by default, expands on hover/focus,
// collapses 500ms after the pointer/focus leaves.

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowLeft, LogOut, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { studentSidebarFeatures, type StudioTool } from '@/lib/course-features'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { DropDialog } from '@/components/student/courses/DropDialog'
import { useSidebarRail } from '@/lib/hooks/use-sidebar-rail'

interface StudentCourseSidebarProps {
  sectionId: string
  courseName: string
  courseCode: string
  sectionCode: string
  semester: string
  year: number
  enabledFeatures: string[]
  /** Professor's drag order; may be partial. Unlisted features keep registry order. */
  sidebarOrder?: string[]
  /** Studio plugins shown to students. Display only; the plugin page checks access. */
  studioTools?: StudioTool[]
  unreadAnnouncements?: number
  /** Institution policy: self-unenroll window is open for THIS enrollment.
      Computed server-side in the course layout; the action re-checks it too. */
  canUnenroll?: boolean
}

export function StudentCourseSidebar({
  sectionId,
  courseName,
  courseCode,
  sectionCode,
  semester,
  year,
  enabledFeatures,
  sidebarOrder = [],
  studioTools = [],
  unreadAnnouncements = 0,
  canUnenroll = false,
}: StudentCourseSidebarProps) {
  const pathname = usePathname()
  const basePath = `/student/courses/${sectionId}`
  const [dropDialogOpen, setDropDialogOpen] = useState(false)

  /* Hover/click-to-expand rail; open mode is a persisted per-browser
     preference (see useSidebarRail). In click mode the mouse handlers no-op. */
  const { mode, expanded, docked, animate, collapsed, expand, scheduleCollapse, handleBlurCapture, toggle } = useSidebarRail()

  const sectionForDrop = useMemo(
    () => ({
      id: sectionId,
      section_code: sectionCode,
      semester,
      year,
      course: { code: courseCode, title: courseName },
    }),
    [sectionId, sectionCode, semester, year, courseCode, courseName]
  )

  // Basics, then whatever the professor published, in their display order.
  // Logic lives in course-features.ts so the backwards-compat rule is unit-tested.
  const activeFeatures = useMemo(
    () => studentSidebarFeatures(enabledFeatures, sidebarOrder, studioTools),
    [enabledFeatures, sidebarOrder, studioTools]
  )

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
          className={cn(
            'absolute inset-y-0 left-0 z-30 flex h-full flex-col border-r border-border/50 bg-background overflow-y-auto overflow-x-hidden ',
          animate && 'transition-[width,box-shadow] duration-300 ease-in-out',
            expanded ? 'w-56' : 'w-14',
            expanded && !docked && 'shadow-xl',
            docked && 'shadow-xl md:shadow-none'
          )}
        >
          {/* Explicit open/close toggle — only in click mode (hover mode uses the pointer) */}
          {mode === 'click' && (
            <div className={cn('pt-3', collapsed ? 'px-2 flex justify-center' : 'px-4 flex justify-end')}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggle}
                    className="flex items-center justify-center p-2 rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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

          {/* Back link */}
          <div className={cn('pt-5 pb-3', collapsed ? 'px-2 flex justify-center' : 'px-4')}>
            {collapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    href="/student/courses"
                    className="flex items-center justify-center p-2 rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    aria-label="My Courses"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">My Courses</TooltipContent>
              </Tooltip>
            ) : (
              <Link
                href="/student/courses"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-3 w-3" />
                My Courses
              </Link>
            )}
          </div>

          {/* Course header */}
          {collapsed ? (
            <div className="mx-2 h-px bg-border/50 mb-2" />
          ) : (
            <>
              <div className="px-4 pb-4 mb-1">
                <p className="text-[10px] font-mono font-medium text-muted-foreground/70 tracking-wider uppercase mb-1">
                  {courseCode} · {sectionCode}
                </p>
                <h2 className="text-sm font-semibold leading-snug line-clamp-2">{courseName}</h2>
                <p className="text-[11px] text-muted-foreground mt-0.5 capitalize">
                  {semester} {year}
                </p>
              </div>
              <div className="mx-4 h-px bg-border/50 mb-2" />
            </>
          )}

          {/* Feature nav links */}
          <nav className={cn('py-1 space-y-0.5 flex-1', collapsed ? 'px-2' : 'px-3')}>
            {activeFeatures.map((feature) => {
              const href = `${basePath}${feature.route}`
              const isActive =
                pathname === basePath
                  ? feature.route === '' || feature.route === '/'
                  : pathname.startsWith(href)
              const Icon = feature.icon
              const badgeCount = feature.key === 'announcements' ? unreadAnnouncements : 0

              if (collapsed) {
                return (
                  <Tooltip key={feature.key}>
                    <TooltipTrigger asChild>
                      <Link
                        href={href}
                        className={cn(
                          'relative flex items-center justify-center p-2 rounded-xl transition duration-200 ease-out',
                          isActive
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        )}
                        aria-label={badgeCount > 0 ? `${feature.label}, ${badgeCount} unread` : feature.label}
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        {badgeCount > 0 && (
                          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-info ring-2 ring-background" aria-hidden="true" />
                        )}
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {feature.label}{badgeCount > 0 ? ` · ${badgeCount} unread` : ''}
                    </TooltipContent>
                  </Tooltip>
                )
              }

              return (
                <Link
                  key={feature.key}
                  href={href}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2 text-sm rounded-xl font-medium transition duration-200 ease-out',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="line-clamp-2 flex-1" title={feature.label}>{feature.label}</span>
                  {badgeCount > 0 && (
                    <span
                      className={cn(
                        'ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
                        isActive ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-info text-info-foreground',
                      )}
                    >
                      {badgeCount > 99 ? '99+' : badgeCount}
                    </span>
                  )}
                </Link>
              )
            })}
          </nav>

          {/* Unenroll — only while the institution's self-unenroll window is open */}
          {canUnenroll && (
          <div className={cn('py-4 border-t border-border/50', collapsed ? 'px-2' : 'px-3')}>
            {collapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-full text-muted-foreground hover:text-destructive hover:bg-destructive/8"
                    onClick={() => setDropDialogOpen(true)}
                    aria-label="Unenroll from course"
                  >
                    <LogOut className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Unenroll from course</TooltipContent>
              </Tooltip>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/8"
                onClick={() => setDropDialogOpen(true)}
              >
                <LogOut className="h-3.5 w-3.5 mr-2" />
                Unenroll from course
              </Button>
            )}
          </div>
          )}

          {canUnenroll && (
          <DropDialog
            open={dropDialogOpen}
            onOpenChange={setDropDialogOpen}
            section={sectionForDrop}
            redirectTo="/student/courses"
          />
          )}
        </aside>
      </div>
    </TooltipProvider>
  )
}
