/**
 * Professor Detail Page — admin view for a single professor.
 *
 * Server component that fetches a professor's profile and related data
 * (department assignments, course sections), then renders:
 * - Breadcrumb navigation
 * - Header card with avatar, name, email, status, contact, stats row
 * - Tabbed section: Overview, Departments, Courses (pill-style tabs)
 *
 * Type: Server Component (async, fetches data server-side)
 * Route: /admin/professors/[professorId]
 * Tables: profiles, department_faculty, departments, course_sections, courses
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  Building2, BookOpen, Mail, Phone, MapPin, Globe, Clock,
  Linkedin, FileText, Briefcase,
} from 'lucide-react'
import { createAdminClient } from '@/lib/supabase/admin'
import { professorQueries } from '@/lib/supabase/queries'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { logger } from '@/lib/logger'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Breadcrumbs } from '@/components/ui/breadcrumbs'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { POSITION_LABELS, EMPLOYMENT_TYPE_LABELS, INVITE_STATUS_LABELS, INVITE_STATUS_VARIANT, INVITE_STATUS_TOOLTIPS, type Position, type EmploymentType } from '@/lib/validations/professor'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ProfessorCoursesTable } from '@/components/admin/professors/ProfessorCoursesTable'

interface ProfessorDetailPageProps {
  params: Promise<{ professorId: string }>
}

export default async function ProfessorDetailPage({ params }: ProfessorDetailPageProps) {
  const { professorId } = await params

  const auth = await verifyInstitutionAdmin('ProfessorDetailPage')
  if ('error' in auth) {
    logger.warn('ProfessorDetailPage: Unauthorized', { professorId })
    notFound()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  logger.debug('ProfessorDetailPage: Fetching professor', { professorId, institutionId: auth.institutionId })

  const result = await professorQueries.getByIdWithDetails(adminDb, professorId)

  if (!result) {
    logger.warn('ProfessorDetailPage: Professor not found', { professorId })
    notFound()
  }

  const { professor, departments, sections } = result

  /* Cross-tenant guard. */
  if (professor.institution_id !== auth.institutionId) {
    logger.warn('ProfessorDetailPage: cross-tenant access blocked', {
      professorId,
      profInstitution: professor.institution_id,
      callerInstitution: auth.institutionId,
    })
    notFound()
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const primaryDept = departments.find((d: any) => d.is_primary_department) || departments[0]
  const primaryDeptInfo = primaryDept?.department
  const deptObj = Array.isArray(primaryDeptInfo) ? primaryDeptInfo[0] : primaryDeptInfo

  /** research_interests is jsonb: a real array (seeded data) or a comma-separated
   *  string (the onboarding form's stored shape) — normalize both into tag chips. */
  const researchInterests = Array.isArray(primaryDept?.research_interests)
    ? primaryDept.research_interests.map((s: string) => String(s).trim()).filter(Boolean)
    : primaryDept?.research_interests
      ? String(primaryDept.research_interests).split(',').map((s: string) => s.trim()).filter(Boolean)
      : []

  /** Social / external links */
  const socialLinks = [
    { url: primaryDept?.website_url, icon: Globe, label: 'Website' },
    { url: primaryDept?.linkedin_url, icon: Linkedin, label: 'LinkedIn' },
    { url: primaryDept?.resume_url, icon: FileText, label: 'Resume/CV' },
  ].filter(link => link.url)

  logger.info('ProfessorDetailPage: Loaded', {
    professorId,
    name: professor.name,
    departments: departments.length,
    sections: sections.length,
  })

  const professorName = professor.name || `${professor.first_name || ''} ${professor.last_name || ''}`.trim() || professor.email

  return (
    <div className="space-y-8">
      {/* Breadcrumb navigation */}
      <Breadcrumbs items={[
        { label: 'Admin', href: '/admin' },
        { label: 'Professors', href: '/admin/professors' },
        { label: professorName },
      ]} />

      {/* Professor header card */}
      <Card className="rounded-2xl border-border">
        <CardContent className="pt-6 pb-5 space-y-4">
          {/* Top row: avatar + name + badges */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center justify-center rounded-xl border border-border bg-muted/50 h-10 w-10 text-sm font-mono font-semibold text-foreground">
                {(professor.first_name?.[0] || professor.name?.[0] || '?').toUpperCase()}
                {(professor.last_name?.[0] || '').toUpperCase()}
              </span>
              <h1 className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">{professorName}</h1>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {professor.invite_status && professor.invite_status !== 'active' ? (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant={INVITE_STATUS_VARIANT[professor.invite_status] || 'secondary'} className="cursor-help">
                        {INVITE_STATUS_LABELS[professor.invite_status] || professor.invite_status}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p>{INVITE_STATUS_TOOLTIPS[professor.invite_status] || ''}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <StatusIndicator status={primaryDept?.status || 'active'} />
              )}
              {primaryDept?.position && (
                <Badge variant="outline" className="font-normal">
                  {POSITION_LABELS[primaryDept.position as Position] || primaryDept.position}
                </Badge>
              )}
              {primaryDept?.employment_type && (
                <Badge variant="outline" className="font-normal">
                  <Briefcase className="h-3 w-3 mr-1" />
                  {EMPLOYMENT_TYPE_LABELS[primaryDept.employment_type as EmploymentType] || primaryDept.employment_type}
                </Badge>
              )}
            </div>
          </div>

          {/* Contact details — inline row */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              {professor.email}
            </span>
            {professor.phone && (
              <span className="inline-flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5" />
                {professor.phone}
              </span>
            )}
            {primaryDept?.office_location && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" />
                {primaryDept.office_location}
              </span>
            )}
            {deptObj && (
              <span className="inline-flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5" />
                {deptObj.code} — {deptObj.name}
              </span>
            )}
          </div>

          {/* Stats — compact divider-separated row */}
          <div className="flex items-center gap-6 pt-2 border-t border-border">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                <Building2 className="h-4 w-4 text-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">{departments.length}</p>
                <p className="text-xs text-muted-foreground">
                  {departments.length === 1 ? 'Department' : 'Departments'}
                </p>
              </div>
            </div>
            <div className="h-8 w-px bg-border" />
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                <BookOpen className="h-4 w-4 text-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">{sections.length}</p>
                <p className="text-xs text-muted-foreground">
                  {sections.length === 1 ? 'Course Section' : 'Course Sections'}
                </p>
              </div>
            </div>
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
            value="departments"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <Building2 className="h-3.5 w-3.5" />
            Departments
            <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted-foreground/10 px-1.5 text-xs font-medium data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
              {departments.length}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="courses"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Courses
            <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted-foreground/10 px-1.5 text-xs font-medium data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
              {sections.length}
            </span>
          </TabsTrigger>
        </TabsList>

        {/* Overview tab — bio, research interests, contact, office hours */}
        <TabsContent value="overview" className="mt-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Bio + Research Interests card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Bio</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {primaryDept?.bio || 'No bio provided.'}
                </p>
                {researchInterests.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Research Interests</p>
                    <div className="flex flex-wrap gap-1.5">
                      {researchInterests.map((interest: string, i: number) => (
                        <Badge key={i} variant="outline" className="font-normal text-xs">
                          {interest}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Contact & Links card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Contact & Links</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{professor.email}</span>
                </div>
                {professor.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">{professor.phone}</span>
                  </div>
                )}
                {primaryDept?.office_location && (
                  <div className="flex items-center gap-2 text-sm">
                    <MapPin className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">{primaryDept.office_location}</span>
                  </div>
                )}

                {/* Office Hours — styled card */}
                {primaryDept?.office_hours && (
                  <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground mb-1">
                      <Clock className="h-4 w-4 text-foreground" />
                      Office Hours
                    </div>
                    <p className="text-sm text-muted-foreground ml-6">{primaryDept.office_hours}</p>
                  </div>
                )}

                {/* Social / external links */}
                {socialLinks.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-border">
                    <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">External Links</p>
                    <div className="flex gap-2">
                      {socialLinks.map(({ url, icon: Icon, label }) => (
                        <a
                          key={label}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {label}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Departments tab */}
        <TabsContent value="departments" className="mt-6">
          {departments.length === 0 ? (
            <Card>
              <CardContent className="py-12">
                <div className="text-center">
                  <Building2 className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-muted-foreground font-medium">No department assignments</p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Department</TableHead>
                      <TableHead>Position</TableHead>
                      <TableHead>Employment</TableHead>
                      <TableHead>Primary</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {departments.map((fac: any) => {
                      const dept = Array.isArray(fac.department) ? fac.department[0] : fac.department
                      return (
                        <TableRow key={fac.id}>
                          <TableCell>
                            {dept ? (
                              <Link href={`/admin/departments/${dept.id}`} className="hover:underline">
                                <span className="font-mono text-xs text-muted-foreground mr-1">{dept.code}</span>
                                <span className="font-medium">{dept.name}</span>
                              </Link>
                            ) : '—'}
                          </TableCell>
                          <TableCell>
                            {fac.position ? POSITION_LABELS[fac.position as Position] || fac.position : '—'}
                          </TableCell>
                          <TableCell>
                            {fac.employment_type ? EMPLOYMENT_TYPE_LABELS[fac.employment_type as EmploymentType] || fac.employment_type : '—'}
                          </TableCell>
                          <TableCell>
                            {fac.is_primary_department ? (
                              <Badge variant="default" className="text-xs">Primary</Badge>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <StatusIndicator status={fac.status || 'active'} />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Courses tab — interactive with remove action */}
        <TabsContent value="courses" className="mt-6">
          <ProfessorCoursesTable sections={sections} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
