// Student notetaker panel. Rich-text notes for the session, autosaved as the
// student types. Reuses the app's shared Novel/TipTap editor (AnnouncementEditor)
// so formatting matches the rest of Scholera: select text for the bubble menu
// (bold/italic/underline/link/color), '/' for headings & lists, and the native
// ⌘/Ctrl+B/I/U keyboard shortcuts.
//
// Presentational: the draft, autosave, and load state are owned by useLiveNotes
// (so they survive the sidebar tab unmounting on switch and are reused on the
// insights page). The Novel editor is uncontrolled — it seeds from
// getInitialContent() once per mount and reports edits via onChange.

'use client'

import { useState } from 'react'
import { NotebookPen, Loader2, Check, CloudOff } from 'lucide-react'
import type { JSONContent } from 'novel'
import { AnnouncementEditor } from '@/components/professor/announcements/AnnouncementEditor'
import type { NoteSaveState } from '@/lib/live-classroom/notes/use-notes'

interface Props {
  getInitialContent: () => JSONContent | null
  onChange: (json: JSONContent) => void
  saveState: NoteSaveState
  loaded: boolean
  // 'sidebar' (default) matches the live classroom wing's cards; 'page' matches
  // the insights page's card stack (border + bg-card) so it doesn't stand out.
  variant?: 'sidebar' | 'page'
}

function SaveIndicator({ saveState }: { saveState: NoteSaveState }) {
  if (saveState === 'saving') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving…
      </span>
    )
  }
  if (saveState === 'saved') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check className="h-3 w-3" />
        Saved
      </span>
    )
  }
  if (saveState === 'error') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <CloudOff className="h-3 w-3" />
        Couldn&apos;t save — keep typing to retry
      </span>
    )
  }
  return null
}

// Mounts only once notes are loaded, so the editor seeds from the latest draft.
function NotesRichEditor({
  getInitialContent,
  onChange,
}: {
  getInitialContent: () => JSONContent | null
  onChange: (json: JSONContent) => void
}) {
  // Capture once at mount — Novel applies initialContent only at init.
  const [seed] = useState(getInitialContent)
  return <AnnouncementEditor initialContent={seed} onChange={onChange} />
}

export function LiveNotesEditor({ getInitialContent, onChange, saveState, loaded, variant = 'sidebar' }: Props) {
  const cardClass =
    variant === 'page'
      ? 'rounded-2xl border border-border bg-card overflow-hidden'
      : 'rounded-3xl ring-1 ring-border/50 shadow-sm bg-background overflow-hidden'
  return (
    <section className={cardClass}>
      {variant === 'sidebar' ? (
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <NotebookPen className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
              My notes
            </h3>
          </div>
          <SaveIndicator saveState={saveState} />
        </header>
      ) : (
        // On the insights page the SectionLabel above is the heading; keep just
        // the save status here, reserving height so the editor doesn't jump.
        <div className="flex justify-end px-4 pt-3 min-h-5">
          <SaveIndicator saveState={saveState} />
        </div>
      )}
      <div className="p-4">
        {loaded ? (
          <NotesRichEditor getInitialContent={getInitialContent} onChange={onChange} />
        ) : (
          <div className="flex items-center gap-2 px-1 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading your notes…
          </div>
        )}
      </div>
    </section>
  )
}
