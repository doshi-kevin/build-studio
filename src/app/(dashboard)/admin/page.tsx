/**
 * Admin Dashboard — greeting, metric cards (departments, professors, students),
 * and system-generated action items. This is the landing page for institution_admin users.
 *
 * Type: Server Component
 * Route: /admin
 */

import Link from 'next/link'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { Building2, GraduationCap, Users, UsersRound, ArrowRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dashboardQueries, profileQueries } from '@/lib/supabase/queries'
import { getCurrentInstitutionId } from '@/lib/auth/tenant-context'
import { logger } from '@/lib/logger'
import { TodoList } from '@/components/shared/TodoList'

// ── Helpers ────────────────────────────────────────────────────────────────

function getGreeting(): string {
  const hour = new Date().getUTCHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function AdminDashboardPage() {
  /* Re-check the role HERE, not only in the admin layout. Layout and page segments
     render in PARALLEL and the admin layout denies by RETURNING a <DeadEnd/> rather
     than throwing, so without this guard the page still executed and streamed its
     admin-only data into the response body for any authenticated user of this
     institution. Returning null is correct here and is not the usual page pattern —
     the layout is already rendering the visible no-access dead end around this slot. */
  const auth = await verifyInstitutionAdmin('AdminDashboardPage')
  if ('error' in auth) {
    logger.warn('AdminDashboardPage: denied, skipping fetch', { reason: auth.error })
    return null
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const institutionId = await getCurrentInstitutionId()

  const [profile, dashboardData] = await Promise.all([
    profileQueries.getProfileById(adminDb, user.id),
    dashboardQueries.getInstitutionAdminCounts(adminDb, institutionId ?? undefined),
  ])

  const firstName = (profile?.name || profile?.email || 'Admin').split(' ')[0]

  logger.info('AdminDashboardPage: Loaded', {
    userId: user.id,
    metrics: dashboardData,
  })

  const cards = [
    { title: 'Departments', count: dashboardData.departments, icon: Building2, href: '/admin/departments' },
    { title: 'Professors', count: dashboardData.professors, icon: GraduationCap, href: '/admin/professors' },
    { title: 'Students', count: dashboardData.students, icon: Users, href: '/admin/students' },
    { title: 'Course Assistants', count: dashboardData.staff ?? 0, icon: UsersRound, href: '/admin/staff' },
  ]

  return (
    <div className="space-y-4">
      {/* ── Greeting + Metric cards (single compact row) ──────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-0.5">{formatDate()}</p>
          <h1 className="font-[family-name:var(--font-instrument-serif)] text-[26px] tracking-tight leading-tight">
            {getGreeting()}, <em className="italic text-muted-foreground">{firstName}.</em>
          </h1>
        </div>

        {/* flex-wrap, because this row measured 637px inside a 347px container at 390px and
            nothing could reach the overflow (#717 part 1). The clipping ancestor is
            `main ... overflow-x-hidden`, so the content was not merely off-screen, it was
            unreachable: horizontal wheel, mouse drag and a real touch swipe all left
            scrollLeft at 0. Only keyboard focus() moved it, so a Tab user could reach the
            Course Assistants count and a touch user never could. Wrapping beats a scroller
            here: no hidden content and no gesture to discover. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:shrink-0">
          {cards.map((card, i) => (
            <div key={card.title} className="flex items-center gap-5">
              <Link
                href={card.href}
                className="group flex items-center gap-2 hover:text-foreground transition-colors"
                title={`Go to ${card.title}`}
              >
                <card.icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-[0.1em]">{card.title}</span>
                <span className="font-[family-name:var(--font-instrument-serif)] text-[18px] tracking-tight leading-none">{card.count}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground/30 group-hover:text-muted-foreground group-hover:translate-x-0.5 transition-[color,transform]" />
              </Link>
              {i < cards.length - 1 && <div className="h-4 w-px bg-border" />}
            </div>
          ))}
        </div>
      </div>

      {/* ── To-do's ───────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-card flex flex-col overflow-hidden h-[calc(100vh-180px)] min-h-[400px]">
        {/* Explicitly empty. This panel used to fall back to ten hardcoded to-dos —
            invented complaints, invented faculty, invented registrar work — shown to
            admins as real and tickable. There is no admin to-do source yet, so the
            honest state is "all caught up" until one exists. */}
        <TodoList items={[]} />
      </section>
    </div>
  )
}
