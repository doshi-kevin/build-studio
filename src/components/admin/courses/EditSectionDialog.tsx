/**
 * EditSectionDialog — modal for editing an existing course section.
 *
 * Admin can update professor, section letter, semester, year, modality,
 * capacity, and status. Uses the updateAssignment server action.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { z } from 'zod'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  SEMESTERS,
  SEMESTER_LABELS,
  MODALITIES,
  MODALITY_LABELS,
  SECTION_STATUSES,
  SECTION_STATUS_LABELS,
} from '@/lib/validations/course-assignment'
import { updateAssignment } from '@/app/(dashboard)/admin/courses/actions'

const editSectionSchema = z.object({
  professor_id: z.string().uuid('Select a professor'),
  section_code: z.string().min(1, 'Section letter is required').max(10, 'Max 10 characters').trim().toUpperCase(),
  semester: z.enum(['fall', 'spring', 'summer', 'winter']),
  year: z.number().int().min(2020).max(2050),
  modality: z.enum(['in_person', 'online', 'hybrid']).optional(),
  max_students: z.number().int().min(1).max(500).optional(),
  status: z.enum(['draft', 'active', 'inactive', 'archived', 'cancelled']),
})

type EditSectionInput = z.infer<typeof editSectionSchema>

interface Professor {
  id: string
  name: string
  email: string
}

interface SectionData {
  id: string
  section_code: string
  semester: string
  year: number
  modality: string | null
  max_students: number | null
  status: string
  professor: Professor | Professor[] | null
}

interface EditSectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  section: SectionData
  courseName: string
  professors: Professor[]
}

function resolveProf(prof: Professor | Professor[] | null): Professor | null {
  if (!prof) return null
  return Array.isArray(prof) ? prof[0] ?? null : prof
}

export function EditSectionDialog({ open, onOpenChange, section, courseName, professors }: EditSectionDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const prof = resolveProf(section.professor)

  const form = useForm<EditSectionInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(editSectionSchema) as any,
    defaultValues: {
      professor_id: prof?.id ?? '',
      section_code: section.section_code ?? '',
      semester: (section.semester as EditSectionInput['semester']) ?? 'fall',
      year: section.year ?? new Date().getFullYear(),
      modality: (section.modality as EditSectionInput['modality']) ?? 'in_person',
      max_students: section.max_students ?? 50,
      status: (section.status as EditSectionInput['status']) ?? 'active',
    },
  })

  const onSubmit = async (data: EditSectionInput) => {
    setIsSubmitting(true)
    try {
      const result = await updateAssignment(section.id, {
        section_code: data.section_code,
        semester: data.semester,
        year: data.year,
        modality: data.modality,
        max_students: data.max_students,
        status: data.status,
      })
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Section updated')
      onOpenChange(false)
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Edit Section {section.section_code}</DialogTitle>
          <DialogDescription>
            Update section details for <span className="font-medium">{courseName}</span>.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Professor (read-only display) */}
            <FormField
              control={form.control}
              name="professor_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Professor</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Assign a professor" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {professors.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} · {p.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Section Letter */}
            <FormField
              control={form.control}
              name="section_code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Section Letter *</FormLabel>
                  <FormControl>
                    <Input placeholder="A, B, C..." maxLength={10} {...field} className="uppercase" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Semester + Year */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="semester"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Semester *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {SEMESTERS.map((s) => (
                          <SelectItem key={s} value={s}>{SEMESTER_LABELS[s]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="year"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Year *</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} onChange={(e) => field.onChange(Number(e.target.value))} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Modality + Capacity */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="modality"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Modality</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {MODALITIES.map((m) => (
                          <SelectItem key={m} value={m}>{MODALITY_LABELS[m]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="max_students"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Max Students</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        value={field.value ?? 50}
                        onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : 50)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Status */}
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {SECTION_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>{SECTION_STATUS_LABELS[s]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
