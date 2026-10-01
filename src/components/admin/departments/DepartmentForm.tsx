/**
 * DepartmentForm — create/edit form for departments.
 *
 * Uses react-hook-form + zod resolver for client-side validation.
 * Works in two modes:
 * - Create mode (department prop is null): empty form, calls createDepartment
 * - Edit mode (department prop provided): pre-filled form, calls updateDepartment
 *
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
import { createDepartment, updateDepartment } from '@/app/(dashboard)/admin/departments/actions'
import { createDepartmentSchema, type CreateDepartmentInput } from '@/lib/validations/department'

interface DepartmentFormProps {
  /** If provided, form opens in edit mode with pre-filled values */
  department?: {
    id: string
    name: string
    code: string
    description: string | null
    office_location: string | null
    contact_email: string | null
    contact_phone: string | null
    status: string
    /* The row's updated_at when this form was rendered. Sent back with the save
       so a stale write is refused instead of overwriting someone else's edit
       (#724). Optional so an un-threaded caller still compiles. */
    updated_at?: string | null
  } | null
  /** Called after a successful create/update */
  onSuccess?: () => void
  /** Called when user clicks Cancel */
  onCancel?: () => void
}

export function DepartmentForm({ department, onSuccess, onCancel }: DepartmentFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isEditMode = !!department

  const form = useForm<CreateDepartmentInput>({
    resolver: zodResolver(createDepartmentSchema),
    defaultValues: {
      name: department?.name || '',
      code: department?.code || '',
      description: department?.description || '',
      office_location: department?.office_location || '',
      contact_email: department?.contact_email || '',
      contact_phone: department?.contact_phone || '',
      status: (department?.status as 'active' | 'inactive') || 'active',
    },
  })

  const onSubmit = async (data: CreateDepartmentInput) => {
    setIsSubmitting(true)
    try {
      const result = isEditMode
        ? await updateDepartment(department!.id, data, department!.updated_at)
        : await createDepartment(data)

      if ('error' in result && result.error) {
        /* A stale-write conflict has to stay on screen: it asks the reader to copy
           their edits and reload, and a toast that auto-dismisses leaves them
           staring at a filled-in form with no reason why nothing saved (or, worse,
           assuming it did). Every other error keeps the default duration. */
        toast.error(result.error, 'conflict' in result && result.conflict ? { duration: Infinity } : undefined)
        return
      }

      toast.success(isEditMode ? 'Department updated' : 'Department created')
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
        {/* Name + Code — side by side */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Department Name *</FormLabel>
                <FormControl>
                  <Input placeholder="Computer Science" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="code"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Code *</FormLabel>
                <FormControl>
                  <Input placeholder="CS" {...field} className="uppercase" />
                </FormControl>
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
                  placeholder="Brief description of the department..."
                  className="resize-none"
                  rows={3}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Office Location + Contact Email */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="office_location"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Office Location</FormLabel>
                <FormControl>
                  <Input placeholder="Building A, Room 301" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="contact_email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Contact Email</FormLabel>
                <FormControl>
                  <Input type="email" placeholder="cs-dept@university.edu" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Phone + Status */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="contact_phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Contact Phone</FormLabel>
                <FormControl>
                  <Input placeholder="+1 (201) 555-0100" {...field} />
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
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

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
              : (isEditMode ? 'Update Department' : 'Create Department')}
          </Button>
        </div>
      </form>
    </Form>
  )
}
