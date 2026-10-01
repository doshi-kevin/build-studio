/**
 * AboutMeSection — editable bio textarea with character counter.
 *
 * View mode: shows bio text or placeholder.
 * Edit mode: textarea with 300 char limit + live counter.
 *
 * Type: Client Component
 */
'use client'

import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'

const MAX_BIO_LENGTH = 300

interface AboutMeSectionProps {
  bio: string
  isEditing: boolean
  onChange: (bio: string) => void
}

export function AboutMeSection({ bio, isEditing, onChange }: AboutMeSectionProps) {
  if (!isEditing) {
    if (!bio) return null
    return (
      <div>
        <h3 className="text-sm font-semibold mb-2">About Me</h3>
        <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
          {bio}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="bio" className="text-sm font-medium">About Me</Label>
      <Textarea
        id="bio"
        value={bio}
        onChange={(e) => onChange(e.target.value.slice(0, MAX_BIO_LENGTH))}
        placeholder="Write a short bio about yourself..."
        rows={4}
        maxLength={MAX_BIO_LENGTH}
        className="resize-none"
      />
      <p className="text-xs text-muted-foreground text-right">
        {bio.length}/{MAX_BIO_LENGTH}
      </p>
    </div>
  )
}
