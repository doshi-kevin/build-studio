/**
 * CreateModuleDialog — Dialog for creating/editing module metadata.
 *
 * Form fields: title, description, week number, published toggle, opens-on date,
 * "not covering", notify.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
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
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  createModule,
  updateModule,
} from '@/app/(dashboard)/professor/courses/[sectionId]/modules/actions'
import { createModuleSchema, type CreateModuleInput } from '@/lib/validations/module'
import { toLocalDateInput, fromLocalDateInput } from '@/lib/datetime'
import { isUnlockPending } from '@/lib/modules/unlock'
import type { Module } from '@/lib/supabase/types'

interface CreateModuleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  module?: Module | null
}

export function CreateModuleDialog({ open, onOpenChange, sectionId, module }: CreateModuleDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  /* `disabled={isSubmitting}` alone does not stop a double-click: the flag is only
     set once this handler runs, and it runs AFTER the async zod resolver, so every
     click landing before that first re-render submits its own module. The ref closes
     that window synchronously — same guard as AssessmentRunner's submittingRef. */
  const submittingRef = useRef(false)
  const isEditMode = !!module

  const defaultValues = useMemo<CreateModuleInput>(
    () => ({
      title: module?.title || '',
      description: module?.description || '',
      week_number: module?.week_number ?? undefined,
      is_published: module?.is_published ?? true,
      unlock_date: module?.unlock_date || '',
      instructor_note: module?.instructor_note || '',
      // The column is CHECK-constrained text, so the generated type is a bare
      // `string` — narrow it here rather than widening the schema.
      coverage_state: module?.coverage_state === 'skipped' ? 'skipped' : 'active',
      notify: true,
    }),
    [module],
  )

  const form = useForm<CreateModuleInput>({
    resolver: zodResolver(createModuleSchema),
    defaultValues,
  })

  /* The create-mode instance is rendered unkeyed and stays mounted between opens, so
     without this the next "New module" opens holding the module just created. Reseeding
     on open (rather than keying the call sites) covers both create-mode instances at
     once and keeps the dialog's exit animation — same shape as ModuleDividerDialog. */
  useEffect(() => {
    if (open) form.reset(defaultValues)
  }, [open, defaultValues, form])

  // Whether the notify choice is relevant — students are only notified when a module
  // first goes live, so we surface the toggle whenever "Published" is on.
  const isPublished = useWatch({ control: form.control, name: 'is_published' })
  /* A pending open date changes what "Notify students" can honestly promise: nothing
     runs at that instant, so no notice goes out on the day. Saying so here (rather
     than leaving the old copy over the new behaviour) also points at the row control
     that DOES notify. */
  const unlockValue = useWatch({ control: form.control, name: 'unlock_date' })
  const opensLater = isUnlockPending(unlockValue)

  const onSubmit = async (data: CreateModuleInput) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setIsSubmitting(true)
    try {
      const result = isEditMode
        ? await updateModule(module!.id, sectionId, data)
        : await createModule(sectionId, data)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success(isEditMode ? 'Module updated' : 'Module created')
      onOpenChange(false)
    } catch {
      toast.error('Something went wrong')
    } finally {
      submittingRef.current = false
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit Module' : 'New Module'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Update module settings.'
              : 'Create a new learning module for your course.'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          {/* noValidate: the week field carries native min/max, and the browser's own
              constraint check blocks submit BEFORE onSubmit runs — so an out-of-range
              week made the button look dead with no message anywhere. Zod is the single
              validator; its messages render through FormMessage. */}
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title *</FormLabel>
                  <FormControl>
                    <Input placeholder="Introduction to Algorithms" {...field} />
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
                      placeholder="Brief overview of this module..."
                      className="resize-none"
                      rows={3}
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
                name="week_number"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Week Number</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={52}
                        placeholder="1"
                        {...field}
                        value={field.value ?? ''}
                        onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : null)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="is_published"
                render={({ field }) => (
                  <FormItem className="flex items-end gap-2 pb-0.5">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <FormLabel className="!mt-0 cursor-pointer">Published</FormLabel>
                  </FormItem>
                )}
              />
            </div>

            {/* Opens-on. Only meaningful once Published: an unlock date on a draft
                promises students a week they can't see at all. Clearing the field is
                how a professor opens it early — there is no separate override, so
                the date can never contradict what students actually see.

                A DATE input, not datetime-local: that control reports `value === ''`
                for a partial entry, and its picker fills the day while leaving the
                time blank — so "pick Aug 6, save" silently stored nothing and
                reported success, publishing the week immediately. Day precision is
                also what students are shown ("Opens Aug 6"), so the two now agree. */}
            {isPublished && (
              <FormField
                control={form.control}
                name="unlock_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Opens to students on</FormLabel>
                    <div className="flex items-center gap-2">
                      <FormControl>
                        <Input
                          type="date"
                          className="flex-1"
                          value={toLocalDateInput(field.value)}
                          onChange={(e) => field.onChange(fromLocalDateInput(e.target.value))}
                        />
                      </FormControl>
                      {/* The copy used to say "clear this field", but browsers render no
                          clear affordance for a date input — emptying it means focusing
                          and backspacing each segment. Without this button the dialog
                          couldn't perform its own instruction. */}
                      {field.value && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => field.onChange(null)}
                        >
                          Open now
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {field.value
                        ? 'Until that morning the module stays off the students’ modules page, and their roadmap shows it dimmed as “not open yet” with nothing inside.'
                        : 'Leave empty to open it as soon as it’s published. Set a date to keep a week you’ve prepared ahead closed until you teach it.'}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="coverage_state"
              render={({ field }) => (
                <FormItem className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 p-3">
                  <FormControl>
                    <Checkbox
                      checked={field.value === 'skipped'}
                      onCheckedChange={(v) => field.onChange(v ? 'skipped' : 'active')}
                      className="mt-0.5"
                    />
                  </FormControl>
                  <div className="space-y-0.5">
                    <FormLabel className="!mt-0 cursor-pointer">Not covering this module</FormLabel>
                    {/* Kevin's feedback (#629): the old copy ran three ideas together in one
                        sentence and led with the mechanism ("leaves this module out of the
                        roadmap's progress") rather than the outcome. Lead with what it does
                        for them, then the one thing people get wrong, which is confusing this
                        with Published. */}
                    <p className="text-xs text-muted-foreground">
                      Keeps this module out of your progress percentage, so material you never
                      planned to teach can&apos;t hold the course back.{' '}
                      {isPublished
                        ? 'Students can still see it.'
                        : 'This is separate from Published, so publishing it still shows it to students.'}
                    </p>
                  </div>
                </FormItem>
              )}
            />

            {isPublished && (
              <FormField
                control={form.control}
                name="notify"
                render={({ field }) => (
                  <FormItem className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 p-3">
                    <FormControl>
                      <Checkbox
                        checked={field.value ?? true}
                        onCheckedChange={field.onChange}
                        className="mt-0.5"
                      />
                    </FormControl>
                    <div className="space-y-0.5">
                      <FormLabel className="!mt-0 cursor-pointer">Notify students</FormLabel>
                      <p className="text-xs text-muted-foreground">
                        {opensLater
                          ? 'Students aren’t notified automatically on the open date. Use “Open to students now” on the module row when you’re ready — they’ll be notified then.'
                          : 'Send students a notification when this module goes live. Turn off to publish silently.'}
                      </p>
                    </div>
                  </FormItem>
                )}
              />
            )}

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? (isEditMode ? 'Updating…' : 'Creating…')
                  : (isEditMode ? 'Update Module' : 'Create Module')}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
