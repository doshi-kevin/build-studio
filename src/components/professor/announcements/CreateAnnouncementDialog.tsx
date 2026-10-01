/**
 * CreateAnnouncementDialog — Dialog wrapper for create/edit announcement form.
 *
 * Wider dialog (2xl) to accommodate the rich text editor and new controls.
 *
 * Type: Client Component
 */
'use client'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { AnnouncementForm } from './AnnouncementForm'
import type { Json } from '@/lib/supabase/types'
import type { AnnouncementAttachment, AnnouncementLink } from '@/lib/validations/announcement'
import type { CourseItem } from '@/lib/tiptap/course-mention-extension'

interface EnrolledStudent {
  id: string
  name: string | null
  email: string
}

interface CreateAnnouncementDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  announcement?: {
    id: string
    title: string
    content: string
    rich_content?: Json | null
    is_pinned: boolean
    is_important?: boolean
    requires_acknowledgement?: boolean
    status: string
    scheduled_at?: string | null
    visibility?: string
    allow_reactions?: boolean
    allow_comments?: boolean
    attachments?: AnnouncementAttachment[]
    links?: AnnouncementLink[]
  } | null
  enrolledStudents?: EnrolledStudent[]
  courseItems?: CourseItem[]
  otherSections?: { id: string; label: string; sublabel?: string }[]
  isGrouped?: boolean
  basePath?: string
}

export function CreateAnnouncementDialog({
  open,
  onOpenChange,
  sectionId,
  announcement,
  enrolledStudents,
  courseItems,
  otherSections,
  isGrouped,
  basePath,
}: CreateAnnouncementDialogProps) {
  const isEditMode = !!announcement

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit Announcement' : 'New Announcement'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Update the announcement details below.'
              : 'Create a new announcement for your students.'}
          </DialogDescription>
        </DialogHeader>
        <AnnouncementForm
          sectionId={sectionId}
          announcement={announcement}
          enrolledStudents={enrolledStudents}
          courseItems={courseItems}
          otherSections={otherSections}
          isGrouped={isGrouped}
          basePath={basePath}
          onSuccess={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
