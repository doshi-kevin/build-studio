/**
 * CourseDialog — modal dialog for creating or editing a course.
 *
 * Wraps the CourseForm in a shadcn Dialog component. Pass `course` to edit that
 * course, omit it to create a new one — CourseForm already supported both modes,
 * so the dialog only swaps its heading.
 * Closes automatically on success.
 *
 * Type: Client Component (controlled dialog state)
 */
'use client'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CourseForm, type EditableCourse } from '@/components/admin/courses/CourseForm'

interface CourseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  departmentId: string
  departmentCode: string
  /** Provided → edit this course. Omitted → create a new one. */
  course?: EditableCourse | null
}

export function CourseDialog({ open, onOpenChange, departmentId, departmentCode, course }: CourseDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{course ? 'Edit Course' : 'Create Course'}</DialogTitle>
          <DialogDescription>
            {course
              ? `Update ${course.code}. Changes apply everywhere this course appears, including its sections.`
              : `Add a new course to this department. Type the course number — the ${departmentCode}- prefix is added automatically.`}
          </DialogDescription>
        </DialogHeader>
        <CourseForm
          departmentId={departmentId}
          departmentCode={departmentCode}
          course={course}
          onSuccess={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
