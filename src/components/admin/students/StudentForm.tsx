/**
 * StudentForm — form for creating a new student.
 *
 * Uses react-hook-form + zod resolver for client-side validation.
 * Organized in 2 sections:
 * 1. Account Info: first name, last name, email, CWID (8-digit student ID)
 * 2. Additional Details: department (optional), phone
 *
 * Does NOT show the password — the server auto-generates it and returns it
 * via the onSuccess callback for the parent dialog to display.
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
import { createStudent } from '@/app/(dashboard)/admin/students/actions'
import {
  createStudentSchema,
  type CreateStudentInput,
} from '@/lib/validations/student'

interface Department {
  id: string
  name: string
  code: string
}

interface StudentFormProps {
  /** Available departments for the dropdown */
  departments: Department[]
  /** Called after successful creation with email delivery status */
  onSuccess?: (result: { emailSent: boolean }) => void
  /** Called when user clicks Cancel */
  onCancel?: () => void
}

export function StudentForm({ departments, onSuccess, onCancel }: StudentFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<CreateStudentInput>({
    resolver: zodResolver(createStudentSchema),
    defaultValues: {
      email: '',
      first_name: '',
      last_name: '',
      cwid: '',
      department_id: '',
      phone: '',
      status: 'active',
    },
  })

  const onSubmit = async (data: CreateStudentInput) => {
    setIsSubmitting(true)
    try {
      const result = await createStudent(data)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      onSuccess?.({ emailSent: !!result.emailSent })
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
            <FormField
              control={form.control}
              name="cwid"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>CWID (Student ID) *</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="12345678"
                      maxLength={8}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    8-digit Campus-Wide ID — used as the student&apos;s login ID
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Section 2: Additional Details */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Additional Details</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="department_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Department</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select department (optional)" />
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
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone</FormLabel>
                  <FormControl>
                    <Input placeholder="+1 (555) 000-0000" {...field} />
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
            {isSubmitting ? 'Creating Student...' : 'Add Student'}
          </Button>
        </div>
      </form>
    </Form>
  )
}
