/**
 * UpdateEnrollmentDialog -- modal dialog for updating an enrollment's status and grade.
 *
 * Allows the admin to change the enrollment status (enrolled/completed/dropped/withdrawn)
 * and update the final grade (letter) and final score (numeric 0-100).
 *
 * On submit, calls both updateEnrollmentStatus and updateEnrollmentGrade server actions.
 *
 * Type: Client Component (controlled dialog + form state)
 */
'use client'

import { useState, useEffect } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  updateEnrollmentStatus,
  updateEnrollmentGrade,
} from '@/app/(dashboard)/admin/students/enrollment-actions'
import {
  ENROLLMENT_STATUSES,
  ENROLLMENT_STATUS_LABELS,
} from '@/lib/validations/enrollment'

interface UpdateEnrollmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  enrollment: {
    id: string
    status: string
    final_grade: string | null
    final_score: number | null
    studentId: string
    courseName: string
  } | null
}

export function UpdateEnrollmentDialog({
  open,
  onOpenChange,
  enrollment,
}: UpdateEnrollmentDialogProps) {
  const [status, setStatus] = useState('')
  const [finalGrade, setFinalGrade] = useState('')
  const [finalScore, setFinalScore] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  /** Sync form state with enrollment data when dialog opens */
  useEffect(() => {
    if (open && enrollment) {
      setStatus(enrollment.status || 'enrolled')
      setFinalGrade(enrollment.final_grade || '')
      setFinalScore(
        enrollment.final_score != null ? String(enrollment.final_score) : ''
      )
    }
  }, [open, enrollment])

  const handleSubmit = async () => {
    if (!enrollment) return

    setIsSubmitting(true)
    try {
      const errors: string[] = []

      // Update status
      const statusResult = await updateEnrollmentStatus(
        enrollment.id,
        enrollment.studentId,
        { status: status as typeof ENROLLMENT_STATUSES[number] }
      )
      if ('error' in statusResult && statusResult.error) {
        errors.push(statusResult.error)
      }

      // Update grade
      const scoreValue = finalScore ? Number(finalScore) : null
      const gradeResult = await updateEnrollmentGrade(
        enrollment.id,
        enrollment.studentId,
        {
          final_grade: finalGrade || '',
          final_score: scoreValue,
        }
      )
      if ('error' in gradeResult && gradeResult.error) {
        errors.push(gradeResult.error)
      }

      if (errors.length > 0) {
        toast.error(errors.join('. '))
        return
      }

      toast.success('Enrollment updated successfully')
      onOpenChange(false)
    } catch {
      toast.error('Failed to update enrollment')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>Update Enrollment</DialogTitle>
          <DialogDescription>
            {enrollment
              ? `Update status and grade for ${enrollment.courseName}.`
              : 'Update enrollment details.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Status */}
          <div className="space-y-2">
            <Label htmlFor="enrollment-status">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="enrollment-status">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                {ENROLLMENT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {ENROLLMENT_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Final Grade */}
          <div className="space-y-2">
            <Label htmlFor="final-grade">Final Grade</Label>
            <Input
              id="final-grade"
              placeholder="e.g., A, B+, C-"
              value={finalGrade}
              onChange={(e) => setFinalGrade(e.target.value)}
              maxLength={5}
            />
          </div>

          {/* Final Score */}
          <div className="space-y-2">
            <Label htmlFor="final-score">Final Score (0-100)</Label>
            <Input
              id="final-score"
              type="number"
              placeholder="e.g., 92"
              value={finalScore}
              onChange={(e) => setFinalScore(e.target.value)}
              min={0}
              max={100}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
