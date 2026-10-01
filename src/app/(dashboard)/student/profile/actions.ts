/**
 * Student Profile Actions — update bio, links, and avatar.
 *
 * Actions:
 * - updateStudentProfile: Save bio, linkedin, github to settings.profile JSONB
 * - updateAvatar: Upload avatar to storage, save URL to profiles.avatar_url
 * - removeAvatar: Delete avatar from storage, clear profiles.avatar_url
 *
 * Uses admin client for DB writes (bypasses RLS).
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import {
  studentProfileSchema,
  type StudentProfileInput,
} from '@/lib/validations/student-profile'

const AVATARS_BUCKET = 'avatars'

async function verifyStudent() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { error: 'Not authenticated' as const }

  const profile = await profileQueries.getProfileById(supabase, user.id)
  if (!profile || profile.role !== 'student') {
    return { error: 'Unauthorized — student access required' as const }
  }

  return { userId: user.id, profile }
}

/**
 * Update student profile text fields (bio, linkedin, github).
 */
export async function updateStudentProfile(
  input: StudentProfileInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const auth = await verifyStudent()
    if ('error' in auth) return { error: auth.error }

    const parsed = studentProfileSchema.safeParse(input)
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors
      const firstError = Object.values(fieldErrors).flat()[0]
      return { error: firstError || 'Invalid input' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: current } = await adminDb
      .from('profiles')
      .select('settings')
      .eq('id', auth.userId)
      .single()

    const currentSettings = (current?.settings as Record<string, unknown>) || {}
    const updatedSettings = {
      ...currentSettings,
      profile: {
        bio: parsed.data.bio || '',
        linkedinUrl: parsed.data.linkedinUrl || '',
        githubUrl: parsed.data.githubUrl || '',
      },
    }

    const { error: updateError } = await adminDb
      .from('profiles')
      .update({ settings: updatedSettings, updated_at: new Date().toISOString() })
      .eq('id', auth.userId)

    if (updateError) {
      logger.error('updateStudentProfile: Update failed', updateError)
      return { error: 'Failed to save profile' }
    }

    logEvent({
      userId: auth.userId,
      eventType: 'student.profile_updated',
      metadata: { fields: Object.keys(parsed.data) },
    })

    revalidatePath('/student/profile')
    revalidatePath('/dashboard')

    return { success: true }
  } catch (error) {
    logger.error('updateStudentProfile', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Upload a new avatar image. Accepts base64 data URL.
 */
export async function updateAvatar(
  base64Data: string,
  mimeType: string,
): Promise<{ success?: boolean; avatarUrl?: string; error?: string }> {
  try {
    const auth = await verifyStudent()
    if ('error' in auth) return { error: auth.error }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    if (!allowedTypes.includes(mimeType)) {
      return { error: 'Invalid image format. Use JPEG, PNG, WebP, or GIF.' }
    }

    // Decode base64
    const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '')
    const buffer = Buffer.from(base64, 'base64')

    if (buffer.length > 5 * 1024 * 1024) {
      return { error: 'Image must be under 5 MB' }
    }

    const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1]
    const filePath = `${auth.userId}/avatar_${Date.now()}.${ext}`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Delete old avatar if exists
    if (auth.profile.avatar_url) {
      const oldPath = extractStoragePath(auth.profile.avatar_url)
      if (oldPath) {
        await adminDb.storage.from(AVATARS_BUCKET).remove([oldPath])
      }
    }

    // Upload new avatar
    const { error: uploadError } = await adminDb.storage
      .from(AVATARS_BUCKET)
      .upload(filePath, buffer, {
        contentType: mimeType,
        cacheControl: '3600',
        upsert: true,
      })

    if (uploadError) {
      logger.error('updateAvatar: Upload failed', uploadError)
      const msg = uploadError.message?.includes('not found')
        ? 'Storage bucket "avatars" not found. Create it in Supabase Dashboard → Storage.'
        : 'Failed to upload image'
      return { error: msg }
    }

    const { data: urlData } = adminDb.storage
      .from(AVATARS_BUCKET)
      .getPublicUrl(filePath)

    const avatarUrl = urlData.publicUrl

    // Update profile
    const { error: updateError } = await adminDb
      .from('profiles')
      .update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() })
      .eq('id', auth.userId)

    if (updateError) {
      logger.error('updateAvatar: Profile update failed', updateError)
      return { error: 'Failed to update profile' }
    }

    logEvent({
      userId: auth.userId,
      eventType: 'student.avatar_updated',
    })

    revalidatePath('/student/profile')
    revalidatePath('/dashboard')

    return { success: true, avatarUrl }
  } catch (error) {
    logger.error('updateAvatar', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Remove the current avatar.
 */
export async function removeAvatar(): Promise<{ success?: boolean; error?: string }> {
  try {
    const auth = await verifyStudent()
    if ('error' in auth) return { error: auth.error }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    if (auth.profile.avatar_url) {
      const oldPath = extractStoragePath(auth.profile.avatar_url)
      if (oldPath) {
        await adminDb.storage.from(AVATARS_BUCKET).remove([oldPath])
      }
    }

    const { error: updateError } = await adminDb
      .from('profiles')
      .update({ avatar_url: null, updated_at: new Date().toISOString() })
      .eq('id', auth.userId)

    if (updateError) {
      logger.error('removeAvatar: Update failed', updateError)
      return { error: 'Failed to remove avatar' }
    }

    logEvent({
      userId: auth.userId,
      eventType: 'student.avatar_removed',
    })

    revalidatePath('/student/profile')
    revalidatePath('/dashboard')

    return { success: true }
  } catch (error) {
    logger.error('removeAvatar', error)
    return { error: 'Unexpected error' }
  }
}

/** Extract storage path from a full public URL */
function extractStoragePath(url: string): string | null {
  const match = url.match(/\/storage\/v1\/object\/public\/avatars\/(.+)$/)
  return match?.[1] || null
}
