// Simplified professor invite form — 6 fields only.
// Admin provides name, email, department, position, and employment type.
// Professor fills in remaining details (office, bio, etc.) during onboarding.

'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
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
import { createProfessor } from '@/app/(dashboard)/admin/professors/actions'
import {
  inviteProfessorSchema,
  POSITIONS,
  POSITION_LABELS,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  type InviteProfessorInput,
} from '@/lib/validations/professor'

interface Department {
  id: string
  name: string
  code: string
}

interface ProfessorFormProps {
  departments: Department[]
  defaultDepartmentId?: string
  onSuccess?: () => void
  onCancel?: () => void
}

export function ProfessorForm({ departments, defaultDepartmentId, onSuccess, onCancel }: ProfessorFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<InviteProfessorInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(inviteProfessorSchema) as any,
    defaultValues: {
      email: '',
      first_name: '',
      last_name: '',
      department_id: defaultDepartmentId || '',
      position: 'professor',
      employment_type: 'full_time',
    },
  })

  const onSubmit = async (data: InviteProfessorInput) => {
    setIsSubmitting(true)
    try {
      const result = await createProfessor(data)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      if ('emailWarning' in result && result.emailWarning) {
        toast.warning(result.emailWarning, { duration: 8000 })
      } else {
        toast.success('Professor invited — invite email sent')
      }
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
        {/* Section 1: Account Information */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Account Information</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="first_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>First Name *</FormLabel>
                  <FormControl>
                    <Input placeholder="John" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="last_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Last Name *</FormLabel>
                  <FormControl>
                    <Input placeholder="Doe" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="sm:col-span-2">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email *</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="jdoe@university.edu" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </div>
        </div>

        {/* Section 2: Department Assignment */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Department Assignment</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
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
            </div>
            <FormField
              control={form.control}
              name="position"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Position *</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select position" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {POSITIONS.map((pos) => (
                        <SelectItem key={pos} value={pos}>
                          {POSITION_LABELS[pos]}
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
              name="employment_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Employment Type *</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {EMPLOYMENT_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {EMPLOYMENT_TYPE_LABELS[type]}
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

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Sending Invite...' : 'Invite Professor'}
          </Button>
        </div>
      </form>
    </Form>
  )
}
