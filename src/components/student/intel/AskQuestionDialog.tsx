/**
 * AskQuestionDialog -- Dialog for asking a question in the Course Alumni Intelligence Panel.
 *
 * Form with title, optional body, and anonymous toggle.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { AnonymousToggle } from './AnonymousToggle'
import {
  createQuestionSchema,
  type CreateQuestionInput,
} from '@/lib/validations/intel'
import { askQuestion } from '@/app/(dashboard)/student/courses/[sectionId]/intel/actions'

interface AskQuestionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
}

export function AskQuestionDialog({
  open,
  onOpenChange,
  sectionId,
}: AskQuestionDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<CreateQuestionInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createQuestionSchema) as any,
    defaultValues: {
      title: '',
      body: '',
      is_anonymous: false,
    },
  })

  const onSubmit = async (data: CreateQuestionInput) => {
    setIsSubmitting(true)
    try {
      const result = await askQuestion(sectionId, data)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Question posted')
      form.reset()
      onOpenChange(false)
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ask a Question</DialogTitle>
          <DialogDescription>
            Ask alumni and peers about this course. Your question will be visible to all students.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Question *</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. How heavy is the final project?"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="body"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Details</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Add more context to your question (optional)..."
                      className="resize-none"
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="is_anonymous"
              render={({ field }) => (
                <FormItem>
                  <AnonymousToggle
                    value={field.value}
                    onChange={field.onChange}
                  />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Posting...' : 'Post Question'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
