/**
 * ProgramForm — form for creating a new academic program.
 *
 * Uses react-hook-form + zod resolver for client-side validation.
 * Organized in 3 sections:
 * 1. Program Information: name, code, degree_type, status
 * 2. Department & Director: department_id, director_id (optional)
 * 3. Details: total_credits, duration_semesters, description
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { createProgram, updateProgram } from '@/app/(dashboard)/admin/programs/actions'
import {
  createProgramSchema,
  DEGREE_TYPES,
  DEGREE_TYPE_LABELS,
  PROGRAM_STATUSES,
  PROGRAM_STATUS_LABELS,
  type CreateProgramInput,
} from '@/lib/validations/program'

interface Department {
  id: string
  name: string
  code: string
}

interface Professor {
  id: string
  name: string
  email: string
}

interface ProgramFormProps {
  /** Available departments for the dropdown */
  departments: Department[]
  /** Available professors for the director dropdown */
  professors: Professor[]
  /**
   * If provided, the form opens in EDIT mode and saves through updateProgram.
   * Programs previously had no edit surface at all — `updateProgram` existed with
   * zero callers, so a typo in a name or code was permanent and the only recourse
   * was delete-and-recreate, which cascades to the program's courses (#725).
   *
   * `updated_at` rides along so the save can be refused if someone else changed
   * the row first (#724) rather than silently overwriting them.
   */
  program?: {
    id: string
    name: string
    code: string
    degree_type: string
    status: string
    department_id: string
    director_id: string | null
    description: string | null
    total_credits: number | null
    duration_semesters: number | null
    updated_at?: string | null
  } | null
  /** Called after successful creation */
  onSuccess?: () => void
  /** Called when user clicks Cancel */
  onCancel?: () => void
}

export function ProgramForm({ departments, professors, program, onSuccess, onCancel }: ProgramFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isEditMode = !!program

  const form = useForm<CreateProgramInput>({
    /* Same schema in both modes: createProgramSchema is the full shape, and the
       edit action parses the partial itself, so validating everything here keeps
       the form's own rules (code format, credit ranges) identical either way. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createProgramSchema) as any,
    defaultValues: {
      name: program?.name ?? '',
      code: program?.code ?? '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      degree_type: (program?.degree_type as any) ?? undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: (program?.status as any) ?? 'active',
      department_id: program?.department_id ?? '',
      director_id: program?.director_id ?? '',
      description: program?.description ?? '',
      total_credits: program?.total_credits ?? undefined,
      duration_semesters: program?.duration_semesters ?? undefined,
    },
  })

  const onSubmit = async (data: CreateProgramInput) => {
    setIsSubmitting(true)
    try {
      /* Convert string values from number inputs to actual numbers */
      const submitData: CreateProgramInput = {
        ...data,
        total_credits: data.total_credits
          ? Number(data.total_credits)
          : undefined,
        duration_semesters: data.duration_semesters
          ? Number(data.duration_semesters)
          : undefined,
        director_id: data.director_id || undefined,
      }

      const result = isEditMode
        ? await updateProgram(program!.id, submitData, program!.updated_at)
        : await createProgram(submitData)

      if ('error' in result && result.error) {
        /* A stale-write conflict has to stay on screen: it asks the reader to copy
           their edits and reload, and a toast that auto-dismisses leaves them
           staring at a filled-in form with no reason why nothing saved (or, worse,
           assuming it did). Every other error keeps the default duration. */
        toast.error(result.error, 'conflict' in result && result.conflict ? { duration: Infinity } : undefined)
        return
      }

      toast.success(isEditMode ? 'Program updated' : 'Program created successfully')
      onSuccess?.()
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Section 1: Program Information */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Program Information</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Program Name *</FormLabel>
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
                    <Input placeholder="CS-BS" {...field} />
                  </FormControl>
                  <FormDescription>
                    Unique program code (letters, numbers, hyphens)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="degree_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Degree Type *</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select degree type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {DEGREE_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {DEGREE_TYPE_LABELS[type]}
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
                      {PROGRAM_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {PROGRAM_STATUS_LABELS[status]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Section 2: Department & Director */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Department & Director</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="department_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Department *</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select department" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {departments.map((dept) => (
                        <SelectItem key={dept.id} value={dept.id}>
                          {dept.code} — {dept.name}
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
              name="director_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Program Director</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="None (optional)" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="">None</SelectItem>
                      {professors.map((prof) => (
                        <SelectItem key={prof.id} value={prof.id}>
                          {prof.name || prof.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Section 3: Details */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Details</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="total_credits"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Total Credits</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="120"
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) => {
                        const val = e.target.value
                        field.onChange(val === '' ? undefined : Number(val))
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="duration_semesters"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Duration (Semesters)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="8"
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) => {
                        const val = e.target.value
                        field.onChange(val === '' ? undefined : Number(val))
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <div className="mt-4">
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Describe the program objectives, curriculum highlights, and career opportunities..."
                      rows={4}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
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
              ? isEditMode
                ? 'Saving…'
                : 'Creating…'
              : isEditMode
                ? 'Save changes'
                : 'Add Program'}
          </Button>
        </div>
      </form>
    </Form>
  )
}
