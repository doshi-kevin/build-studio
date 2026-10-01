/**
 * AddFacultyDialog — dialog to add an existing professor to a department.
 *
 * Shows a dropdown of professors not yet in this department, plus
 * department-specific fields (position, employment type, office).
 *
 * Type: Client Component (needs react-hook-form state)
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { addProfessorToDepartment } from '@/app/(dashboard)/admin/professors/actions'
import { POSITIONS, POSITION_LABELS, EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABELS } from '@/lib/validations/professor'

interface Professor {
  id: string
  name: string | null
  email: string
}

interface AddFacultyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  departmentId: string
  /** Professors NOT already in this department */
  availableProfessors: Professor[]
}

export function AddFacultyDialog({ open, onOpenChange, departmentId, availableProfessors }: AddFacultyDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [professorId, setProfessorId] = useState('')
  const [position, setPosition] = useState('professor')
  const [employmentType, setEmploymentType] = useState('full_time')
  const [officeLocation, setOfficeLocation] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!professorId) {
      toast.error('Please select a professor')
      return
    }

    setIsSubmitting(true)
    try {
      const result = await addProfessorToDepartment({
        department_id: departmentId,
        professor_id: professorId,
        position,
        employment_type: employmentType,
        office_location: officeLocation || undefined,
      })

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Professor added to department')
      setProfessorId('')
      setOfficeLocation('')
      onOpenChange(false)
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Add Faculty Member</DialogTitle>
          <DialogDescription>
            Add an existing professor to this department.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>Professor *</Label>
            <Select value={professorId} onValueChange={setProfessorId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select a professor" />
              </SelectTrigger>
              <SelectContent>
                {availableProfessors.length === 0 ? (
                  <SelectItem value="_none" disabled>
                    No professors available
                  </SelectItem>
                ) : (
                  availableProfessors.map((prof) => (
                    <SelectItem key={prof.id} value={prof.id}>
                      {prof.name || prof.email}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Position *</Label>
              <Select value={position} onValueChange={setPosition}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POSITIONS.map((pos) => (
                    <SelectItem key={pos} value={pos}>
                      {POSITION_LABELS[pos]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Employment Type *</Label>
              <Select value={employmentType} onValueChange={setEmploymentType}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMPLOYMENT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {EMPLOYMENT_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Office Location</Label>
            <Input
              className="mt-1"
              placeholder="Babbio Center, Room 304"
              value={officeLocation}
              onChange={(e) => setOfficeLocation(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !professorId}>
              {isSubmitting ? 'Adding...' : 'Add to Department'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
