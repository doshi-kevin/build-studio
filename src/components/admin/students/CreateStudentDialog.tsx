/**
 * CreateStudentDialog — modal dialog for adding a new student.
 *
 * Two-state dialog:
 * 1. Form view — StudentForm collects name, email, CWID, department, phone
 * 2. Success view — confirms account creation and that credentials were emailed
 *
 * The password is auto-generated server-side and sent directly to the student's
 * email. It is never displayed on screen.
 *
 * Type: Client Component (controlled dialog + two-state view)
 */
'use client'

import { useState } from 'react'
import { CheckCircle2, Mail } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { StudentForm } from '@/components/admin/students/StudentForm'

interface Department {
  id: string
  name: string
  code: string
}

interface CreateStudentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  departments: Department[]
}

export function CreateStudentDialog({ open, onOpenChange, departments }: CreateStudentDialogProps) {
  const [successInfo, setSuccessInfo] = useState<{ emailSent: boolean } | null>(null)

  /** Called by StudentForm after successful creation */
  const handleSuccess = (result: { emailSent: boolean }) => {
    setSuccessInfo(result)
  }

  /** Reset and close dialog */
  const handleClose = (isOpen: boolean) => {
    if (!isOpen) {
      setSuccessInfo(null)
    }
    onOpenChange(isOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        {successInfo ? (
          /* State 2: Success confirmation */
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-success-muted-foreground" />
                Student Created Successfully
              </DialogTitle>
              <DialogDescription>
                The student account has been set up and is ready to use.
              </DialogDescription>
            </DialogHeader>

            <div className="py-4">
              {successInfo.emailSent ? (
                <div className="rounded-xl bg-success-muted border border-success/30 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <Mail className="h-5 w-5 text-success-muted-foreground mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm text-success-muted-foreground font-medium">
                        Login credentials sent via email
                      </p>
                      <p className="text-sm text-success-muted-foreground mt-1">
                        The student&apos;s CWID and password have been sent to their email address.
                        They can log in using their Student ID (CWID) and password.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-warning-muted border border-warning/30 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <Mail className="h-5 w-5 text-warning-muted-foreground mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm text-warning-muted-foreground font-medium">
                        Account created, but email delivery failed
                      </p>
                      <p className="text-sm text-warning-muted-foreground mt-1">
                        The student account was created successfully, but we couldn&apos;t send the
                        credentials email. Please check the email configuration (RESEND_API_KEY)
                        or contact the student directly to share their login details.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <Button onClick={() => handleClose(false)}>Done</Button>
            </div>
          </>
        ) : (
          /* State 1: Form view */
          <>
            <DialogHeader>
              <DialogTitle>Add Student</DialogTitle>
              <DialogDescription>
                Add a new student to the platform. A login password will be auto-generated
                and sent to the student&apos;s email address.
              </DialogDescription>
            </DialogHeader>
            <StudentForm
              departments={departments}
              onSuccess={handleSuccess}
              onCancel={() => handleClose(false)}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
