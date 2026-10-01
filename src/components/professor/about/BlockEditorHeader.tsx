// Page-header for the About page editor.
// Course meta, autosave status, and an Edit/Preview toggle.
// Block insertion lives at the bottom of the canvas as a single persistent
// "+ Add section" button — fewer top-level controls, less to learn.
//
// Heading rule: the page must carry exactly one <h1>, and it must be the course
// title. Which element owns it depends on what is on screen:
//   - preview, hero has a title  -> HeroBlockPreview owns the h1; this header is
//                                   a quiet eyebrow, not a heading.
//   - edit mode                  -> the hero renders as form inputs and has no
//                                   heading, so this header owns the h1.
//   - hero has no title          -> nothing else can own it, so this header does.
// Before this, "About" here and the course title in the hero were BOTH <h1>, on
// the professor page and the student page alike.

'use client'

import { Pencil, Eye, RefreshCw, Check, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useBlockEditor } from './block-editor'
import type { SaveStatus } from './AboutPageBuilder'

interface Props {
  courseInfo: {
    code: string
    title: string
    department?: string
    credits?: number
    semester?: string
    instructor?: string
  }
  saveStatus?: SaveStatus
}

export function BlockEditorHeader({ courseInfo, saveStatus = 'idle' }: Props) {
  const { isEditing, setIsEditing, state } = useBlockEditor()

  const hero = state.blocks.find((b) => b.type === 'hero')
  const heroTitle = hero?.type === 'hero' ? hero.data.title.trim() : ''
  const ownsHeading = isEditing || !heroTitle
  const headingText = heroTitle || courseInfo.title || 'About'

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {ownsHeading ? (
          <h1 className="text-2xl font-semibold tracking-tight text-foreground truncate">
            {headingText}
          </h1>
        ) : (
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            About
          </p>
        )}
        <p className="text-sm text-muted-foreground mt-1 truncate">
          {courseInfo.code} &mdash; {courseInfo.title}
          {courseInfo.department && ` · ${courseInfo.department}`}
          {courseInfo.credits != null && ` · ${courseInfo.credits} credits`}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {/* Autosave status — quiet, only meaningful in edit mode. A sync glyph
            reads as "automatically saving" (spinning while in flight), a check
            confirms saved, an alert flags failure. */}
        {isEditing && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {saveStatus === 'saving' && (
              <><RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Saving…</>
            )}
            {saveStatus === 'saved' && (
              <><Check className="h-3.5 w-3.5 text-success-muted-foreground" aria-hidden="true" />Saved</>
            )}
            {saveStatus === 'error' && (
              <><AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />Save failed</>
            )}
            {saveStatus === 'idle' && (
              <><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Auto-saves</>
            )}
          </span>
        )}

        {isEditing ? (
          <Button variant="outline" size="sm" onClick={() => setIsEditing(false)} className="rounded-full">
            <Eye className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
            View as student
          </Button>
        ) : (
          <Button size="sm" onClick={() => setIsEditing(true)} className="rounded-full">
            <Pencil className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
            Edit page
          </Button>
        )}
      </div>
    </div>
  )
}
