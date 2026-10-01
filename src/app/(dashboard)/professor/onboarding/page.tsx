/**
 * Professor Onboarding Page — server component that loads professor data
 * and renders the onboarding form. Redirects to /professor if already completed.
 */

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { profileQueries } from '@/lib/supabase/queries'
import { createAdminClient } from '@/lib/supabase/admin'
import { ProfessorOnboardingForm } from '@/components/professor/onboarding/ProfessorOnboardingForm'

export default async function ProfessorOnboardingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  const profile = await profileQueries.getProfileById(supabase, user.id)
  if (!profile || profile.role !== 'professor') return null

  /* Already completed onboarding — go to dashboard */
  if (profile.onboarding_completed === true) {
    redirect('/professor')
  }

  /* Fetch primary department faculty record for pre-filling */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: faculty } = await adminDb
    .from('department_faculty')
    .select('*, departments(name, code)')
    .eq('professor_id', user.id)
    .eq('is_primary_department', true)
    .single()

  const departmentName = faculty?.departments
    ? (Array.isArray(faculty.departments) ? faculty.departments[0] : faculty.departments)?.name
    : null

  return (
    <div className="flex items-start justify-center min-h-[80vh] px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Welcome to Scholera</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Complete your profile to get started
            {departmentName ? ` in the ${departmentName} department` : ''}.
            All fields are optional — you can update them later.
          </p>
        </div>
        <ProfessorOnboardingForm
          existingData={{
            phone: profile.phone || '',
            title: faculty?.title || '',
            office_location: faculty?.office_location || '',
            office_hours: faculty?.office_hours || '',
            office_phone: faculty?.office_phone || '',
            bio: faculty?.bio || '',
            research_interests: faculty?.research_interests || '',
            website_url: faculty?.website_url || '',
            linkedin_url: faculty?.linkedin_url || '',
          }}
        />
      </div>
    </div>
  )
}
