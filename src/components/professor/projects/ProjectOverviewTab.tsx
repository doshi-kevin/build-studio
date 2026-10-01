/**
 * ProjectOverviewTab — Editable project assignment settings form (professor view).
 *
 * Displays and allows editing of title, description, guidelines, max_team_size,
 * and due_date. Shows an "Unsaved changes" indicator when dirty and fires a
 * beforeunload warning to prevent accidental data loss.
 *
 * Type: Client Component
 */
'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { Save, Calendar, Trash2, Archive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { updateProject } from '@/app/(dashboard)/professor/courses/[sectionId]/projects/actions'
import { DeleteProjectDialog } from './DeleteProjectDialog'
import {
  updateProjectSchema,
  type UpdateProjectInput,
} from '@/lib/validations/project'

interface ProjectOverviewTabProps {
  sectionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  project: any
}

export function ProjectOverviewTab({ sectionId, project }: ProjectOverviewTabProps) {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isArchiving, setIsArchiving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const form = useForm<UpdateProjectInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(updateProjectSchema) as any,
    defaultValues: {
      title: project.title || '',
      description: project.description || '',
      guidelines: project.guidelines || '',
      max_team_size: project.max_team_size ?? 5,
      due_date: project.due_date || null,
      allow_team_workspace: project.allow_team_workspace ?? true,
    },
  })

  const maxTeamSize = form.watch('max_team_size') ?? 5
  const isGroupProject = (maxTeamSize ?? 0) > 1

  const isDirty = form.formState.isDirty

  // Warn before leaving if there are unsaved changes
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  const onSubmit = async (data: UpdateProjectInput) => {
    setIsSubmitting(true)
    try {
      const result = await updateProject(project.id, sectionId, data)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Project updated successfully')
      // Reset the form baseline to the saved values so isDirty clears —
      // otherwise the "unsaved changes" indicator + beforeunload guard
      // linger (and block reload) after a successful save.
      form.reset(data)
    } catch {
      toast.error('Unable to save project. Check your connection and try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleArchive = async () => {
    setIsArchiving(true)
    try {
      const result = await updateProject(project.id, sectionId, { status: 'archived' })
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Project archived — students can no longer see it')
      router.refresh()
    } catch {
      toast.error('Failed to archive project')
    } finally {
      setIsArchiving(false)
    }
  }

  const handleReopen = async () => {
    setIsArchiving(true)
    try {
      const result = await updateProject(project.id, sectionId, { status: 'active' })
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Project re-opened and visible to students')
      router.refresh()
    } catch {
      toast.error('Failed to re-open project')
    } finally {
      setIsArchiving(false)
    }
  }

  const createdDate = project.created_at
    ? new Date(project.created_at).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null

  const isArchived = project.status === 'archived'

  return (
    <div className="space-y-6">
      {/* Created date */}
      {createdDate && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Calendar className="h-4 w-4" />
          Created on {createdDate}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Assignment Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input placeholder="Project title" {...field} />
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
                        placeholder="Detailed guidelines, rubric, or instructions..."
                        className="resize-none"
                        rows={4}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Separator />

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
                        <FormLabel>Team chat workspace</FormLabel>
                        <p className="text-xs text-muted-foreground">
                          When on, each team can open private #chat, #tasks, and #resources channels. Turn off to hide team chat for this project.
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

              <div className="flex items-center justify-end gap-3 pt-2">
                {isDirty && (
                  <p className="text-xs text-warning-muted-foreground">Unsaved changes</p>
                )}
                <Button type="submit" disabled={isSubmitting}>
                  <Save className="h-4 w-4 mr-2" aria-hidden="true" />
                  {isSubmitting ? 'Saving…' : 'Save Changes'}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      {/* Archive / Re-open */}
      <div className="border border-warning/30 rounded-2xl p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">
              {isArchived ? 'Re-open Project' : 'Archive Project'}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isArchived
                ? 'Make this project active again — students will be able to see and work on it.'
                : 'Close this project. Students will no longer see it in their course.'}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-warning/30 text-warning-muted-foreground hover:bg-warning-muted hover:border-warning/50"
            onClick={isArchived ? handleReopen : handleArchive}
            disabled={isArchiving}
          >
            <Archive className="h-4 w-4 mr-2" aria-hidden="true" />
            {isArchiving ? 'Updating…' : isArchived ? 'Re-open' : 'Archive'}
          </Button>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="border border-destructive/30 rounded-2xl p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-destructive">Delete Project</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Permanently remove this project and all team data. This cannot be undone.
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            className="shrink-0"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
        </div>
      </div>

      <DeleteProjectDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        sectionId={sectionId}
        projectId={project.id}
        projectTitle={project.title}
      />
    </div>
  )
}
