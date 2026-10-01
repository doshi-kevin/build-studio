/**
 * ProfessorCoursesTable — interactive courses table for the professor detail page.
 *
 * Shows course sections assigned to a professor with a "Remove" action per row.
 *
 * Type: Client Component (needs server action calls)
 */
'use client'

import { MoreHorizontal, Trash2, BookOpen } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { removeAssignment } from '@/app/(dashboard)/admin/courses/actions'
import { SEMESTER_LABELS, type Semester } from '@/lib/validations/course-assignment'

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  inactive: 'secondary',
  cancelled: 'outline',
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  inactive: 'Inactive',
  cancelled: 'Cancelled',
  on_leave: 'On Leave',
}

interface Section {
  id: string
  section_code: string
  semester: string
  year: number
  status: string
  course: { id: string; code: string; title: string } | { id: string; code: string; title: string }[] | null
}

interface ProfessorCoursesTableProps {
  sections: Section[]
}

export function ProfessorCoursesTable({ sections }: ProfessorCoursesTableProps) {
  const handleRemove = async (sectionId: string, courseName: string) => {
    const result = await removeAssignment(sectionId)
    if ('error' in result && result.error) {
      toast.error(result.error)
      return
    }
    toast.success(`Removed from ${courseName}`)
  }

  if (sections.length === 0) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center">
            <BookOpen className="h-10 w-10 mx-auto text-muted-foreground/60 mb-3" />
            <p className="text-muted-foreground font-medium">No course assignments</p>
            <p className="text-sm text-muted-foreground/60 mt-1">
              Assign courses from the Course Assignments page.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Course</TableHead>
              <TableHead>Section</TableHead>
              <TableHead>Semester</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[50px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sections.map((section) => {
              const course = Array.isArray(section.course) ? section.course[0] : section.course
              const courseName = course ? `${course.code} ${course.title}` : 'this course'
              return (
                <TableRow key={section.id}>
                  <TableCell className="font-medium">
                    <span className="font-mono text-xs text-muted-foreground mr-1">{course?.code}</span>
                    {course?.title || '—'}
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-sm">{section.section_code}</span>
                  </TableCell>
                  <TableCell>
                    {SEMESTER_LABELS[section.semester as Semester] || section.semester} {section.year}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[section.status] || 'secondary'}>
                      {STATUS_LABELS[section.status] || section.status}
                    </Badge>
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
                        <DropdownMenuItem
                          onClick={() => handleRemove(section.id, courseName)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Remove Assignment
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
