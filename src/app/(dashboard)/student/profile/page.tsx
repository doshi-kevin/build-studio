/**
 * Student Profile Page — server component that fetches profile data.
 *
 * Reads the current user's profile and settings, passes to StudentProfilePage client component.
 *
 * Type: Server Component
 */

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { StudentProfilePage } from '@/components/student/profile/StudentProfilePage'
import { parseStudentProfile } from '@/lib/validations/student-profile'
import type { Profile } from '@/lib/supabase/types'

export default async function StudentProfile() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (error || !profile) {
    logger.error('StudentProfile: Failed to fetch profile', error)
    redirect('/dashboard')
  }

  const typedProfile = profile as Profile
  const profileData = parseStudentProfile(typedProfile.settings as Record<string, unknown>)

  logger.debug('StudentProfile: Rendering', { userId: user.id })

  return <StudentProfilePage profile={typedProfile} profileData={profileData} />
}
