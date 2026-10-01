/**
 * Dashboard Page — the main landing page after login, showing role-specific metrics.
 *
 * Displays different metric cards based on the user's role:
 * - institution_admin: redirected to /admin, which has its own dashboard
 * - professor: my courses, to-dos, students + a triage panel (to-do list,
 *   grading queue, quick actions, teaching calendar)
 * - student:  enrolled courses, to-dos, average grade + their own triage panel
 *
 * Professor and student both render the same shape — a to-do list beside a
 * resizable rail — but from different engines: `professor-todos.ts` aggregates
 * course signals one row per (course × kind), while `todos.ts` turns the
 * student's event feed into per-assessment rows.
 *
 * Data flow:
 * 1. Validates the user's auth session (JWT check via Supabase)
 * 2. Fetches the user's profile (or auto-creates it if missing)
 * 3. Fetches that role's data ONCE here, so the metric chips, the course cards
 *    and the to-do list below can never show disagreeing numbers
 *
 * If the profile doesn't exist (trigger may not have fired after signup),
 * shows a "Setting up your account..." message instead.
 *
 * Type: Server Component (async, fetches data server-side)
 */

import { redirect } from 'next/navigation'
import { resolveAllEntitlements, resolveAllEntitlementsBySection } from '@/lib/entitlements/check'
import { ENTITLED_FEATURE_KEYS, evaluateEntitlement } from '@/lib/entitlements/entitled-features'
import Link from 'next/link'
import {
  BookOpen,
  ListTodo,
  TrendingUp,
  Users,
  Building2,
  GraduationCap,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dashboardQueries, profileQueries, courseQueries, studentCatalogQueries, sectionStaffQueries, professorDashboardQueries, skillQueries } from '@/lib/supabase/queries'
import { listFeed } from '@/lib/events/feed-actions'
import { buildTodoList, countOpenTodosBySection, countWeeklyDeliverableCompletion, type ProjectDeliverableInput } from '@/lib/dashboard/todos'
import {
  buildProfessorTodoList,
  countProfessorTodosBySection,
  buildGradingQueue,
  type GradingQueueEntry,
  type ProfessorTodoItem,
} from '@/lib/dashboard/professor-todos'
import { addDays } from 'date-fns'
import { getStudentCalendarEvents } from '@/lib/calendar/student-events'
import { getProfessorCalendarEvents } from '@/lib/calendar/professor-events'
import { getWeekDays } from '@/lib/calendar/utils'
import { MiniCalendar } from '@/components/student/dashboard/MiniCalendar'
import { FocusAreas } from '@/components/student/dashboard/FocusAreas'
import { WeeklyCompletion } from '@/components/student/dashboard/WeeklyCompletion'
import { GradingQueueCard } from '@/components/professor/dashboard/GradingQueueCard'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { logger } from '@/lib/logger'
import { RecentAnnouncements } from '@/components/student/dashboard/RecentAnnouncements'
import { QuickActionsPanel } from '@/components/professor/dashboard/QuickActionsPanel'
import { TodoList } from '@/components/shared/TodoList'
import { DashboardGreeting } from '@/components/shared/DashboardGreeting'
import { EmptyState } from '@/components/ui/empty-state'
import type { CourseSection } from '@/lib/quick-actions/types'

// ── Card configuration with icons + accent colours ─────────────────────────

type CardMeta = {
  title: string
  key: string
  icon: React.ComponentType<{ className?: string }>
}

const cardConfig: Record<string, CardMeta[]> = {
  institution_admin: [
    { title: 'Departments', key: 'departments', icon: Building2 },
    { title: 'Professors', key: 'professors', icon: GraduationCap },
    { title: 'Students', key: 'students', icon: Users },
  ],
  professor: [
    { title: 'My Courses', key: 'myCourses', icon: BookOpen },
    { title: 'To-Dos', key: 'todos', icon: ListTodo },
    { title: 'Students', key: 'totalStudents', icon: Users },
  ],
  student: [
    { title: 'Enrolled Courses', key: 'enrolledCourses', icon: BookOpen },
    { title: 'To-Dos', key: 'todos', icon: ListTodo },
    { title: 'Average Grade', key: 'averageGrade', icon: TrendingUp },
  ],
  course_assistant: [
    { title: 'Assigned Sections', key: 'assignedSections', icon: BookOpen },
  ],
}

/** Supabase returns a single relation as an object OR a one-element array. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

// ── Page ───────────────────────────────────────────────────────────────────

/**
 * Products this institution no longer has. Small wrapper so the two to-do call
 * sites on this page cannot drift apart on which list they filter by. Takes the
 * tenant directly rather than a section, which is one database read instead of
 * two and leaves nothing to infer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveUnentitled(adminDb: any, institutionId: string): Promise<string[]> {
  const config = await resolveAllEntitlements(adminDb, institutionId)
  const at = new Date()
  return ENTITLED_FEATURE_KEYS.filter((key) => !evaluateEntitlement(config, key, at).entitled)
}

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError) {
    logger.error('DashboardPage: Auth check failed', authError)
  }

  if (!user) {
    logger.warn('DashboardPage: No user session, rendering null', { authError: authError?.message ?? null })
    return null
  }

  logger.debug('DashboardPage: Loading', { userId: user.id, email: user.email })
  const profile = await profileQueries.getProfileById(supabase, user.id)

  if (!profile) {
    logger.warn('DashboardPage: Profile not found, showing setup message', { userId: user.id })
    return (
      <div className="space-y-2 py-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Setting up your account…</h1>
        <p className="text-sm text-muted-foreground">
          Your profile is being created. Please refresh the page in a moment.
        </p>
      </div>
    )
  }

  // Admins go straight to /admin which has its own dashboard
  if (profile.role === 'institution_admin') {
    redirect('/admin')
  }

  // Super admins live at /super-admin (platform-vendor tier)
  if (profile.role === 'super_admin') {
    redirect('/super-admin')
  }

  // Fetch role-specific data
  logger.info('DashboardPage: Fetching role-specific data', { userId: user.id, role: profile.role })
  let dashboardData: Record<string, number | null> = {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  // Student to-do sources fetched once here so the "To-Dos" metric card and the
  // to-do list below it are always the same number (both built from these).
  let studentTodo: {
    feedResult: Awaited<ReturnType<typeof listFeed>>
    deliverables: ProjectDeliverableInput[]
  } | null = null

  // Professor to-do sources fetched once here so the "To-Dos" metric card, the
  // course cards and the list below all agree (same pattern as the student path).
  let professorTodo: {
    sections: CourseSection[]
    items: ProfessorTodoItem[]
    grading: GradingQueueEntry[]
    loadFailed: boolean
  } | null = null

  if (profile.role === 'professor') {
    const rawSections = await courseQueries.getProfessorSections(adminDb, user.id)
    const sections: CourseSection[] = (rawSections || []).map((s) => {
      const course = resolveJoin(s.course)
      return {
        id: s.id,
        section_code: s.section_code,
        course: course ? { id: course.id, code: course.code, title: course.title } : null,
      }
    })
    const courseCodeBySection: Record<string, string> = {}
    for (const s of sections) {
      if (s.course?.code) courseCodeBySection[s.id] = s.course.code
    }

    const raw = await professorDashboardQueries.getProfessorTodoSources(adminDb, user.id)
    const sources = { ...raw, courseCodeBySection }
    const items = buildProfessorTodoList(sources)

    // Enrolment headcount already came back with the to-do sources — no need for
    // a second round of counting queries just to fill the metric chips.
    const totalStudents = Object.values(raw.enrolledBySection).reduce((a, b) => a + b, 0)
    // On a failed load the counts are unknown, not zero — null renders as "—".
    dashboardData = raw.failed
      ? { myCourses: sections.length, totalStudents: null, todos: null }
      : { myCourses: sections.length, totalStudents, todos: items.length }
    professorTodo = {
      sections,
      items,
      grading: buildGradingQueue(sources),
      loadFailed: raw.failed,
    }
  } else if (profile.role === 'student') {
    const [counts, feedResult, deliverables] = await Promise.all([
      dashboardQueries.getStudentCounts(adminDb, user.id),
      listFeed({ actionableOnly: true, undoneOnly: true }),
      dashboardQueries.getStudentProjectDeliverables(adminDb, user.id),
    ])
    const feedItems = feedResult.success && feedResult.data ? feedResult.data.items : []
    // Everything open: assignments + quizzes (feed) + project deliverables.
    /* Counted with the same filter the list uses, and from the same source, or
       the chip and the list disagree about how much work a student has. */
    const chipUnentitled = profile.institution_id
      ? await resolveUnentitled(adminDb, profile.institution_id)
      : []
    dashboardData = {
      ...counts,
      todos: buildTodoList(feedItems, undefined, deliverables, chipUnentitled).length,
    }
    studentTodo = { feedResult, deliverables }
  } else if (profile.role === 'course_assistant') {
    const assignments = await sectionStaffQueries.listActiveForStaff(adminDb, user.id)
    dashboardData = { assignedSections: assignments.length }
  }

  logger.debug('DashboardPage: Data loaded', { userId: user.id, role: profile.role, metrics: dashboardData })

  const cards = cardConfig[profile.role] || cardConfig.student
  const firstName = (profile.name || profile.email || 'there').split(' ')[0]

  // Both triage dashboards fill the viewport so their panels can flex to the
  // remaining space and the page itself never scrolls.
  const fillsViewport = profile.role === 'student' || profile.role === 'professor'

  const chipHref = (key: string) => {
    if (key === 'enrolledCourses') return '/student/courses'
    if (key === 'myCourses') return '/professor/courses'
    return undefined
  }

  return (
    <div className={cn('flex flex-col gap-4', fillsViewport && 'h-full min-h-0')}>

      {/* ── Greeting + compact metric row ─────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shrink-0">
        <DashboardGreeting firstName={firstName} />

        {/* Same row, same class, same defect as the admin dashboard's (#717 part 1): it overflows
            its container at 390px inside an `overflow-x-hidden` ancestor, so the last counts are
            unreachable by any gesture. Measured on the admin twin; fixed here too rather than
            leaving a known-identical clip on the surface students land on. Part of #547. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:shrink-0">
          {cards.map((card, i) => (
            <div key={card.key} className="flex items-center gap-5">
              <DashboardCard
                title={card.title}
                count={dashboardData[card.key] ?? null}
                icon={card.icon}
                href={chipHref(card.key)}
              />
              {i < cards.length - 1 && <div className="h-8 w-px bg-border" />}
            </div>
          ))}
        </div>
      </div>

      {/* ── Professor extras ──────────────────────────────────────── */}
      {profile.role === 'professor' && professorTodo && (
        <ProfessorDashboardExtras
          userId={user.id}
          sections={professorTodo.sections}
          items={professorTodo.items}
          grading={professorTodo.grading}
          loadFailed={professorTodo.loadFailed}
        />
      )}

      {/* ── Student extras ────────────────────────────────────────── */}
      {profile.role === 'student' && studentTodo && (
        <StudentDashboardExtras
          userId={user.id}
          institutionId={profile.institution_id ?? null}
          feedResult={studentTodo.feedResult}
          deliverables={studentTodo.deliverables}
        />
      )}

      {/* ── Course assistant extras (TAs + Graders) ───────────────── */}
      {profile.role === 'course_assistant' && (
        <StaffDashboardExtras userId={user.id} />
      )}
    </div>
  )
}

// ── Staff extras: assigned sections ────────────────────────────────────────

async function StaffDashboardExtras({ userId }: { userId: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const assignments = await sectionStaffQueries.listActiveForStaff(adminDb, userId)

  if (assignments.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-background p-12 text-center">
        <h3 className="font-[family-name:var(--font-instrument-serif)] text-xl">No active assignments</h3>
        <p className="text-sm text-muted-foreground mt-1.5">
          A professor will need to request you for a section, and your institution admin will need to approve. You&apos;ll receive an email when that happens.
        </p>
      </div>
    )
  }

  return (
    <section className="space-y-4">
      <h2 className="font-[family-name:var(--font-instrument-serif)] text-[22px] tracking-tight">My Sections</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        {assignments.map((a: any) => {
          const section = resolveJoin(a.section)
          const course = resolveJoin(section?.course)
          const professor = resolveJoin(section?.professor)
          const roleLabel = a.role === 'ta' ? 'Teaching Assistant' : 'Grader'
          return (
            <Link
              key={a.id}
              href={`/professor/courses/${section?.id}/announcements`}
              className="group rounded-2xl border border-border bg-background p-5 hover:-translate-y-0.5 transition-transform"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-muted-foreground">{course?.code}</span>
                <span className="text-[10px] uppercase tracking-wider font-semibold rounded-full px-2 py-0.5 border border-foreground/30 bg-foreground/5">
                  {roleLabel}
                </span>
              </div>
              <h3 className="font-semibold text-sm mt-2 line-clamp-2">{course?.title}</h3>
              <p className="text-xs text-muted-foreground mt-1">Prof. {professor?.name || '—'}</p>
              <p className="text-[11px] text-muted-foreground mt-2">
                Through {new Date(a.ends_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </p>
            </Link>
          )
        })}
      </div>
    </section>
  )
}

// ── Professor extras: to-dos + quick actions (two-column layout) ────────

async function ProfessorDashboardExtras({
  userId,
  sections,
  items,
  grading,
  loadFailed,
}: {
  userId: string
  // Computed by the parent so the metric chips, the course cards and the list
  // are all built from one fetch and can never disagree.
  sections: CourseSection[]
  items: ProfessorTodoItem[]
  grading: GradingQueueEntry[]
  /** The to-do fetch failed — must render an error, never "all caught up". */
  loadFailed: boolean
}) {
  // Every panel below is data-driven from the professor's own sections. With
  // none assigned, "you're all caught up" would be a success message for
  // someone who hasn't started, and the six quick actions would sit fully
  // enabled but reject every click — so replace the whole triage view with one
  // clear state instead of letting each panel independently claim "empty".
  if (sections.length === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No courses assigned yet"
        description="Your admin assigns you course sections — once you have one, your grading queue, deadlines, and class reports will appear here."
      />
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const calendarResult = await getProfessorCalendarEvents(adminDb, userId)

  const todosBySection = countProfessorTodosBySection(items)

  /* All of a professor's sections belong to one institution, and the empty
     case returned above, so one section is enough to resolve the plan.
     Quick actions link straight into a feature, so an action for a product the
     school does not have would hand the professor a button that dead-ends. The
     professor belongs to one institution, so this resolves once for the page. */
  const dashEntitlements = await resolveAllEntitlementsBySection(
    createAdminClient(),
    sections[0].id,
  )
  const dashNow = new Date()
  const unentitledForDash = ENTITLED_FEATURE_KEYS.filter(
    (key) => !evaluateEntitlement(dashEntitlements, key, dashNow).entitled,
  ) as string[]

  const quickActions = (
    <section className="flex flex-col h-full min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <Zap className="h-4 w-4 text-muted-foreground shrink-0" />
        <h2 className="truncate text-base font-semibold tracking-tight text-foreground">Quick actions</h2>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
        <QuickActionsPanel sections={sections} unentitledFeatures={unentitledForDash} />
      </div>
    </section>
  )

  const todoPanel = (
    <TodoList items={items} enableCollapse loadError={loadFailed} />
  )

  const gradingCard = <GradingQueueCard entries={grading} loadError={loadFailed} />

  const calendar = (
    <MiniCalendar
      events={calendarResult.events}
      loadError={calendarResult.error}
      fullCalendarHref="/professor/calendar"
      monthMaxChips={1}
    />
  )

  return (
    <div className="flex flex-1 flex-col gap-4 min-h-0">

      {/* My Courses — compact card per section, with its open to-do count */}
      {sections.length > 0 && (
        <section className="shrink-0 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {sections.slice(0, 6).map((section) => (
            <ProfessorCourseCard
              key={section.id}
              sectionId={section.id}
              code={section.course?.code ?? section.section_code}
              title={section.course?.title ?? 'Untitled Course'}
              todoCount={todosBySection.get(section.id) ?? 0}
            />
          ))}
        </section>
      )}

      {/* Narrow (<xl): stack the panels in one column. Forked from the student
          stack on purpose — the rail widgets differ, and reusing that block
          would render a completion ring the professor has no data for.
          Breaks at xl, not lg like the student dashboard below, because the
          professor rail carries FOUR panels where the student's carries two.
          Measured at 1024px: Quick actions collapses to ~110px (every label
          clipped) and the mini calendar's day columns to ~33px, leaving ~8px of
          text per event chip — an unreadable sliver. The grading card itself
          survives that width, so it is NOT the binding constraint; those two
          are. Full width in one column says more at that size. */}
      <div className="flex flex-col gap-4 xl:hidden">
        <section className="h-96 rounded-2xl border border-border bg-card flex flex-col overflow-hidden min-h-0">
          {todoPanel}
        </section>
        {/* Matches the to-do panel's height, not the student rail's h-64: this
            card is a scrolling list now, and 64 showed barely three rows. */}
        <div className="h-96">{gradingCard}</div>
        <div className="h-80">{quickActions}</div>
        <div className="h-96">{calendar}</div>
      </div>

      {/* Desktop (xl+): resizable panels, sizes persist per-browser. */}
      <div className="hidden xl:block flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" autoSaveId="professor-dashboard-main">
          <ResizablePanel id="todo" order={1} defaultSize={60} minSize={35} maxSize={62}>
            <section className="h-full mr-3 rounded-2xl border border-border bg-card flex flex-col overflow-hidden min-h-0">
              {todoPanel}
            </section>
          </ResizablePanel>

          <ResizableHandle withHandle aria-label="Resize to-do list and sidebar" />

          <ResizablePanel id="rail" order={2} defaultSize={40} minSize={30}>
            <div className="h-full min-w-0 pl-3">
              <ResizablePanelGroup direction="vertical" autoSaveId="professor-dashboard-rail">
                <ResizablePanel id="top" order={1} defaultSize={36} minSize={26}>
                  <div className="h-full min-h-0 pb-2">
                    {/* Grading leads this row now that it's a list rather than a
                        single number — at the old 42/58 split it got ~190px, too
                        narrow to read an assignment title beside its age. The
                        autoSaveId is versioned because these sizes persist to
                        localStorage: without the bump, everyone who has already
                        loaded the dashboard keeps the old split and never sees
                        the wider card. */}
                    <ResizablePanelGroup direction="horizontal" autoSaveId="professor-dashboard-toprow-v2">
                      <ResizablePanel id="grading" order={1} defaultSize={55} minSize={26}>
                        <div className="h-full min-h-0 min-w-0 pr-1.5">{gradingCard}</div>
                      </ResizablePanel>

                      <ResizableHandle withHandle aria-label="Resize grading queue and quick actions" />

                      <ResizablePanel id="actions" order={2} defaultSize={45} minSize={30}>
                        <div className="h-full min-h-0 min-w-0 pl-1.5">{quickActions}</div>
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  </div>
                </ResizablePanel>

                <ResizableHandle withHandle aria-label="Resize top row and calendar" />

                <ResizablePanel id="thisweek" order={2} defaultSize={56} minSize={20} maxSize={70}>
                  <div className="h-full min-h-0 overflow-y-auto pt-2">{calendar}</div>
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  )
}

// ── Compact course card (professor "My Courses" row) ────────────────────────

function ProfessorCourseCard({
  sectionId,
  code,
  title,
  todoCount,
}: {
  sectionId: string
  code: string
  title: string
  todoCount: number
}) {
  return (
    <Link
      href={`/professor/courses/${sectionId}`}
      className="group rounded-xl border border-border bg-card px-3 py-2 transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm"
    >
      <p className="text-sm font-medium leading-snug truncate">{title}</p>
      <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="font-mono">{code}</span>
        {todoCount > 0 && (
          <>
            {/* Neutral emphasis — having work to do is the normal state, not an error. */}
            <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
            <span className="truncate">{todoCount} need{todoCount === 1 ? 's' : ''} you</span>
          </>
        )}
      </p>
    </Link>
  )
}

// ── Student extras: My Courses band + "Up next" to-do list + right rail ──────

async function StudentDashboardExtras({
  userId,
  institutionId,
  feedResult,
  deliverables,
}: {
  userId: string
  /** The viewer's tenant, straight from their profile. A student belongs to
   *  exactly one, so this is unambiguous where picking a section was not. */
  institutionId: string | null
  // Fetched by the parent so the "To-Dos" card and this list share one source.
  feedResult: Awaited<ReturnType<typeof listFeed>>
  deliverables: ProjectDeliverableInput[]
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  // Current Mon–Sun week, for the weekly completion tracker.
  const weekDays = getWeekDays(new Date())
  const weekStartISO = weekDays[0].toISOString()
  const weekEndISO = addDays(weekDays[0], 7).toISOString() // exclusive

  const [recentAnnouncements, unreadAnnouncementCount, enrollments, calendarResult, weeklyCompletion, focus] = await Promise.all([
    studentCatalogQueries.getRecentImportantAnnouncements(adminDb, userId, 5),
    studentCatalogQueries.getUnreadAnnouncementCount(adminDb, userId),
    courseQueries.getStudentEnrollments(adminDb, userId),
    getStudentCalendarEvents(adminDb, userId),
    dashboardQueries.getWeeklyCompletion(adminDb, userId, weekStartISO, weekEndISO),
    /* Admin client on purpose: `skills` has no student RLS policy, so under the anon
       client the name join comes back null with no error and every row loses its label. */
    skillQueries.getStudentFocusSkills(adminDb, userId),
  ])

  // Announcements: null means the fetch failed (distinct from an empty inbox).
  const announcementsFailed = recentAnnouncements === null

  const feedItems = feedResult.success && feedResult.data ? feedResult.data.items : []
  const feedFailed = !feedResult.success

  /* A to-do for a product the school no longer has cannot be actioned: the route
     behind it dead-ends. The notification itself stays in the bell — history
     survives, the demand does not. Keyed on the viewer's own tenant, so a
     student with no enrollments and an empty feed resolves cleanly to "no
     filtering" instead of depending on finding a section to ask about. */
  const studentUnentitled = institutionId
    ? await resolveUnentitled(adminDb, institutionId)
    : []
  const todoItems = buildTodoList(feedItems, undefined, deliverables, studentUnentitled)

  // Per-course open to-do count, from the same feed + deliverables the list uses.
  const dueBySection = countOpenTodosBySection(feedItems, undefined, deliverables, studentUnentitled)

  // Weekly completion = feed-based assignment/quiz totals + project deliverables
  // due this week (deliverables aren't in the feed, so they're added here).
  const deliverableWeekly = countWeeklyDeliverableCompletion(
    deliverables,
    new Date(weekStartISO).getTime(),
    new Date(weekEndISO).getTime(),
  )
  const weeklyDone = weeklyCompletion.done + deliverableWeekly.done
  const weeklyTotal = weeklyCompletion.total + deliverableWeekly.total

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeEnrollments = (enrollments || []).filter((e: any) => e.status === 'enrolled')

  // section_id → course code, for the to-do list's course-code subtext.
  const courseCodeBySection: Record<string, string> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const e of (enrollments || []) as any[]) {
    const section = resolveJoin(e.section)
    const course = resolveJoin(section?.course)
    if (section?.id && course?.code) courseCodeBySection[section.id] = course.code
  }

  return (
    <div className="flex flex-1 flex-col gap-4 min-h-0">

      {/* My Courses — compact card per enrolled course */}
      {activeEnrollments.length > 0 && (
        <section className="shrink-0 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {activeEnrollments.slice(0, 6).map((enrollment: any) => {
            const section = resolveJoin(enrollment.section)
            const course = resolveJoin(section?.course)
            return (
              <StudentCourseCard
                key={enrollment.id}
                sectionId={section?.id}
                code={course?.code ?? ''}
                title={course?.title ?? 'Untitled Course'}
                dueCount={section?.id ? dueBySection.get(section.id) ?? 0 : 0}
              />
            )
          })}
        </section>
      )}

      {/* Mobile (<lg): stack the to-do list + rail widgets in one column. The rail
          widgets are h-full cards, so each wrapper gets a definite height here;
          ResizablePanelGroup is horizontal-only and can't stack on a phone. */}
      <div className="flex flex-col gap-4 lg:hidden">
        <section className="h-96 rounded-2xl border border-border bg-card flex flex-col overflow-hidden min-h-0">
          <TodoList items={todoItems} courseCodeBySection={courseCodeBySection} enableCollapse loadError={feedFailed} />
        </section>
        <div className="h-64"><WeeklyCompletion done={weeklyDone} total={weeklyTotal} /></div>
        <div className="h-80"><RecentAnnouncements announcements={recentAnnouncements ?? []} unreadCount={unreadAnnouncementCount} loadError={announcementsFailed} /></div>
        <div className="h-96"><MiniCalendar events={calendarResult.events} loadError={calendarResult.error} /></div>
        <div className="h-64"><FocusAreas skills={focus.skills} hasAnyMastery={focus.hasAnyMastery} /></div>
      </div>

      {/* Desktop (lg+): resizable panels (drag the handles to readjust; sizes
          persist per-browser). Fills the height, no page scroll. */}
      <div className="hidden lg:block flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" autoSaveId="student-dashboard-main">
          {/* Main column — "Up next" to-do list. Capped growth (maxSize) so the rail
              — and the weekly-completion card in it — can't be squeezed too narrow. */}
          <ResizablePanel id="todo" order={1} defaultSize={60} minSize={35} maxSize={62}>
            <section className="h-full mr-3 rounded-2xl border border-border bg-card flex flex-col overflow-hidden min-h-0">
              <TodoList items={todoItems} courseCodeBySection={courseCodeBySection} enableCollapse loadError={feedFailed} />
            </section>
          </ResizablePanel>

          <ResizableHandle withHandle aria-label="Resize to-do list and sidebar" />

          {/* Right rail — a top row (weekly completion + announcements side by side)
              over the calendar, which now gets the freed vertical space. The gap from
              the handle is padding on this wrapper (not a margin on the full-width
              group, which would overhang and clip the cards' right corners). */}
          <ResizablePanel id="rail" order={2} defaultSize={40} minSize={30}>
            <div className="h-full min-w-0 pl-3">
            {/* -v4: adding the Focus areas panel changes the saved panel SET, and
                react-resizable-panels resets a layout whose ids no longer match. Bumping
                the id retires the stale saved sizes instead of fighting them. */}
            <ResizablePanelGroup direction="vertical" autoSaveId="student-dashboard-rail-v4">
              {/* Top row — weekly completion (left) + announcements (right), each resizable
                  via the handle between them. minSize keeps the row tall enough that
                  dragging the calendar up can't crowd the completion ring. */}
              <ResizablePanel id="top" order={1} defaultSize={44} minSize={30}>
                <div className="h-full min-h-0 pb-2">
                  <ResizablePanelGroup direction="horizontal" autoSaveId="student-dashboard-toprow">
                    <ResizablePanel id="completion" order={1} defaultSize={42} minSize={26}>
                      <div className="h-full min-h-0 min-w-0 pr-1.5">
                        <WeeklyCompletion done={weeklyDone} total={weeklyTotal} />
                      </div>
                    </ResizablePanel>

                    <ResizableHandle withHandle aria-label="Resize weekly completion and announcements" />

                    <ResizablePanel id="announcements" order={2} defaultSize={58} minSize={30}>
                      <div className="h-full min-h-0 min-w-0 pl-1.5">
                        <RecentAnnouncements announcements={recentAnnouncements ?? []} unreadCount={unreadAnnouncementCount} loadError={announcementsFailed} />
                      </div>
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </div>
              </ResizablePanel>

              <ResizableHandle withHandle aria-label="Resize top row and calendar" />

              <ResizablePanel id="thisweek" order={2} defaultSize={32} minSize={18} maxSize={70}>
                <div className="h-full min-h-0 overflow-y-auto pt-2">
                  <MiniCalendar events={calendarResult.events} loadError={calendarResult.error} />
                </div>
              </ResizablePanel>

              <ResizableHandle withHandle aria-label="Resize calendar and focus areas" />

              {/* 30%, measured rather than guessed. At 20% the list got 27px for 158px of
                  content and NOT ONE row was fully visible; the rows were also restacked to a
                  single line (53px -> 41px) to earn the fit. Header + three 41px rows needs
                  ~164px. 30% left a 1px overflow on the last row — real but only a rounding
                  artifact — so 32% buys slack for a different font size or zoom. minSize stops
                  a drag from reproducing the unusable state. */}
              <ResizablePanel id="focus" order={3} defaultSize={32} minSize={22}>
                <div className="h-full min-h-0 pt-2">
                  <FocusAreas skills={focus.skills} hasAnyMastery={focus.hasAnyMastery} />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  )
}

// ── Compact course card (dashboard "My Courses" row) ────────────────────────
// Slim: course title, with the code + due count as a single subtext line.

function StudentCourseCard({
  sectionId,
  code,
  title,
  dueCount,
}: {
  sectionId?: string
  code: string
  title: string
  dueCount: number
}) {
  const inner = (
    <>
      <p className="text-sm font-medium leading-snug truncate">{title}</p>
      <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="font-mono">{code}</span>
        {dueCount > 0 && (
          <>
            {/* Neutral emphasis — having work due is the normal state, not an error. */}
            <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
            <span className="truncate">{dueCount} due</span>
          </>
        )}
      </p>
    </>
  )
  const base = 'group rounded-xl border border-border bg-card px-3 py-2 transition duration-200 ease-out'

  // Only a real section is a link; without one, render a non-interactive card
  // instead of an href="#" that scrolls to the top and looks broken.
  return sectionId ? (
    <Link href={`/student/courses/${sectionId}`} className={cn(base, 'hover:border-ring/40 hover:shadow-sm')}>
      {inner}
    </Link>
  ) : (
    <div className={base}>{inner}</div>
  )
}

// ── Metric card ────────────────────────────────────────────────────────────

function DashboardCard({
  title,
  count,
  icon: Icon,
  href,
}: {
  title: string
  count: number | null
  icon: React.ComponentType<{ className?: string }>
  href?: string
}) {
  const body = (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-semibold uppercase tracking-[0.1em] group-hover:text-foreground transition-colors">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </span>
      <span className="text-2xl font-semibold tabular-nums tracking-tight text-foreground leading-none">{count == null ? '—' : count}</span>
    </div>
  )

  return href ? (
    <Link href={href} className="group">
      {body}
    </Link>
  ) : (
    body
  )
}
