/**
 * StudentEnrollmentsTable -- interactive table for managing a student's enrollments.
 *
 * Displays all enrollments for a student with columns for Course, Section,
 * Semester, Professor, Status, Grade, and per-row action menus.
 *
 * Integrates three dialogs:
 * - EnrollStudentDialog: enroll in a new course section
 * - UpdateEnrollmentDialog: edit enrollment status and grade
 * - UnenrollDialog: remove enrollment
 *
 * Type: Client Component (needs useState for dialog states + action menus)
 */
'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Plus, MoreHorizontal, Pencil, UserMinus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EnrollStudentDialog } from '@/components/admin/enrollments/EnrollStudentDialog'
import { UpdateEnrollmentDialog } from '@/components/admin/enrollments/UpdateEnrollmentDialog'
import { UnenrollDialog } from '@/components/admin/enrollments/UnenrollDialog'
import { SEMESTER_LABELS, type Semester } from '@/lib/validations/course-assignment'
import { ENROLLMENT_STATUS_LABELS } from '@/lib/validations/enrollment'

/** Status badge color variants */
const ENROLLMENT_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  enrolled: 'default',
  completed: 'secondary',
  dropped: 'outline',
  withdrawn: 'outline',
}

interface SectionWithCourse {
  id: string
  section_code: string | null
  semester: string
  year: number
  course: {
    id: string
    code: string
    title: string
  } | null
}

interface Enrollment {
  id: string
  status: string
  final_grade: string | null
  final_score: number | null
  section_id: string
  // Supabase join data -- may be object or single-element array
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  section: any
}

interface StudentEnrollmentsTableProps {
  studentId: string
  studentName: string
  enrollments: Enrollment[]
  availableSections: SectionWithCourse[]
}

export function StudentEnrollmentsTable({
  studentId,
  studentName,
  enrollments,
  availableSections,
}: StudentEnrollmentsTableProps) {
  /* Dialog states */
  const [enrollDialogOpen, setEnrollDialogOpen] = useState(false)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [unenrollDialogOpen, setUnenrollDialogOpen] = useState(false)

  const [enrollmentToUpdate, setEnrollmentToUpdate] = useState<{
    id: string
    status: string
    final_grade: string | null
    final_score: number | null
    studentId: string
    courseName: string
  } | null>(null)

  const [enrollmentToRemove, setEnrollmentToRemove] = useState<{
    id: string
    studentId: string
    studentName: string
    courseName: string
  } | null>(null)

  /** Extract section IDs already enrolled in (for the enroll dialog filter) */
  /* section_id has to be SELECTED for this to be anything but [undefined] — the
     query nests section:course_sections(id, …) and used to omit the scalar column,
     so every id here was undefined, the dialog's exclusion filter matched nothing,
     and the enroll dropdown offered sections the student was already in (#725).
     The `any` cast on the query result is why TypeScript never flagged it despite
     Enrollment declaring section_id as required. Filtered so a stray undefined can
     never silently widen the list again. */
  const existingEnrollmentSectionIds = enrollments
    .map((e) => e.section_id)
    .filter((id): id is string => !!id)

  /** Safely resolve Supabase join data (may be array or object) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

  const handleEditClick = (enrollment: Enrollment) => {
    const section = resolveJoin(enrollment.section)
    const course = resolveJoin(section?.course)
    const courseName = course ? `${course.code} - ${course.title}` : 'Unknown Course'

    setEnrollmentToUpdate({
      id: enrollment.id,
      status: enrollment.status,
      final_grade: enrollment.final_grade,
      final_score: enrollment.final_score,
      studentId,
      courseName,
    })
    setUpdateDialogOpen(true)
  }

  const handleUnenrollClick = (enrollment: Enrollment) => {
    const section = resolveJoin(enrollment.section)
    const course = resolveJoin(section?.course)
    const courseName = course ? `${course.code} - ${course.title}` : 'Unknown Course'

    setEnrollmentToRemove({
      id: enrollment.id,
      studentId,
      studentName,
      courseName,
    })
    setUnenrollDialogOpen(true)
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex justify-end">
        <Button onClick={() => setEnrollDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Enroll in Course
        </Button>
      </div>

      {/* Table */}
      {enrollments.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No enrollments yet. Click &quot;Enroll in Course&quot; to add one.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Course</TableHead>
                <TableHead>Section</TableHead>
                <TableHead>Semester</TableHead>
                <TableHead>Professor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {enrollments.map((enrollment) => {
                const section = resolveJoin(enrollment.section)
                const course = resolveJoin(section?.course)
                const prof = resolveJoin(section?.professor)

                const semesterLabel = section
                  ? (SEMESTER_LABELS[section.semester as Semester] || section.semester)
                  : ''

                return (
                  <TableRow key={enrollment.id}>
                    <TableCell className="font-medium">
                      <span className="font-mono text-xs text-muted-foreground mr-1">
                        {course?.code}
                      </span>
                      {course?.title || '\u2014'}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-sm">
                        {section?.section_code || '\u2014'}
                      </span>
                    </TableCell>
                    <TableCell>
                      {section ? `${semesterLabel} ${section.year}` : '\u2014'}
                    </TableCell>
                    <TableCell>
                      {prof ? (
                        <Link
                          href={`/admin/professors/${prof.id}`}
                          className="hover:underline text-sm"
                        >
                          {prof.name || prof.email}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{'\u2014'}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ENROLLMENT_STATUS_VARIANT[enrollment.status] || 'secondary'}>
                        {ENROLLMENT_STATUS_LABELS[enrollment.status as keyof typeof ENROLLMENT_STATUS_LABELS] || enrollment.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {enrollment.final_grade || enrollment.final_score != null
                        ? `${enrollment.final_grade || ''} ${enrollment.final_score != null ? `(${enrollment.final_score})` : ''}`.trim()
                        : '\u2014'}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleEditClick(enrollment)}>
                            <Pencil className="h-4 w-4 mr-2" />
                            Edit Status/Grade
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleUnenrollClick(enrollment)}
                            className="text-destructive focus:text-destructive"
                          >
                            <UserMinus className="h-4 w-4 mr-2" />
                            Unenroll
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Dialogs */}
      <EnrollStudentDialog
        open={enrollDialogOpen}
        onOpenChange={setEnrollDialogOpen}
        studentId={studentId}
        studentName={studentName}
        sections={availableSections}
        existingEnrollmentSectionIds={existingEnrollmentSectionIds}
      />
      <UpdateEnrollmentDialog
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        enrollment={enrollmentToUpdate}
      />
      <UnenrollDialog
        open={unenrollDialogOpen}
        onOpenChange={setUnenrollDialogOpen}
        enrollment={enrollmentToRemove}
      />
    </div>
  )
}
