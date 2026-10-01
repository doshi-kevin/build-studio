/**
 * Department Detail Page — professional admin view for a single department.
 *
 * Server component that fetches a department and its related records
 * (courses, faculty), then renders a clean admin panel with:
 * - Breadcrumb back link + department header (code badge, name, status)
 * - Summary cards showing key stats (course count, faculty count, contact)
 * - Tabbed section: Courses (interactive CRUD), Faculty (interactive add/remove), Settings (edit form)
 *
 * The edit form is placed in a Settings tab to keep the primary view focused
 * on operational tasks (managing courses and faculty).
 *
 * If the department is not found (invalid ID), Next.js renders the not-found page.
 *
 * Data flow:
 * 1. Extracts departmentId from URL params
 * 2. Calls departmentQueries.getByIdWithRelated() — parallel fetch of dept + related tables
 * 3. Passes courses to CourseTable (client) for CRUD operations
 * 4. Fetches available professors and passes to FacultyTable (client) for add/remove
 * 5. Passes department to DepartmentForm (client) in Settings tab for editing
 *
 * Type: Server Component (async, fetches data server-side)
 * Route: /admin/departments/[departmentId]
 * Tables: departments, courses, department_faculty, profiles
 */

import { notFound } from 'next/navigation'
import { BookOpen, Users, Mail, MapPin, Phone, Settings, ScrollText } from 'lucide-react'
import { createAdminClient } from '@/lib/supabase/admin'
import { departmentQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { logger } from '@/lib/logger'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Breadcrumbs } from '@/components/ui/breadcrumbs'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { DepartmentForm } from '@/components/admin/departments/DepartmentForm'
import { CourseTable } from '@/components/admin/courses/CourseTable'
import { FacultyTable } from '@/components/admin/departments/FacultyTable'

interface DepartmentDetailPageProps {
  params: Promise<{ departmentId: string }>
}

export default async function DepartmentDetailPage({ params }: DepartmentDetailPageProps) {
  const { departmentId } = await params

  const auth = await verifyInstitutionAdmin('DepartmentDetailPage')
  if ('error' in auth) {
    logger.warn('DepartmentDetailPage: Unauthorized', { departmentId })
    notFound()
  }

  /* Use admin client to bypass RLS — this page is already behind the admin layout guard */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  logger.debug('DepartmentDetailPage: Fetching department', { departmentId, institutionId: auth.institutionId })

  const result = await departmentQueries.getByIdWithRelated(adminDb, departmentId)

  /* Department not found — render a helpful error instead of crashing */
  if (!result) {
    logger.warn('DepartmentDetailPage: Department not found', { departmentId })
    notFound()
  }

  const { department, courses, faculty } = result

  /* Cross-tenant guard — block access if the department belongs to another institution. */
  if (department.institution_id !== auth.institutionId) {
    logger.warn('DepartmentDetailPage: cross-tenant access blocked', {
      departmentId,
      deptInstitution: department.institution_id,
      callerInstitution: auth.institutionId,
    })
    notFound()
  }

  /* Fetch programs + all professors + section-based faculty in parallel.
   * Professors filtered by institution_id (defense-in-depth + correctness). */
  const courseIds = courses.map((c: { id: string }) => c.id)
  const [{ data: programs }, { data: allProfessors }, { data: sectionProfessors }] = await Promise.all([
    adminDb.from('programs').select('id').eq('department_id', departmentId),
    adminDb
      .from('profiles')
      .select('id, name, email')
      .eq('role', 'professor')
      .eq('institution_id', auth.institutionId)
      .order('name'),
    courseIds.length > 0
      ? adminDb
          .from('course_sections')
          .select('professor_id, professor:profiles(id, name, email)')
          .in('course_id', courseIds)
          .not('professor_id', 'is', null)
      : Promise.resolve({ data: [] }),
  ])
  const programCount = programs?.length || 0

  /* Merge department_faculty + professors teaching sections in this department */
  const deptFacultyProfIds = new Set(faculty.map((f: { professor_id: string }) => f.professor_id))
  const sectionOnlyFaculty = (sectionProfessors || [])
    .filter((s: { professor_id: string }) => !deptFacultyProfIds.has(s.professor_id))
    .reduce((acc: { id?: string; professor_id: string; professor: { id: string; name: string | null; email: string } | { id: string; name: string | null; email: string }[] | null; [key: string]: unknown }[], s: { professor_id: string; professor: { id: string; name: string | null; email: string } | { id: string; name: string | null; email: string }[] | null }) => {
      // Deduplicate by professor_id (a professor may teach multiple sections)
      if (!acc.some(a => a.professor_id === s.professor_id)) {
        acc.push({
          id: `section-${s.professor_id}`,
          professor_id: s.professor_id,
          title: null,
          position: null,
          status: 'active',
          professor: s.professor,
          source: 'section' as const,
        })
      }
      return acc
    }, [] as { id: string; professor_id: string; title: string | null; position: string | null; status: string; professor: unknown; source: 'section' }[])

  const mergedFaculty = [...faculty, ...sectionOnlyFaculty]

  /* Fetch professors not already in this department — for the "Add Faculty" dialog.
     Only exclude professors with a real department_faculty row, so section-only
     professors can be promoted to formal faculty via the dialog. */
  const realFacultyProfIds = new Set(faculty.map((f: { professor_id: string }) => f.professor_id))
  const availableProfessors = (allProfessors || []).filter(
    (p: { id: string }) => !realFacultyProfIds.has(p.id)
  )

  logger.info('DepartmentDetailPage: Loaded', {
    departmentId,
    name: department.name,
    courses: courses.length,
    faculty: mergedFaculty.length,
  })

  return (
    <div className="space-y-8">
      {/* Breadcrumb navigation */}
      <Breadcrumbs items={[
        { label: 'Admin', href: '/admin' },
        { label: 'Departments', href: '/admin/departments' },
        { label: department.name },
      ]} />

      {/* Department header card */}
      <Card className="rounded-2xl border-border">
        <CardContent className="pt-6 pb-5 space-y-4">
          {/* Top row: code + name + status */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center rounded-lg border border-border bg-muted/50 px-2.5 py-1 text-sm font-mono font-semibold text-foreground">
                {department.code}
              </span>
              <h1 className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">{department.name}</h1>
            </div>
            <StatusIndicator status={department.status || 'active'} />
          </div>

          {/* Description */}
          {department.description && (
            <p className="text-muted-foreground max-w-2xl text-[15px]">{department.description}</p>
          )}

          {/* Contact details — inline row */}
          {(department.contact_email || department.office_location || department.contact_phone) && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
              {department.contact_email && (
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5" />
                  {department.contact_email}
                </span>
              )}
              {department.office_location && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5" />
                  {department.office_location}
                </span>
              )}
              {department.contact_phone && (
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5" />
                  {department.contact_phone}
                </span>
              )}
            </div>
          )}

          {/* Stats — compact divider-separated row */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-2 border-t border-border">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                <BookOpen className="h-4 w-4 text-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">{courses.length}</p>
                <p className="text-xs text-muted-foreground">
                  {courses.length === 1 ? 'Course' : 'Courses'}
                </p>
              </div>
            </div>
            <div className="h-8 w-px bg-border" />
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                <Users className="h-4 w-4 text-foreground" />
              </div>
              {/* The department list card counts formal department_faculty rows; this page
                  also merges in professors who teach a section here without one. Both are
                  right, and showing them under the same bare label "Faculty" is what made
                  the same department read 1 on the list and 2 here (#717 part 2). Naming the
                  formal subset makes the relationship explicit instead of picking a winner
                  and hiding the other number. */}
              <div>
                <p className="text-sm font-semibold leading-none">{mergedFaculty.length}</p>
                <p className="text-xs text-muted-foreground">
                  {sectionOnlyFaculty.length > 0
                    ? `Teaching (${faculty.length} appointed)`
                    : 'Faculty'}
                </p>
              </div>
            </div>
            <div className="h-8 w-px bg-border" />
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                <ScrollText className="h-4 w-4 text-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">{programCount}</p>
                <p className="text-xs text-muted-foreground">
                  {programCount === 1 ? 'Program' : 'Programs'}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabbed content — Courses, Faculty, Settings */}
      <Tabs defaultValue="courses" className="w-full">
        <TabsList className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground gap-1">
          <TabsTrigger
            value="courses"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Courses
            <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted-foreground/10 px-1.5 text-xs font-medium data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
              {courses.length}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="faculty"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <Users className="h-3.5 w-3.5" />
            Faculty
            <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted-foreground/10 px-1.5 text-xs font-medium data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
              {mergedFaculty.length}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="settings"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <Settings className="h-3.5 w-3.5" />
            Settings
          </TabsTrigger>
        </TabsList>

        {/* Courses tab — interactive table with Add/Edit/Delete */}
        <TabsContent value="courses" className="mt-6">
          <CourseTable courses={courses} departmentId={departmentId} departmentCode={department.code} />
        </TabsContent>

        {/* Faculty tab — interactive add/remove */}
        <TabsContent value="faculty" className="mt-6">
          <FacultyTable
            faculty={mergedFaculty}
            departmentId={departmentId}
            availableProfessors={availableProfessors}
          />
        </TabsContent>

        {/* Settings tab — department edit form */}
        <TabsContent value="settings" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Department Settings</CardTitle>
              <CardDescription>
                Update department information, contact details, and status.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DepartmentForm department={department} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
