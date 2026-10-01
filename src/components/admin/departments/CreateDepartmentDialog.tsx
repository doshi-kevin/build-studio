/**
 * CreateDepartmentDialog — modal dialog for creating a new department.
 *
 * Wraps the DepartmentForm in a shadcn Dialog component.
 * Closes automatically on successful creation.
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
import { DepartmentForm } from '@/components/admin/departments/DepartmentForm'

interface CreateDepartmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateDepartmentDialog({ open, onOpenChange }: CreateDepartmentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Create Department</DialogTitle>
          <DialogDescription>
            Add a new academic department. The code must be unique (e.g. CS, FIN, PHYS).
          </DialogDescription>
        </DialogHeader>
        <DepartmentForm
          onSuccess={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
