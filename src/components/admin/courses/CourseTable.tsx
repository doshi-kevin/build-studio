/**
 * CourseTable — interactive data table for courses within a department.
 *
 * Receives course data from the server component parent and provides:
 * - "Add Course" button that opens the CourseDialog in create mode
 * - Clickable rows that navigate to /admin/courses/[courseId] detail page
 * - Per-row three-dot menu with Edit (same dialog, edit mode) and Delete actions
 * - Displays course code + title (combined column), credits, and status
 *
 * Type: Client Component (needs useState for dialog states)
 */
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
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
import { CourseDialog } from '@/components/admin/courses/CourseDialog'
import { DeleteCourseDialog } from '@/components/admin/courses/DeleteCourseDialog'

/** Status badge variants */
const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  inactive: 'secondary',
  archived: 'outline',
}

interface Course {
  id: string
  department_id: string
  code: string
  title: string
  description: string | null
  credits: number | null
  prerequisites: string | null
  status: string
  created_at: string
  updated_at: string
}

interface CourseTableProps {
  courses: Course[]
  departmentId: string
  departmentCode: string
}

export function CourseTable({ courses, departmentId, departmentCode }: CourseTableProps) {
  const router = useRouter()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [courseToEdit, setCourseToEdit] = useState<Course | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [courseToDelete, setCourseToDelete] = useState<{
    id: string
    code: string
    title: string
    departmentId: string
  } | null>(null)

  const handleDeleteClick = (course: Course) => {
    setCourseToDelete({ id: course.id, code: course.code, title: course.title, departmentId })
    setDeleteDialogOpen(true)
  }

  return (
    <div className="space-y-4">
      {/* Add button */}
      <div className="flex justify-end">
        <Button onClick={() => setCreateDialogOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Add Course
        </Button>
      </div>

      {/* Data table */}
      {courses.length === 0 ? (
        <p className="text-center py-8 text-muted-foreground">
          No courses in this department yet. Click &quot;Add Course&quot; to create one.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Course</TableHead>
              <TableHead className="text-center">Credits</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[50px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {courses.map((course) => (
              <TableRow
                key={course.id}
                className="cursor-pointer"
                onClick={() => router.push(`/admin/courses/${course.id}`)}
              >
                <TableCell>
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center rounded-xl bg-muted px-2 py-0.5 font-mono text-xs font-medium text-muted-foreground shrink-0">
                      {course.code}
                    </span>
                    <span className="font-medium">{course.title}</span>
                  </div>
                </TableCell>
                <TableCell className="text-center">{course.credits ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[course.status] || 'secondary'}>
                    {course.status === 'active' ? 'Active' : course.status === 'archived' ? 'Archived' : 'Inactive'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">Actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation()
                          setCourseToEdit(course)
                        }}
                      >
                        <Pencil className="h-4 w-4 mr-2" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteClick(course)
                        }}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Dialogs */}
      <CourseDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        departmentId={departmentId}
        departmentCode={departmentCode}
      />
      {/* Mounted only while editing so the form picks up the selected course's
          values — CourseForm seeds its defaults once, on mount. */}
      {courseToEdit && (
        <CourseDialog
          open
          onOpenChange={(open) => { if (!open) setCourseToEdit(null) }}
          departmentId={departmentId}
          departmentCode={departmentCode}
          course={courseToEdit}
        />
      )}
      <DeleteCourseDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        course={courseToDelete}
      />
    </div>
  )
}
