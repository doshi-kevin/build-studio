/**
 * CreateProjectDialog — Dialog for creating a new project assignment.
 *
 * Form fields: title, description, guidelines, max_team_size, due_date.
 * Status is always set to 'active' and visibility to 'course' on creation.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { createProject } from '@/app/(dashboard)/professor/courses/[sectionId]/projects/actions'
import {
  createProjectSchema,
  type CreateProjectInput,
} from '@/lib/validations/project'

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  sectionId,
}: CreateProjectDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const router = useRouter()

  const form = useForm<CreateProjectInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createProjectSchema) as any,
    defaultValues: {
      title: '',
      description: '',
      guidelines: '',
      status: 'active',
      visibility: 'course',
      max_team_size: 5,
      due_date: null,
      allow_team_workspace: true,
    },
  })

  // When max_team_size drops to 1 (individual project), the workspace
  // toggle has no meaning — there are no teammates to chat with.
  const maxTeamSize = form.watch('max_team_size') ?? 5
  const isGroupProject = maxTeamSize > 1

  const onSubmit = async (data: CreateProjectInput) => {
    setIsSubmitting(true)
    try {
      const result = await createProject(sectionId, data)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Project assignment created')
      form.reset()
      onOpenChange(false)
      // ProjectList is a client component fed by the server page; refresh
      // re-pulls the server data so the new card appears without a manual reload.
      router.refresh()
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Project Assignment</DialogTitle>
          <DialogDescription>
            Set up a project assignment for your students. They will form teams under this assignment.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title *</FormLabel>
                  <FormControl>
                    <Input placeholder="Final Group Project" {...field} />
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
                      placeholder="Describe the project goals and requirements..."
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
              name="guidelines"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Guidelines</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Detailed guidelines, rubric, or instructions for the project..."
                      className="resize-none"
                      rows={4}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="max_team_size"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Max Team Size</FormLabel>
                    <FormControl>
                      <Input
                        type="text"
                        inputMode="numeric"
                        placeholder="5"
                        {...field}
                        value={field.value ?? ''}
                        onChange={(e) => {
                          const v = e.target.value.replace(/[^0-9]/g, '')
                          field.onChange(v === '' ? undefined : Number(v))
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="due_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Due Date</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        {...field}
                        value={field.value || ''}
                        onChange={(e) => field.onChange(e.target.value || null)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {isGroupProject && (
              <FormField
                control={form.control}
                name="allow_team_workspace"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-3 rounded-xl border p-3">
                    <div className="space-y-0.5">
                      <FormLabel>Enable team chat workspace</FormLabel>
                      <p className="text-xs text-muted-foreground">
                        Lets each team open a private #chat, #tasks, and #resources channel. Turn off for projects that shouldn&apos;t have chat.
                      </p>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value ?? true}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            )}

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
                {isSubmitting ? 'Creating…' : 'Create Project'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
