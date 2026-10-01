// Professor onboarding form — collects remaining profile details after invite acceptance.
// Password is already set via SetPasswordDialog before this wizard loads, so it's not
// part of this form. All fields here are optional; professors can fill what they have
// or click "Skip for now" and edit from settings later.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { completeOnboarding } from '@/app/(dashboard)/professor/onboarding/actions'
import {
  professorOnboardingSchema,
  type ProfessorOnboardingInput,
} from '@/lib/validations/professor-onboarding'

interface ProfessorOnboardingFormProps {
  existingData: ProfessorOnboardingInput
}

export function ProfessorOnboardingForm({ existingData }: ProfessorOnboardingFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const router = useRouter()

  const form = useForm<ProfessorOnboardingInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(professorOnboardingSchema) as any,
    defaultValues: existingData,
  })

  const onSubmit = async (data: ProfessorOnboardingInput) => {
    setIsSubmitting(true)
    try {
      const result = await completeOnboarding(data)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Profile completed — welcome to Scholera!')
      router.push('/professor')
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSkip = async () => {
    setIsSubmitting(true)
    try {
      const result = await completeOnboarding({})

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Welcome to Scholera! You can update your profile anytime.')
      router.push('/professor')
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Section 1: Personal */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Personal information</CardTitle>
            <CardDescription>How students and staff will see and reach you.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input placeholder="Dr., Prof., etc." {...field} />
                    </FormControl>
                    <FormDescription>Shown before your name across the platform.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone number</FormLabel>
                    <FormControl>
                      <Input placeholder="+1 (555) 123-4567" {...field} />
                    </FormControl>
                    <FormDescription>Optional. Only visible to your institution.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </CardContent>
        </Card>

        {/* Section 2: Professional */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Professional details</CardTitle>
            <CardDescription>Help students learn about your background and work.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-5">
              <FormField
                control={form.control}
                name="bio"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bio</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Brief professional biography…"
                        className="min-h-[120px]"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>Appears on your public course pages.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="research_interests"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Research interests</FormLabel>
                    <FormControl>
                      <Input placeholder="Machine Learning, Data Science, NLP" {...field} />
                    </FormControl>
                    <FormDescription>Comma-separated topics you focus on.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <FormField
                  control={form.control}
                  name="website_url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Website</FormLabel>
                      <FormControl>
                        <Input placeholder="https://example.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="linkedin_url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>LinkedIn</FormLabel>
                      <FormControl>
                        <Input placeholder="https://linkedin.com/in/…" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
          <Button
            type="button"
            variant="ghost"
            onClick={handleSkip}
            disabled={isSubmitting}
          >
            Skip for now
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Complete profile'}
          </Button>
        </div>
      </form>
    </Form>
  )
}
