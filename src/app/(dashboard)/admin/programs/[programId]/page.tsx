/**
 * Program Detail Page — admin view for a single academic program.
 *
 * Server component that fetches a program's details including department
 * and director info, then renders:
 * - Breadcrumb navigation
 * - Header card with icon, name, code badge, degree type, status, stats row
 * - Tabbed section: Overview, Department (pill-style tabs)
 *
 * Type: Server Component (async, fetches data server-side)
 * Route: /admin/programs/[programId]
 * Tables: programs, departments, profiles
 */

import Link from 'next/link'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { notFound } from 'next/navigation'
import { Building2, Clock, User, BookOpen } from 'lucide-react'
import { createAdminClient } from '@/lib/supabase/admin'
import { programQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Breadcrumbs } from '@/components/ui/breadcrumbs'
import { StatusIndicator } from '@/components/ui/status-indicator'
import {
  DEGREE_TYPE_LABELS,
  type DegreeType,
} from '@/lib/validations/program'

interface ProgramDetailPageProps {
  params: Promise<{ programId: string }>
}

const DEGREE_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  bachelor: 'default',
  master: 'secondary',
  doctorate: 'outline',
  certificate: 'secondary',
  diploma: 'outline',
}

export default async function ProgramDetailPage({ params }: ProgramDetailPageProps) {
  const { programId } = await params

  /* Unlike its sibling admin detail pages, this one had NO inline guard at all —
     neither a role check nor a tenant comparison — while fetching by a URL-supplied
     id with the RLS-bypassing admin client. Both are added here: the role check
     because the admin layout denies by returning <DeadEnd/> rather than throwing (so
     the page still executes and streams), and the institution comparison because
     getByIdWithDetails filters on id alone, which would otherwise let one institution's
     admin read another's program and its director's name and email. */
  const auth = await verifyInstitutionAdmin('ProgramDetailPage')
  if ('error' in auth) {
    logger.warn('ProgramDetailPage: denied, skipping fetch', { programId, reason: auth.error })
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  logger.debug('ProgramDetailPage: Fetching program', { programId })

  const program = await programQueries.getByIdWithDetails(adminDb, programId)

  if (!program) {
    logger.warn('ProgramDetailPage: Program not found', { programId })
    notFound()
  }

  if (program.institution_id !== auth.institutionId) {
    logger.warn('ProgramDetailPage: cross-tenant program access blocked', { programId, userId: auth.userId })
    notFound()
  }

  /* Handle Supabase join inconsistency — department/director might be array or object */
  const dept = program.department
    ? Array.isArray(program.department) ? program.department[0] : program.department
    : null
  const director = program.director
    ? Array.isArray(program.director) ? program.director[0] : program.director
    : null

  logger.info('ProgramDetailPage: Loaded', {
    programId,
    name: program.name,
    department: dept?.name,
  })

  return (
    <div className="space-y-8">
      {/* Breadcrumb navigation */}
      <Breadcrumbs items={[
        { label: 'Admin', href: '/admin' },
        { label: 'Programs', href: '/admin/programs' },
        { label: program.name },
      ]} />

      {/* Program header card */}
      <Card className="rounded-2xl border-border">
        <CardContent className="pt-6 pb-5 space-y-4">
          {/* Top row: icon + name + badges */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center justify-center rounded-xl border border-border bg-muted/50 h-10 w-10 text-sm font-mono font-semibold text-foreground">
                {program.code.slice(0, 3)}
              </span>
              <h1 className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">{program.name}</h1>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <StatusIndicator status={program.status || 'active'} />
              <Badge variant="outline" className="font-mono">
                {program.code}
              </Badge>
              <Badge variant={DEGREE_VARIANT[program.degree_type] || 'secondary'}>
                {DEGREE_TYPE_LABELS[program.degree_type as DegreeType] || program.degree_type}
              </Badge>
            </div>
          </div>

          {/* Description */}
          {program.description && (
            <p className="text-muted-foreground max-w-2xl text-sm">{program.description}</p>
          )}

          {/* Stats — compact divider-separated row */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-2 border-t">
            {dept && (
              <>
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                    <Building2 className="h-4 w-4 text-foreground" />
                  </div>
                  <div className="min-w-0">
                    <Link
                      href={`/admin/departments/${dept.id}`}
                      className="text-sm font-semibold leading-none hover:underline"
                    >
                      {dept.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">Department</p>
                  </div>
                </div>
                <div className="h-8 w-px bg-border" />
              </>
            )}
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                <BookOpen className="h-4 w-4 text-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">
                  {program.total_credits != null ? program.total_credits : '--'}
                </p>
                <p className="text-xs text-muted-foreground">Credits</p>
              </div>
            </div>
            <div className="h-8 w-px bg-border" />
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                <Clock className="h-4 w-4 text-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">
                  {program.duration_semesters != null ? program.duration_semesters : '--'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {program.duration_semesters === 1 ? 'Semester' : 'Semesters'}
                </p>
              </div>
            </div>
            {director && (
              <>
                <div className="h-8 w-px bg-border" />
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                    <User className="h-4 w-4 text-foreground" />
                  </div>
                  <div className="min-w-0">
                    <Link
                      href={`/admin/professors/${director.id}`}
                      className="text-sm font-semibold leading-none hover:underline truncate block"
                    >
                      {director.name || director.email}
                    </Link>
                    <p className="text-xs text-muted-foreground">Director</p>
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
            value="department"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <Building2 className="h-3.5 w-3.5" />
            Department
          </TabsTrigger>
        </TabsList>

        {/* Overview tab — description, metadata */}
        <TabsContent value="overview" className="mt-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Description card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Description</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {program.description || 'No description provided.'}
                </p>
              </CardContent>
            </Card>

            {/* Metadata card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Program Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Degree Type</span>
                  <Badge variant={DEGREE_VARIANT[program.degree_type] || 'secondary'}>
                    {DEGREE_TYPE_LABELS[program.degree_type as DegreeType] || program.degree_type}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Status</span>
                  <StatusIndicator status={program.status || 'active'} />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Program Code</span>
                  <span className="font-mono text-foreground">{program.code}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Total Credits</span>
                  <span className="text-foreground">{program.total_credits ?? '--'}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Duration</span>
                  <span className="text-foreground">
                    {program.duration_semesters != null
                      ? `${program.duration_semesters} semester${program.duration_semesters !== 1 ? 's' : ''}`
                      : '--'}
                  </span>
                </div>
                {director && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Director</span>
                    <Link
                      href={`/admin/professors/${director.id}`}
                      className="text-foreground hover:underline"
                    >
                      {director.name || director.email}
                    </Link>
                  </div>
                )}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Created</span>
                  <span className="text-foreground">
                    {program.created_at
                      ? new Date(program.created_at).toLocaleDateString()
                      : '--'}
                  </span>
                </div>
                {program.updated_at && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Last Updated</span>
                    <span className="text-foreground">
                      {new Date(program.updated_at).toLocaleDateString()}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Department tab */}
        <TabsContent value="department" className="mt-6">
          {dept ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Parent Department</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                    <Building2 className="h-6 w-6 text-foreground" />
                  </div>
                  <div>
                    <Link
                      href={`/admin/departments/${dept.id}`}
                      className="text-lg font-semibold text-foreground hover:underline"
                    >
                      {dept.name}
                    </Link>
                    <p className="text-sm text-muted-foreground font-mono">{dept.code}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-12">
                <div className="text-center">
                  <Building2 className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-muted-foreground font-medium">No department assigned</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    This program has not been assigned to a department yet.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
