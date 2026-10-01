/**
 * ProfessionalLinks — LinkedIn and GitHub URL fields.
 *
 * View mode: clickable icons (hidden if empty).
 * Edit mode: text inputs with URL validation feedback.
 *
 * Type: Client Component
 */
'use client'

import { Github, Linkedin } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface ProfessionalLinksProps {
  linkedinUrl: string
  githubUrl: string
  isEditing: boolean
  onLinkedinChange: (url: string) => void
  onGithubChange: (url: string) => void
  errors?: { linkedinUrl?: string; githubUrl?: string }
}

export function ProfessionalLinks({
  linkedinUrl,
  githubUrl,
  isEditing,
  onLinkedinChange,
  onGithubChange,
  errors,
}: ProfessionalLinksProps) {
  if (!isEditing) {
    if (!linkedinUrl && !githubUrl) return null

    return (
      <div>
        <h3 className="text-sm font-semibold mb-3">Links</h3>
        <div className="flex gap-3">
          {linkedinUrl && (
            <a
              href={linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <Linkedin className="h-4 w-4" />
              LinkedIn
            </a>
          )}
          {githubUrl && (
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <Github className="h-4 w-4" />
              GitHub
            </a>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="linkedin" className="text-sm font-medium flex items-center gap-1.5">
          <Linkedin className="h-3.5 w-3.5" />
          LinkedIn URL
        </Label>
        <Input
          id="linkedin"
          type="url"
          value={linkedinUrl}
          onChange={(e) => onLinkedinChange(e.target.value)}
          placeholder="https://linkedin.com/in/your-profile"
        />
        {errors?.linkedinUrl && (
          <p className="text-xs text-destructive">{errors.linkedinUrl}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="github" className="text-sm font-medium flex items-center gap-1.5">
          <Github className="h-3.5 w-3.5" />
          GitHub URL
        </Label>
        <Input
          id="github"
          type="url"
          value={githubUrl}
          onChange={(e) => onGithubChange(e.target.value)}
          placeholder="https://github.com/your-username"
        />
        {errors?.githubUrl && (
          <p className="text-xs text-destructive">{errors.githubUrl}</p>
        )}
      </div>
    </div>
  )
}
