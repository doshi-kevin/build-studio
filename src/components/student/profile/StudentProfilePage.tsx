'use client'

// Student profile page — edit bio, professional links, and change password.
// Read-only fields (name, email, CWID) are shown but not editable by students.

import { useState, useTransition } from 'react'
import { Pencil, Save, X, Loader2, User, Link2, KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/professor/PageHeader'
import { ProfilePhoto } from './ProfilePhoto'
import { AboutMeSection } from './AboutMeSection'
import { ProfessionalLinks } from './ProfessionalLinks'
import { ChangePasswordSection } from './ChangePasswordSection'
import { updateStudentProfile } from '@/app/(dashboard)/student/profile/actions'
import { studentProfileSchema, type StudentProfileData } from '@/lib/validations/student-profile'
import type { Profile } from '@/lib/supabase/types'

interface StudentProfilePageProps {
  profile: Profile
  profileData: StudentProfileData
}

export function StudentProfilePage({ profile, profileData }: StudentProfilePageProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [isPending, startTransition] = useTransition()

  const [bio, setBio] = useState(profileData.bio)
  const [linkedinUrl, setLinkedinUrl] = useState(profileData.linkedinUrl)
  const [githubUrl, setGithubUrl] = useState(profileData.githubUrl)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const initials = (profile.name || profile.email || 'U')
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase()

  const handleEdit = () => { setIsEditing(true); setErrors({}) }

  const handleCancel = () => {
    setBio(profileData.bio)
    setLinkedinUrl(profileData.linkedinUrl)
    setGithubUrl(profileData.githubUrl)
    setErrors({})
    setIsEditing(false)
  }

  const handleSave = () => {
    const input = {
      bio: bio.trim(),
      linkedinUrl: linkedinUrl.trim(),
      githubUrl: githubUrl.trim(),
    }
    const parsed = studentProfileSchema.safeParse(input)
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {}
      for (const [key, messages] of Object.entries(parsed.error.flatten().fieldErrors)) {
        if (messages?.[0]) fieldErrors[key] = messages[0]
      }
      setErrors(fieldErrors)
      return
    }
    setErrors({})
    // Use the parsed (normalized) values — e.g. a bare "linkedin.com/in/me" becomes
    // "https://…" — so we save and locally reflect an absolute URL (view-mode renders
    // it as a link; a bare domain would be a broken relative href).
    const normalized = {
      bio: parsed.data.bio ?? '',
      linkedinUrl: parsed.data.linkedinUrl ?? '',
      githubUrl: parsed.data.githubUrl ?? '',
    }
    startTransition(async () => {
      const result = await updateStudentProfile(normalized)
      if (result.error) {
        toast.error(result.error)
      } else {
        setBio(normalized.bio)
        setLinkedinUrl(normalized.linkedinUrl)
        setGithubUrl(normalized.githubUrl)
        toast.success('Profile updated')
        setIsEditing(false)
      }
    })
  }

  const hasContent = bio || linkedinUrl || githubUrl

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <PageHeader
        title="My Profile"
        description="Manage your personal info and public links."
        actions={
          !isEditing ? (
            <Button variant="outline" size="sm" onClick={handleEdit} className="gap-1.5">
              <Pencil className="h-3.5 w-3.5" />
              Edit Profile
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleCancel} disabled={isPending} className="gap-1.5">
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={isPending} className="gap-1.5">
                {isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save
              </Button>
            </div>
          )
        }
      />

      {/* Identity card */}
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center gap-2 mb-5">
          <User className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Identity</h2>
          <span className="text-xs text-muted-foreground ml-auto">Managed by your institution</span>
        </div>
        <div className="flex flex-col sm:flex-row items-center sm:items-start gap-5">
          <ProfilePhoto
            avatarUrl={profile.avatar_url}
            initials={initials}
            isEditing={isEditing}
          />
          <div className="text-center sm:text-left space-y-1">
            <h2 className="text-lg font-semibold">{profile.name || 'Student'}</h2>
            <p className="text-sm text-muted-foreground">{profile.email}</p>
            {profile.cwid && (
              <p className="text-xs font-mono text-muted-foreground bg-muted inline-block px-2 py-0.5 rounded mt-1">
                CWID: {profile.cwid}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* About Me */}
      {(isEditing || bio) && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-2 mb-5">
            <User className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">About Me</h2>
          </div>
          <AboutMeSection bio={bio} isEditing={isEditing} onChange={setBio} />
          {errors.bio && (
            <p className="text-xs text-destructive mt-2">{errors.bio}</p>
          )}
        </div>
      )}

      {/* Professional Links */}
      {(isEditing || linkedinUrl || githubUrl) && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-2 mb-5">
            <Link2 className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Professional Links</h2>
          </div>
          <ProfessionalLinks
            linkedinUrl={linkedinUrl}
            githubUrl={githubUrl}
            isEditing={isEditing}
            onLinkedinChange={setLinkedinUrl}
            onGithubChange={setGithubUrl}
            errors={errors}
          />
        </div>
      )}

      {/* Empty state hint */}
      {!isEditing && !hasContent && (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            Your profile is looking empty.{' '}
            <button onClick={handleEdit} className="font-medium text-foreground underline underline-offset-4">
              Add a bio and links
            </button>
          </p>
        </div>
      )}

      {/* Change Password */}
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center gap-2 mb-5">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Security</h2>
        </div>
        <ChangePasswordSection email={profile.email} />
      </div>
    </div>
  )
}
