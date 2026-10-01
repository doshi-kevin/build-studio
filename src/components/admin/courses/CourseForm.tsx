/**
 * CourseForm — create/edit form for courses.
 *
 * Uses react-hook-form + zod resolver for client-side validation.
 * Works in two modes:
 * - Create mode (course prop is null): empty form, calls createCourse
 * - Edit mode (course prop provided): pre-filled form, calls updateCourse
 *
 * The department_id is always provided as a prop since courses belong to a department.
 * Shows toast notifications for success/error via sonner.
 *
 * Type: Client Component (needs react-hook-form state)
 */
'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { createCourse, updateCourse } from '@/app/(dashboard)/admin/departments/course-actions'
import { createCourseSchema, DEFAULT_COURSE_CREDITS, type CreateCourseInput } from '@/lib/validations/course'

/** The course fields this form edits — the shape the table row already carries. */
export interface EditableCourse {
  id: string
  code: string
  title: string
  description: string | null
  credits: number | null
  prerequisites: string | null
  status: string
  /* The row's updated_at when this form was rendered. Sent back with the save
     so a stale write is refused instead of overwriting someone else's edit
     (#724). Optional so a caller that hasn't been threaded through yet still
     compiles — it just doesn't get the guard. */
  updated_at?: string | null
}

interface CourseFormProps {
  /** The department this course belongs to */
  departmentId: string
  /** Department code (e.g. "CS") — rendered as a static prefix on the Course Code input */
  departmentCode: string
  /** If provided, form opens in edit mode with pre-filled values */
  course?: EditableCourse | null
  /** Called after a successful create/update */
  onSuccess?: () => void
  /** Called when user clicks Cancel */
  onCancel?: () => void
}

/** Strip a leading "{prefix}-" from a code so the user only edits the suffix.
 *  Falls back to the original string for legacy codes that don't have the prefix
 *  (e.g. "506") — the user can keep editing them as-is, no surprise reformatting. */
function suffixFor(code: string, prefix: string): string {
  const upper = code.toUpperCase()
  const expected = `${prefix.toUpperCase()}-`
  return upper.startsWith(expected) ? upper.slice(expected.length) : upper
}

export function CourseForm({ departmentId, departmentCode, course, onSuccess, onCancel }: CourseFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isEditMode = !!course
  const prefix = departmentCode.toUpperCase()
  const [codeSuffix, setCodeSuffix] = useState(course?.code ? suffixFor(course.code, prefix) : '')

  const form = useForm<CreateCourseInput>({
    resolver: zodResolver(createCourseSchema),
    defaultValues: {
      department_id: departmentId,
      code: course?.code || '',
      title: course?.title || '',
      description: course?.description || '',
      // Pre-filled rather than left blank behind a "3" placeholder, so what the
      // admin sees is what gets stored (issue #138).
      credits: course?.credits ?? DEFAULT_COURSE_CREDITS,
      prerequisites: course?.prerequisites || '',
      status: (course?.status as 'active' | 'inactive' | 'archived') || 'active',
    },
  })

  const onSubmit = async (data: CreateCourseInput) => {
    setIsSubmitting(true)
    try {
      const result = isEditMode
        ? await updateCourse(course!.id, departmentId, data, course!.updated_at)
        : await createCourse(data)

      if ('error' in result && result.error) {
        /* A stale-write conflict has to stay on screen: it asks the reader to copy
           their edits and reload, and a toast that auto-dismisses leaves them
           staring at a filled-in form with no reason why nothing saved (or, worse,
           assuming it did). Every other error keeps the default duration. */
        toast.error(result.error, 'conflict' in result && result.conflict ? { duration: Infinity } : undefined)
        return
      }

      toast.success(isEditMode ? 'Course updated' : 'Course created')
      onSuccess?.()
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {/* Code + Title — side by side */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="code"
            render={() => (
              <FormItem>
                <FormLabel>Course Code *</FormLabel>
                <FormControl>
                  <div className="flex items-stretch rounded-md border border-input bg-background ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 overflow-hidden">
                    <span className="flex items-center px-3 bg-muted/50 text-muted-foreground font-mono text-sm border-r border-input select-none">
                      {prefix}-
                    </span>
                    <Input
                      placeholder="556"
                      value={codeSuffix}
                      onChange={(e) => {
                        const next = e.target.value.toUpperCase()
                        setCodeSuffix(next)
                        form.setValue('code', next ? `${prefix}-${next}` : '', { shouldValidate: true })
                      }}
                      className="border-0 rounded-none focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none uppercase"
                      inputMode="numeric"
                    />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Title *</FormLabel>
                <FormControl>
                  <Input placeholder="Natural Language Processing" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Credits + Status — side by side */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="credits"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Credits</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    placeholder="3"
                    {...field}
                    value={field.value ?? ''}
                    onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Description */}
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Brief description of the course..."
                  className="resize-none"
                  rows={3}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Prerequisites */}
        <FormField
          control={form.control}
          name="prerequisites"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Prerequisites</FormLabel>
              <FormControl>
                <Input placeholder="CS-501, CS-520 or equivalent" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? (isEditMode ? 'Updating...' : 'Creating...')
              : (isEditMode ? 'Update Course' : 'Create Course')}
          </Button>
        </div>
      </form>
    </Form>
  )
}
