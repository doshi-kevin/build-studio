/**
 * Professor Courses Page — card grid showing all courses assigned to the professor.
 *
 * Active/draft courses in the main grid, archived in a collapsible section below.
 *
 * Type: Server Component (fetches data server-side)
 * Route: /professor/courses
 */

import Link from 'next/link'
import { BookOpen, Users, MapPin, Archive, ChevronDown, ArrowRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { courseQueries, profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/empty-state'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { SEMESTER_LABELS, type Semester } from '@/lib/validations/course-assignment'

const MODALITY_LABELS: Record<string, string> = {
  in_person: 'In Person',
  online: 'Online',
  hybrid: 'Hybrid',
}

const STATUS_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  active:   { dot: 'bg-success', text: 'text-foreground', label: 'Active' },
  draft:    { dot: 'bg-warning',     text: 'text-muted-foreground', label: 'Draft' },
  inactive: { dot: 'bg-muted-foreground/40',                 text: 'text-muted-foreground', label: 'Inactive' },
  archived: { dot: 'bg-muted-foreground/30',                 text: 'text-muted-foreground', label: 'Archived' },
}

export default async function ProfessorCoursesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const profile = await profileQueries.getProfileById(adminDb, user.id)
  const professorName = profile?.name || profile?.first_name || 'Professor'

  const sections = await courseQueries.getProfessorSectionsExtended(adminDb, user.id)

  logger.info('ProfessorCoursesPage: Loaded', {
    professorId: user.id,
    sections: sections.length,
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

  const activeSections = sections.filter((s) => s.status !== 'archived')
  const archivedSections = sections.filter((s) => s.status === 'archived')
  // "active" in the summary sentence must mean status='active' — the same count
  // the dashboard's "My Courses" chip reports — even though the grid above it
  // deliberately also shows drafts.
  const activeCount = sections.filter((s) => s.status === 'active').length

  const renderCard = (section: (typeof sections)[0], dimmed = false) => {
    const course = resolveJoin(section.course)
    const enrollmentCount = section.enrollments?.length || 0
    const semesterLabel = SEMESTER_LABELS[section.semester as Semester] || section.semester
    const statusStyle = STATUS_STYLES[section.status || 'active'] || STATUS_STYLES.active

    return (
      <Link
        key={section.id}
        href={`/professor/courses/${section.id}`}
        className={cn('group block', dimmed && 'opacity-60')}
      >
        <div className="h-full rounded-2xl border border-border bg-card p-5 transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm hover:-translate-y-0.5">
          {/* Course code + title */}
          <div className="mb-3">
            <p className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">
              {course?.code}
            </p>
            <h3 className="text-sm font-semibold leading-snug line-clamp-2">
              {course?.title || 'Untitled Course'}
            </h3>
          </div>

          {/* Section + semester */}
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span className="text-[10px] font-mono font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded">
              {section.section_code}
            </span>
            <span className="text-xs text-muted-foreground capitalize">
              {semesterLabel} {section.year}
            </span>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between pt-3 border-t border-border/40">
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3" />
                {enrollmentCount}{section.max_students ? `/${section.max_students}` : ''}
              </span>
              {section.modality && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {MODALITY_LABELS[section.modality] || section.modality}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className={cn('inline-flex items-center gap-1 text-[11px] font-medium', statusStyle.text)}>
                <div className={cn('h-1.5 w-1.5 rounded-full', statusStyle.dot)} />
                {statusStyle.label}
              </div>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground group-hover:translate-x-0.5 transition-[color,transform]" />
            </div>
          </div>
        </div>
      </Link>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">Teaching</p>
          <h1 className="text-2xl font-semibold tracking-tight">My Courses</h1>
          <p className="text-[15px] text-muted-foreground mt-2">
            Welcome back, {professorName}. You have {activeCount} active {activeCount === 1 ? 'course' : 'courses'}.
          </p>
        </div>
      </div>

      {activeSections.length === 0 && archivedSections.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No courses assigned"
          description="You don't have any courses assigned yet. Contact your department administrator to get started."
        />
      ) : (
        <>
          {activeSections.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No active courses"
              description="All your courses are archived. Check the archived section below."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {activeSections.map((section) => renderCard(section))}
            </div>
          )}

          {archivedSections.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors py-2">
                <Archive className="h-4 w-4" />
                Archived Courses ({archivedSections.length})
                <ChevronDown className="h-3.5 w-3.5" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-3">
                  {archivedSections.map((section) => renderCard(section, true))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}
    </div>
  )
}
