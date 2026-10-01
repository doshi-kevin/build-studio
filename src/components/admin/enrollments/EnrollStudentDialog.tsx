/**
 * EnrollStudentDialog -- modal dialog for enrolling a student in a course section.
 *
 * Shows a select dropdown of available sections (filtered to exclude sections
 * the student is already enrolled in). On submit, calls the enrollStudent
 * server action and closes the dialog on success.
 *
 * Type: Client Component (controlled dialog + select + submit state)
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { enrollStudent } from '@/app/(dashboard)/admin/students/enrollment-actions'
import { SEMESTER_LABELS, type Semester } from '@/lib/validations/course-assignment'

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

interface EnrollStudentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  studentId: string
  studentName: string
  sections: SectionWithCourse[]
  existingEnrollmentSectionIds: string[]
}

export function EnrollStudentDialog({
  open,
  onOpenChange,
  studentId,
  studentName,
  sections,
  existingEnrollmentSectionIds,
}: EnrollStudentDialogProps) {
  const [selectedSectionId, setSelectedSectionId] = useState<string>('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  /** Filter out sections the student is already enrolled in */
  const availableSections = sections.filter(
    (section) => !existingEnrollmentSectionIds.includes(section.id)
  )

  const handleSubmit = async () => {
    if (!selectedSectionId) {
      toast.error('Please select a course section')
      return
    }

    setIsSubmitting(true)
    try {
      const result = await enrollStudent({
        student_id: studentId,
        section_id: selectedSectionId,
      })

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Student enrolled successfully')
      setSelectedSectionId('')
      onOpenChange(false)
    } catch {
      toast.error('Failed to enroll student')
    } finally {
      setIsSubmitting(false)
    }
  }

  /** Reset selection when dialog closes */
  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setSelectedSectionId('')
    }
    onOpenChange(isOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Enroll {studentName} in a Course</DialogTitle>
          <DialogDescription>
            Select a course section to enroll this student in.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <Label htmlFor="section-select">Course Section</Label>
          {availableSections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No available sections to enroll in. The student may already be enrolled in all active sections.
            </p>
          ) : (
            <Select value={selectedSectionId} onValueChange={setSelectedSectionId}>
              <SelectTrigger id="section-select">
                <SelectValue placeholder="Select a course section" />
              </SelectTrigger>
              <SelectContent>
                {availableSections.map((section) => {
                  const course = Array.isArray(section.course) ? section.course[0] : section.course
                  const semesterLabel = SEMESTER_LABELS[section.semester as Semester] || section.semester
                  return (
                    <SelectItem key={section.id} value={section.id}>
                      {course?.code} - {course?.title} (Section {section.section_code || '?'}, {semesterLabel} {section.year})
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !selectedSectionId || availableSections.length === 0}
          >
            {isSubmitting ? 'Enrolling...' : 'Enroll Student'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
