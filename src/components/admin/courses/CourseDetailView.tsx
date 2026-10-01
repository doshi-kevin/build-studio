/**
 * CourseDetailView — shows a course's info and all its sections.
 *
 * Admin can view course metadata, add new sections, toggle section status,
 * and remove sections. Each section shows its professor assignment.
 * Uses the same Card header + pill-style tabs pattern as other admin detail pages.
 *
 * Type: Client Component (dialog + transition state)
 */
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, BookOpen, MoreHorizontal, Trash2, ToggleLeft, ToggleRight, Users, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Breadcrumbs } from '@/components/ui/breadcrumbs'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { AddSectionDialog } from '@/components/admin/courses/AddSectionDialog'
import { EditSectionDialog } from '@/components/admin/courses/EditSectionDialog'
import { DeleteSectionDialog } from '@/components/admin/courses/DeleteSectionDialog'
import { toggleSectionStatus } from '@/app/(dashboard)/admin/courses/actions'
import { SEMESTER_LABELS, MODALITY_LABELS } from '@/lib/validations/course-assignment'
import { cn } from '@/lib/utils'

interface Professor {
  id: string
  name: string
  email: string
}

interface Section {
  id: string
  section_code: string
  semester: string
  year: number
  modality: string | null
  max_students: number | null
  status: string
  professor: Professor | Professor[] | null
}

interface Course {
  id: string
  code: string
  title: string
  description: string | null
  credits: number | null
  status: string
  department_id: string | null
}

interface CourseDetailViewProps {
  course: Course
  sections: Section[]
  professors: Professor[]
  departmentName?: string | null
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-foreground/5 text-foreground border-border',
  draft: 'bg-muted text-muted-foreground border-border',
  inactive: 'bg-muted text-muted-foreground border-border',
  archived: 'bg-muted text-muted-foreground border-border',
  cancelled: 'bg-destructive/10 text-destructive border-destructive/20',
}

function resolveProf(prof: Professor | Professor[] | null): Professor | null {
  if (!prof) return null
  return Array.isArray(prof) ? prof[0] ?? null : prof
}

export function CourseDetailView({ course, sections, professors, departmentName }: CourseDetailViewProps) {
  const router = useRouter()
  const [addSectionOpen, setAddSectionOpen] = useState(false)
  const [editingSection, setEditingSection] = useState<Section | null>(null)
  const [deletingSection, setDeletingSection] = useState<Section | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleToggleStatus = (sectionId: string, currentStatus: string) => {
    const next = currentStatus === 'active' ? 'inactive' : 'active'
    startTransition(async () => {
      const result = await toggleSectionStatus(sectionId, next)
      if ('error' in result && result.error) toast.error(result.error)
      else toast.success(`Section set to ${next}`)
    })
  }


  return (
    <div className="space-y-8">
      {/* Breadcrumb navigation */}
      <Breadcrumbs items={[
        { label: 'Admin', href: '/admin' },
        ...(course.department_id
          ? [{ label: 'Departments', href: '/admin/departments' }, { label: departmentName || 'Department', href: `/admin/departments/${course.department_id}` }]
          : []),
        { label: `${course.code} — ${course.title}` },
      ]} />

      {/* Course header card */}
      <Card className="rounded-2xl border-border">
        <CardContent className="pt-6 pb-5 space-y-4">
          {/* Top row: code badge + title + status */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center rounded-lg border border-border bg-muted/50 px-2.5 py-1 text-sm font-mono font-semibold text-foreground">
                {course.code}
              </span>
              <h1 className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">{course.title}</h1>
            </div>
            <StatusIndicator status={course.status || 'active'} />
          </div>

          {/* Description */}
          {course.description && (
            <p className="text-muted-foreground max-w-2xl text-sm">{course.description}</p>
          )}

          {/* Stats — compact divider-separated row */}
          <div className="flex items-center gap-6 pt-2 border-t border-border">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                <BookOpen className="h-4 w-4 text-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">{course.credits ?? '--'}</p>
                <p className="text-xs text-muted-foreground">Credits</p>
              </div>
            </div>
            <div className="h-8 w-px bg-border" />
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                <Users className="h-4 w-4 text-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">{sections.length}</p>
                <p className="text-xs text-muted-foreground">
                  {sections.length === 1 ? 'Section' : 'Sections'}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabbed content — pill-style tabs */}
      <Tabs defaultValue="sections" className="w-full">
        <TabsList className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground gap-1">
          <TabsTrigger
            value="sections"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <Users className="h-3.5 w-3.5" />
            Sections
            <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted-foreground/10 px-1.5 text-xs font-medium data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
              {sections.length}
            </span>
          </TabsTrigger>
        </TabsList>

        {/* Sections tab */}
        <TabsContent value="sections" className="mt-6">
          <div className="space-y-4">
            {/* Add button */}
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setAddSectionOpen(true)}>
                <Plus className="w-4 h-4 mr-1.5" />
                Add Section
              </Button>
            </div>

            {sections.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground gap-3 rounded-xl border border-dashed">
                <BookOpen className="w-7 h-7" />
                <p className="text-sm font-medium">No sections yet. Add the first section to assign a professor.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Section</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Professor</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Semester</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Modality</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Capacity</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sections.map((section) => {
                      const prof = resolveProf(section.professor)
                      return (
                        <tr
                          key={section.id}
                          className={cn('bg-card transition-colors', prof && 'cursor-pointer hover:bg-muted/30')}
                          onClick={() => prof && router.push(`/admin/professors/${prof.id}`)}
                        >
                          <td className="px-4 py-3 font-semibold">Section {section.section_code}</td>
                          <td className="px-4 py-3">
                            {prof ? (
                              <div>
                                <p className="font-medium">{prof.name}</p>
                                <p className="text-xs text-muted-foreground">{prof.email}</p>
                              </div>
                            ) : (
                              <span className="text-muted-foreground italic text-xs">Unassigned</span>
                            )}
                          </td>
                          <td className="px-4 py-3 capitalize">
                            {SEMESTER_LABELS[section.semester as keyof typeof SEMESTER_LABELS] ?? section.semester} {section.year}
                          </td>
                          <td className="px-4 py-3">
                            {section.modality ? MODALITY_LABELS[section.modality as keyof typeof MODALITY_LABELS] ?? section.modality : '—'}
                          </td>
                          <td className="px-4 py-3">{section.max_students ?? '—'}</td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className={cn('text-[11px] capitalize', STATUS_COLORS[section.status])}>
                              {section.status}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8" disabled={isPending}>
                                  <MoreHorizontal className="w-4 h-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => setEditingSection(section)}>
                                  <Pencil className="w-4 h-4 mr-2" />
                                  Edit Section
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleToggleStatus(section.id, section.status)}>
                                  {section.status === 'active'
                                    ? <><ToggleLeft className="w-4 h-4 mr-2" />Set Inactive</>
                                    : <><ToggleRight className="w-4 h-4 mr-2" />Set Active</>}
                                </DropdownMenuItem>
                                {/* Opens a confirmation rather than deleting on click: this
                                    cascades across 57 tables and sits one row below the
                                    harmless "Set Inactive". */}
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => setDeletingSection(section)}
                                >
                                  <Trash2 className="w-4 h-4 mr-2" />
                                  Delete section permanently
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      <AddSectionDialog
        open={addSectionOpen}
        onOpenChange={setAddSectionOpen}
        courseId={course.id}
        courseName={`${course.code} — ${course.title}`}
        professors={professors}
      />

      {editingSection && (
        <EditSectionDialog
          open={!!editingSection}
          onOpenChange={(open) => { if (!open) setEditingSection(null) }}
          section={editingSection}
          courseName={`${course.code} — ${course.title}`}
          professors={professors}
        />
      )}

      {deletingSection && (
        <DeleteSectionDialog
          open={!!deletingSection}
          onOpenChange={(open) => { if (!open) setDeletingSection(null) }}
          section={deletingSection}
        />
      )}
    </div>
  )
}
