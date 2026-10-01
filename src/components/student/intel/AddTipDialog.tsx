/**
 * AddTipDialog -- Dialog for adding a tip in the Course Alumni Intelligence Panel.
 *
 * Form with category select, content textarea, and anonymous toggle.
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
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AnonymousToggle } from './AnonymousToggle'
import {
  createTipSchema,
  TIP_CATEGORIES,
  TIP_CATEGORY_LABELS,
  type CreateTipInput,
} from '@/lib/validations/intel'
import { submitTip } from '@/app/(dashboard)/student/courses/[sectionId]/intel/actions'

interface AddTipDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
}

export function AddTipDialog({
  open,
  onOpenChange,
  sectionId,
}: AddTipDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<CreateTipInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createTipSchema) as any,
    defaultValues: {
      category: 'general',
      content: '',
      is_anonymous: false,
    },
  })

  const onSubmit = async (data: CreateTipInput) => {
    setIsSubmitting(true)
    try {
      const result = await submitTip(sectionId, data)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Tip shared')
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
          <DialogTitle>Share a Tip</DialogTitle>
          <DialogDescription>
            Share helpful advice for students taking this course.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category *</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {TIP_CATEGORIES.map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {TIP_CATEGORY_LABELS[cat]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="content"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tip *</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="e.g. Start the final project early -- it takes longer than you think..."
                      className="resize-none"
                      rows={4}
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
                {isSubmitting ? 'Sharing...' : 'Share Tip'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
