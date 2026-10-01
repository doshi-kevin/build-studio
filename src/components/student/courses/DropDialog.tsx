/**
 * DropDialog — confirmation dialog before unenrolling from a course.
 *
 * Only reachable while the institution's self-unenroll window is open (the
 * sidebar hides the button otherwise, and the action re-checks the policy).
 *
 * Type: Client Component
 */
'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { dropSection } from '@/app/(dashboard)/student/courses/actions'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

interface DropDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  section: any
  /** After a successful drop, redirect to this path (e.g. '/student/courses') */
  redirectTo?: string
}

export function DropDialog({ open, onOpenChange, section, redirectTo }: DropDialogProps) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  if (!section) return null

  const course = resolveJoin(section.course)

  const handleDrop = () => {
    startTransition(async () => {
      const result = await dropSection(section.id)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success(`Unenrolled from ${course?.code || 'course'} — ${section.section_code}`)
        onOpenChange(false)
        if (redirectTo) {
          router.push(redirectTo)
        }
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Unenroll from Course
          </DialogTitle>
          <DialogDescription>
            Are you sure you want to unenroll? Your administrator can re-add you later if this was a mistake.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="rounded-xl border border-destructive/30 bg-destructive-muted p-3 space-y-1.5">
            <p className="text-xs font-mono text-muted-foreground">{course?.code}</p>
            <p className="font-semibold text-sm">{course?.title}</p>
            <p className="text-xs text-muted-foreground">
              Section {section.section_code} — {section.semester?.charAt(0).toUpperCase() + section.semester?.slice(1)} {section.year}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Keep Enrolled
          </Button>
          <Button variant="destructive" onClick={handleDrop} disabled={isPending}>
            {isPending ? 'Unenrolling...' : 'Unenroll'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
