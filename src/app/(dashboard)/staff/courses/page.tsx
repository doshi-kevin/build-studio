/**
 * Staff "My Sections" — lists every section where this user is an active
 * TA or grader. Each card links directly into the section workspace
 * (shared professor UI tree, starting at announcements).
 */

import Link from 'next/link'
import { BookOpen, CalendarClock, ArrowRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sectionStaffQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { EmptyState } from '@/components/ui/empty-state'
import { STAFF_ROLE_LABELS } from '@/lib/validations/section-staff'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default async function StaffCoursesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const assignments = await sectionStaffQueries.listActiveForStaff(adminDb, user.id)

  logger.info('StaffCoursesPage: Loaded', { userId: user.id, count: assignments.length })

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">
          Assistantships
        </p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">
          My Sections
        </h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          Courses where you are currently a course assistant (TA or grader).
        </p>
      </div>

      {assignments.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No active assignments"
          description="A professor will need to request you for a section and your institution admin will need to approve. You'll get an email when that happens."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {assignments.map((a: any) => {
            const section = resolveJoin(a.section)
            const course = resolveJoin(section?.course)
            const professor = resolveJoin(section?.professor)
            return (
              <Link
                key={a.id}
                href={`/professor/courses/${section?.id}/announcements`}
                className="group block rounded-2xl border border-border bg-background p-5 hover:shadow-md hover:border-border/80 transition-[border-color,box-shadow]"
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-wider">
                    {course?.code}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider font-semibold rounded-full px-2 py-0.5 border border-foreground/30 bg-foreground/5">
                    {STAFF_ROLE_LABELS[a.role as 'ta' | 'grader']}
                  </span>
                </div>
                <h3 className="text-sm font-semibold leading-snug line-clamp-2 mb-1">
                  {course?.title || 'Untitled course'}
                </h3>
                <p className="text-xs text-muted-foreground">
                  Prof. {professor?.name || '—'}
                </p>

                <div className="flex items-center justify-between pt-4 mt-4 border-t border-border/40">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <CalendarClock className="h-3 w-3" />
                    Through {formatDate(a.ends_at)}
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground group-hover:translate-x-0.5 transition-[color,transform]" />
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
