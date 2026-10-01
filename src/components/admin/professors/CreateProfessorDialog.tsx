/**
 * CreateProfessorDialog — modal dialog for inviting a new professor.
 *
 * Wraps the ProfessorForm in a shadcn Dialog component.
 * Closes automatically on successful creation.
 * Uses a larger dialog size to accommodate the multi-section form.
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
import { ProfessorForm } from '@/components/admin/professors/ProfessorForm'

interface Department {
  id: string
  name: string
  code: string
}

interface CreateProfessorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  departments: Department[]
}

export function CreateProfessorDialog({ open, onOpenChange, departments }: CreateProfessorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Invite Professor</DialogTitle>
          <DialogDescription>
            Add a new professor to the platform. An invite email will be sent to their email address
            with a link to set their password and log in.
          </DialogDescription>
        </DialogHeader>
        <ProfessorForm
          departments={departments}
          onSuccess={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
