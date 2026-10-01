/**
 * EditProgramDialog — modal dialog for correcting an existing academic program.
 *
 * Programs were the one admin entity that could be created but never corrected:
 * `updateProgram` shipped with zero callers, so a typo in a name or code was
 * permanent and the only recourse was delete-and-recreate — which cascades to the
 * program's courses (#725). This wraps ProgramForm in edit mode, mirroring
 * CreateProgramDialog so the two read the same.
 *
 * The `program` row is passed straight through, including `updated_at`, which
 * ProgramForm sends back with the save so a concurrent edit is refused rather than
 * silently overwritten (#724).
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

interface EditProgramDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  departments: Department[]
  professors: Professor[]
  /** The program being corrected. Null closes the dialog. */
  program:
    | {
        id: string
        name: string
        code: string
        degree_type: string
        status: string
        department_id: string
        director_id: string | null
        description: string | null
        total_credits: number | null
        duration_semesters: number | null
        updated_at?: string | null
      }
    | null
}

export function EditProgramDialog({
  open,
  onOpenChange,
  departments,
  professors,
  program,
}: EditProgramDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          {/* Names the row: opened from a filtered grid of similarly-named
              programs, the title is the only confirmation you got the right one. */}
          <DialogTitle>{program ? `Edit ${program.name}` : 'Edit Program'}</DialogTitle>
          <DialogDescription>
            Correct this program&apos;s details. Changes apply to the program itself — its
            courses and their sections are untouched.
          </DialogDescription>
        </DialogHeader>
        {/* Keyed on the program id so switching rows re-initialises the form's
            defaultValues instead of showing the previously opened program. */}
        {program && (
          <ProgramForm
            key={program.id}
            departments={departments}
            professors={professors}
            program={program}
            onSuccess={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
