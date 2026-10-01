/**
 * SubmitSolutionDialog — Multi-tab submission dialog for students.
 *
 * Tabs: Text | Link (MVP). File and GitHub are deferred to V2.
 * Calls submitSolution server action.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Send, FileText, Link as LinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { submitSolution } from '@/app/(dashboard)/student/courses/[sectionId]/challenges/actions'

interface SubmitSolutionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  claimId: string
  sectionId: string
}

export function SubmitSolutionDialog({ open, onOpenChange, claimId, sectionId }: SubmitSolutionDialogProps) {
  const router = useRouter()
  const [submissionType, setSubmissionType] = useState<'text' | 'link'>('text')
  const [textContent, setTextContent] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit() {
    if (submissionType === 'text' && !textContent.trim()) {
      toast.error('Please enter your solution')
      return
    }
    if (submissionType === 'link' && !linkUrl.trim()) {
      toast.error('Please enter a URL')
      return
    }

    setIsSubmitting(true)
    try {
      const result = await submitSolution(claimId, sectionId, {
        submission_type: submissionType,
        content: submissionType === 'text' ? textContent : '',
        url: submissionType === 'link' ? linkUrl : '',
      })

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Solution submitted!')
      onOpenChange(false)
      setTextContent('')
      setLinkUrl('')
      router.refresh()
    } catch {
      toast.error('Failed to submit solution')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Submit Solution</DialogTitle>
          <DialogDescription>
            Submit your solution as text or a link. Once submitted, it will be reviewed by the instructor.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={submissionType} onValueChange={(v) => setSubmissionType(v as 'text' | 'link')}>
          <TabsList className="w-full">
            <TabsTrigger value="text" className="flex-1">
              <FileText className="h-3.5 w-3.5 mr-1" />
              Text
            </TabsTrigger>
            <TabsTrigger value="link" className="flex-1">
              <LinkIcon className="h-3.5 w-3.5 mr-1" />
              Link
            </TabsTrigger>
          </TabsList>

          <TabsContent value="text" className="mt-4">
            <Textarea
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              placeholder="Write your solution here..."
              rows={8}
              className="resize-none"
              maxLength={10000}
            />
            <p className="text-[11px] text-muted-foreground mt-1 text-right">
              {textContent.length}/10,000
            </p>
          </TabsContent>

          <TabsContent value="link" className="mt-4">
            <Input
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://..."
              type="url"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              Paste a link to your solution (GitHub repo, Google Doc, CodePen, etc.)
            </p>
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-3 pt-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            <Send className="h-3.5 w-3.5 mr-1" />
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
