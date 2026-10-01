/**
 * CreateProgramDialog — modal dialog for adding a new academic program.
 *
 * Simple dialog wrapping ProgramForm. On success, the dialog closes.
 * No two-state view needed (unlike students, programs don't involve
 * auth user creation or email sending).
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
import { ProgramForm } from '@/components/admin/programs/ProgramForm'

interface Department {
  id: string
  name: string
  code: string
}

interface Professor {
  id: string
  name: string
  email: string
}

interface CreateProgramDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  departments: Department[]
  professors: Professor[]
}

export function CreateProgramDialog({ open, onOpenChange, departments, professors }: CreateProgramDialogProps) {
  /** Called by ProgramForm after successful creation */
  const handleSuccess = () => {
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Program</DialogTitle>
          <DialogDescription>
            Create a new academic program. Assign it to a department and optionally designate a program director.
          </DialogDescription>
        </DialogHeader>
        <ProgramForm
          departments={departments}
          professors={professors}
          onSuccess={handleSuccess}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
