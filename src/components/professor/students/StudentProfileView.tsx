/**
 * StudentProfileView — the page body for /professor/students/[studentId].
 *
 * Three sections in the order a professor asks the questions: who is this, what
 * else are they carrying, and when could we meet. The last one is why the page
 * exists, so it gets the most room.
 *
 * Everything here arrived already filtered by the server. In particular the
 * class list holds a grade ONLY for sections this professor teaches; other
 * courses carry a code, a title and a term and nothing else. There is no
 * "show more" that reveals the rest, because the rest never crossed the wire.
 *
 * Type: Client Component (the availability grid it wraps has a week toggle)
 */
'use client'

import Link from 'next/link'
import { BookOpen, ExternalLink, Github, Hash, Linkedin, Mail, Phone } from 'lucide-react'
import { Breadcrumbs } from '@/components/ui/breadcrumbs'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { AvailabilityGrid } from '@/components/professor/students/AvailabilityGrid'
import type { FreeSlot } from '@/lib/calendar/availability'

interface EnrolledClass {
  sectionId: string
  courseCode: string | null
  courseTitle: string | null
  sectionCode: string | null
  semester: string | null
  year: number | null
  /** True when the viewing professor teaches this section. */
  isMine: boolean
  /** Only ever populated for the professor's own sections. */
  finalGrade: string | null
  finalScore: number | null
}

interface StudentProfileViewProps {
  student: {
    id: string
    name: string
    email: string
    cwid: string | null
    phone: string | null
    status: string
    initials: string
    bio: string
    linkedinUrl: string
    githubUrl: string
  }
  classes: EnrolledClass[]
  availability: {
    days: {
      date: string
      busy: { startMin: number; endMin: number; label: string | null }[]
      free: { startMin: number; endMin: number }[]
    }[]
    suggestions: FreeSlot[]
    hasCalendarData: boolean
    loadError: boolean
  }
}

/** "fall" + 2026 to "Fall 2026". Sections store the season lower-cased. */
function formatTerm(semester: string | null, year: number | null): string | null {
  if (!semester && !year) return null
  const season = semester ? semester.charAt(0).toUpperCase() + semester.slice(1) : ''
  return [season, year].filter(Boolean).join(' ')
}

export function StudentProfileView({ student, classes, availability }: StudentProfileViewProps) {
  const myClasses = classes.filter((c) => c.isMine)
  const otherClasses = classes.filter((c) => !c.isMine)
  const firstName = student.name.split(' ')[0] || student.name

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <Breadcrumbs
        items={[
          { label: 'My Courses', href: '/professor/courses' },
          { label: student.name },
        ]}
      />

      {/* ── Who ─────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-card px-5 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/50 font-mono text-sm font-semibold text-foreground">
              {student.initials}
            </span>
            <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
              {student.name}
            </h1>
          </div>
          <StatusIndicator status={student.status} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <a
            href={`mailto:${student.email}`}
            className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground hover:underline"
          >
            <Mail className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{student.email}</span>
          </a>
          {student.cwid && (
            <span className="inline-flex items-center gap-1.5">
              <Hash className="h-3.5 w-3.5" />
              CWID {student.cwid}
            </span>
          )}
          {student.phone && (
            <span className="inline-flex items-center gap-1.5">
              <Phone className="h-3.5 w-3.5" />
              {student.phone}
            </span>
          )}
        </div>

        {/* What the student chose to say about themselves, from their own
            profile page. Absent for most students, so it renders nothing
            rather than an empty labelled row. */}
        {student.bio && (
          <p className="mt-4 border-t border-border pt-4 text-sm leading-relaxed text-foreground">
            {student.bio}
          </p>
        )}
        {(student.linkedinUrl || student.githubUrl) && (
          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
            {student.linkedinUrl && (
              <a
                href={student.linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline"
              >
                <Linkedin className="h-3.5 w-3.5" />
                LinkedIn
              </a>
            )}
            {student.githubUrl && (
              <a
                href={student.githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline"
              >
                <Github className="h-3.5 w-3.5" />
                GitHub
              </a>
            )}
          </div>
        )}
      </div>

      {/* ── What else they are carrying ─────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Enrolled this term</h2>
          {/* Branch on the TOTAL, not on how many are other people's. Branching
              on otherClasses gave "The only course ..." above a two-row list for
              any student whose whole load happens to be your own sections. */}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {classes.length === 1
              ? `The only course ${firstName} is enrolled in right now.`
              : `${firstName} is taking ${classes.length} courses.`}
          </p>
        </div>

        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {classes.map((entry) => {
            const term = formatTerm(entry.semester, entry.year)
            return (
              <li
                key={entry.sectionId}
                className="flex flex-wrap items-center justify-between gap-2 bg-card px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {entry.courseCode || 'Course'}
                      {entry.sectionCode && (
                        <span className="ml-2 font-normal text-muted-foreground">
                          Section {entry.sectionCode}
                        </span>
                      )}
                      {entry.isMine && (
                        <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                          Yours
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[entry.courseTitle, term].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                </div>

                {/* Grades exist here only for the professor's own sections. */}
                {entry.isMine && (
                  <div className="flex shrink-0 items-center gap-3">
                    {(entry.finalGrade || entry.finalScore != null) && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {entry.finalGrade && (
                          <span className="font-semibold text-foreground">{entry.finalGrade}</span>
                        )}
                        {entry.finalScore != null && <span className="ml-1.5">{entry.finalScore}%</span>}
                      </span>
                    )}
                    <Link
                      href={`/professor/courses/${entry.sectionId}/grades/student/${student.id}`}
                      className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                    >
                      Full analytics
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        {otherClasses.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Course codes only for sections you do not teach. Their work and grades in those
            courses belong to the professor who teaches them.
          </p>
        )}
      </section>

      {/* ── When you could meet ─────────────────────────────────────────── */}
      <section className="space-y-3">
        {/* One step larger than the two sections above it. This is why the page
            exists, and three identical 14px headings gave it no more weight than
            the contact details. */}
        <div>
          <h2 className="text-base font-semibold text-foreground">When you could meet</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Your commitments and {firstName}&apos;s, combined, in Eastern time. Only your own{' '}
            {myClasses.length === 1 ? 'class' : 'classes'} {myClasses.length === 1 ? 'is' : 'are'}{' '}
            named; everything else is time they are not free, without saying why.
          </p>
        </div>

        <AvailabilityGrid
          days={availability.days}
          suggestions={availability.suggestions}
          studentName={student.name}
          studentEmail={student.email}
          hasCalendarData={availability.hasCalendarData}
          loadError={availability.loadError}
        />
      </section>
    </div>
  )
}
