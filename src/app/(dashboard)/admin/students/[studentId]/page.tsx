/**
 * Student Detail Page — admin view for a single student.
 *
 * Server component that fetches a student's profile, enrollment data,
 * and available course sections, then renders:
 * - Breadcrumb navigation
 * - Header card with avatar, name, email, CWID, status, contact, stats row
 * - Tabbed section: Overview, Enrollments (pill-style tabs)
 *
 * Type: Server Component (async, fetches data server-side)
 * Route: /admin/students/[studentId]
 * Tables: profiles, enrollments, course_sections, courses, departments
 */

import { notFound } from 'next/navigation'
import { BookOpen, Mail, Phone, Hash } from 'lucide-react'
import { createAdminClient } from '@/lib/supabase/admin'
import { studentQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { logger } from '@/lib/logger'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Breadcrumbs } from '@/components/ui/breadcrumbs'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { StudentEnrollmentsTable } from '@/components/admin/enrollments/StudentEnrollmentsTable'

interface StudentDetailPageProps {
  params: Promise<{ studentId: string }>
}

export default async function StudentDetailPage({ params }: StudentDetailPageProps) {
  const { studentId } = await params

  const auth = await verifyInstitutionAdmin('StudentDetailPage')
  if ('error' in auth) {
    logger.warn('StudentDetailPage: Unauthorized', { studentId })
    notFound()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  logger.debug('StudentDetailPage: Fetching student', { studentId, institutionId: auth.institutionId })

  /* Fetch student + enrollments and available sections in parallel.
   * Sections filtered by institution_id so the enroll-into dialog only offers
   * the caller's tenant's sections. */
  const [result, { data: allActiveSections }] = await Promise.all([
    studentQueries.getByIdWithDetails(adminDb, studentId),
    adminDb
      .from('course_sections')
      .select('id, section_code, semester, year, course:courses(id, code, title)')
      .eq('status', 'active')
      .eq('institution_id', auth.institutionId)
      .order('year', { ascending: false }),
  ])

  if (!result) {
    logger.warn('StudentDetailPage: Student not found', { studentId })
    notFound()
  }

  const { student, enrollments } = result

  /* Cross-tenant guard. */
  if (student.institution_id !== auth.institutionId) {
    logger.warn('StudentDetailPage: cross-tenant access blocked', {
      studentId,
      studentInstitution: student.institution_id,
      callerInstitution: auth.institutionId,
    })
    notFound()
  }

  logger.info('StudentDetailPage: Loaded', {
    studentId,
    name: student.name,
    enrollments: enrollments.length,
  })

  const studentName = student.name || `${student.first_name || ''} ${student.last_name || ''}`.trim() || student.email

  /** Normalize available sections for the enrollment dialog */
  const availableSections = (allActiveSections || []).map((s: { id: string; section_code: string; semester: string; year: number; course: unknown }) => ({
    id: s.id,
    section_code: s.section_code,
    semester: s.semester,
    year: s.year,
    course: Array.isArray(s.course) ? s.course[0] : s.course,
  }))

  return (
    <div className="space-y-8">
      {/* Breadcrumb navigation */}
      <Breadcrumbs items={[
        { label: 'Admin', href: '/admin' },
        { label: 'Students', href: '/admin/students' },
        { label: studentName },
      ]} />

      {/* Student header card */}
      <Card className="rounded-2xl border-border">
        <CardContent className="pt-6 pb-5 space-y-4">
          {/* Top row: avatar + name + status */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center justify-center rounded-xl border border-border bg-muted/50 h-10 w-10 text-sm font-mono font-semibold text-foreground">
                {(student.first_name?.[0] || student.name?.[0] || '?').toUpperCase()}
                {(student.last_name?.[0] || '').toUpperCase()}
              </span>
              <h1 className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">{studentName}</h1>
            </div>
            <StatusIndicator status={student.status || 'active'} />
          </div>

          {/* Contact details — inline row */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              {student.email}
            </span>
            {student.cwid && (
              <span className="inline-flex items-center gap-1.5">
                <Hash className="h-3.5 w-3.5" />
                CWID: {student.cwid}
              </span>
            )}
            {student.phone && (
              <span className="inline-flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5" />
                {student.phone}
              </span>
            )}
          </div>

          {/* Stats — compact divider-separated row */}
          <div className="flex items-center gap-6 pt-2 border-t border-border">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                <BookOpen className="h-4 w-4 text-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">{enrollments.length}</p>
                <p className="text-xs text-muted-foreground">
                  {enrollments.length === 1 ? 'Enrollment' : 'Enrollments'}
                </p>
              </div>
            </div>
            {student.cwid && (
              <>
                <div className="h-8 w-px bg-border" />
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                    <Hash className="h-4 w-4 text-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold leading-none font-mono">{student.cwid}</p>
                    <p className="text-xs text-muted-foreground">CWID</p>
                  </div>
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Tabbed content — pill-style tabs like Departments */}
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground gap-1">
          <TabsTrigger
            value="overview"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            value="enrollments"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Enrollments
            <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted-foreground/10 px-1.5 text-xs font-medium data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
              {enrollments.length}
            </span>
          </TabsTrigger>
        </TabsList>

        {/* Overview tab — contact info */}
        <TabsContent value="overview" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contact Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">{student.email}</span>
              </div>
              {student.phone && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{student.phone}</span>
                </div>
              )}
              {student.cwid && (
                <div className="flex items-center gap-2 text-sm">
                  <Hash className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">CWID: {student.cwid}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Enrollments tab — interactive table with CRUD */}
        <TabsContent value="enrollments" className="mt-6">
          <StudentEnrollmentsTable
            studentId={studentId}
            studentName={studentName}
            enrollments={enrollments}
            availableSections={availableSections}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
