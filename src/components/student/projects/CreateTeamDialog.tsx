/**
 * CreateTeamDialog — Form for creating a new team under a project assignment.
 *
 * Fields: team name, description.
 * Calls createTeam server action.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  createTeamSchema,
  type CreateTeamInput,
} from '@/lib/validations/project'
import { createTeam } from '@/app/(dashboard)/student/courses/[sectionId]/projects/actions'

interface CreateTeamDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  projectId: string
}

export function CreateTeamDialog({
  open,
  onOpenChange,
  sectionId,
  projectId,
}: CreateTeamDialogProps) {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<CreateTeamInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createTeamSchema) as any,
    defaultValues: {
      name: '',
      description: '',
    },
  })

  const onSubmit = async (data: CreateTeamInput) => {
    setIsSubmitting(true)
    try {
      const result = await createTeam(projectId, sectionId, data)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Team created! You have been added as the team owner.')
      form.reset()
      onOpenChange(false)
      router.refresh()
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>Create Team</DialogTitle>
          <DialogDescription>
            Form a new team for this project assignment. You will be added as the team owner.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Team Name *</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Team Alpha" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Briefly describe your team's focus or approach..."
                      className="resize-none"
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
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
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create Team'
                )}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
