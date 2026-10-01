/**
 * MentionPicker — floating list of @-mention candidates (team members,
 * project phases, and project docs) shown while the user is typing an
 * @ token.
 *
 * Keyboard: ↑/↓ to move, Enter/Tab to pick, Escape to dismiss. Picker
 * shows three grouped sections (Teammates, Phases, Docs). The parent
 * (`ChatInput`) is responsible for showing/hiding and for inserting
 * the chosen candidate back into the textarea.
 */
'use client'

import { useEffect, useMemo } from 'react'
import { FileText, ListChecks, Pin } from 'lucide-react'
import type {
  TeamDocOption,
  TeamMemberOption,
  TeamPhaseOption,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/chat-actions'

export type MentionCandidate =
  | { kind: 'user'; user: TeamMemberOption }
  | { kind: 'phase'; phase: TeamPhaseOption }
  | { kind: 'doc'; doc: TeamDocOption }

interface MentionPickerProps {
  members: TeamMemberOption[]
  phases: TeamPhaseOption[]
  docs: TeamDocOption[]
  query: string
  highlightIndex: number
  onSelect: (candidate: MentionCandidate) => void
  onHighlightChange: (index: number) => void
}

export function MentionPicker({
  members,
  phases,
  docs,
  query,
  highlightIndex,
  onSelect,
  onHighlightChange,
}: MentionPickerProps) {
  // Build a single flat list — users first, then phases, then docs —
  // so the highlight cursor can move across all groups with ↑/↓.
  const flat = useMemo<MentionCandidate[]>(() => {
    const q = query.trim().toLowerCase()
    const matchedUsers = (q
      ? members.filter((m) => {
          const name = (m.name || '').toLowerCase()
          const email = m.email.toLowerCase()
          return name.includes(q) || email.includes(q)
        })
      : members
    )
      .slice(0, 6)
      .map<MentionCandidate>((u) => ({ kind: 'user', user: u }))

    const matchedPhases = (q
      ? phases.filter((p) => p.title.toLowerCase().includes(q))
      : phases
    )
      .slice(0, 6)
      .map<MentionCandidate>((p) => ({ kind: 'phase', phase: p }))

    const matchedDocs = (q
      ? docs.filter((d) => d.title.toLowerCase().includes(q))
      : docs
    )
      .slice(0, 6)
      .map<MentionCandidate>((d) => ({ kind: 'doc', doc: d }))

    return [...matchedUsers, ...matchedPhases, ...matchedDocs]
  }, [members, phases, docs, query])

  // Keep highlight in range as the filtered list changes
  useEffect(() => {
    if (flat.length === 0) return
    if (highlightIndex >= flat.length) {
      onHighlightChange(0)
    }
  }, [flat.length, highlightIndex, onHighlightChange])

  if (flat.length === 0) {
    return (
      <div className="absolute bottom-full left-0 mb-1 bg-popover border rounded-xl shadow-lg py-1.5 px-3 z-50 text-xs text-muted-foreground">
        No matches for &ldquo;{query}&rdquo;
      </div>
    )
  }

  // Find the indices where each section starts so we can insert
  // section headers at the right spots.
  const firstUserIdx = flat.findIndex((c) => c.kind === 'user')
  const firstPhaseIdx = flat.findIndex((c) => c.kind === 'phase')
  const firstDocIdx = flat.findIndex((c) => c.kind === 'doc')

  const keyOf = (candidate: MentionCandidate): string => {
    if (candidate.kind === 'user') return `user-${candidate.user.id}`
    if (candidate.kind === 'phase') return `phase-${candidate.phase.id}`
    return `doc-${candidate.doc.id}`
  }

  return (
    <div
      className="absolute bottom-full left-0 mb-1 bg-popover border rounded-xl shadow-lg py-1 z-50 min-w-[260px] max-w-[340px]"
      role="listbox"
    >
      <ul className="max-h-72 overflow-y-auto">
        {flat.map((candidate, idx) => {
          const isActive = idx === highlightIndex
          // Render section headers above the first item of each kind.
          const showTeammatesHeader = idx === firstUserIdx && idx >= 0
          const showPhasesHeader = idx === firstPhaseIdx && idx >= 0
          const showDocsHeader = idx === firstDocIdx && idx >= 0
          return (
            <li key={keyOf(candidate)}>
              {showTeammatesHeader && (
                <div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
                  Teammates
                </div>
              )}
              {showPhasesHeader && (
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold border-t mt-1">
                  Phases
                </div>
              )}
              {showDocsHeader && (
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold border-t mt-1">
                  Docs
                </div>
              )}
              <button
                type="button"
                role="option"
                aria-selected={isActive}
                onMouseDown={(e) => {
                  // mousedown not click — we need to fire BEFORE the
                  // textarea loses focus, otherwise the selection
                  // range we use for insertion collapses.
                  e.preventDefault()
                  onSelect(candidate)
                }}
                onMouseEnter={() => onHighlightChange(idx)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                  isActive ? 'bg-muted' : 'hover:bg-muted/50'
                }`}
              >
                {candidate.kind === 'user' ? (
                  <UserRow member={candidate.user} />
                ) : candidate.kind === 'phase' ? (
                  <PhaseRow phase={candidate.phase} />
                ) : (
                  <DocRow doc={candidate.doc} />
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function UserRow({ member }: { member: TeamMemberOption }) {
  const display = member.name || member.email
  const initials = (member.name || member.email).slice(0, 2).toUpperCase()
  return (
    <>
      {member.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={member.avatar_url}
          alt={display}
          className="h-6 w-6 rounded-full object-cover shrink-0"
        />
      ) : (
        <span className="h-6 w-6 rounded-full bg-muted-foreground/10 text-muted-foreground flex items-center justify-center text-[10px] font-semibold shrink-0">
          {initials}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium truncate">{display}</span>
        {member.name && (
          <span className="block text-[11px] text-muted-foreground truncate">
            {member.email}
          </span>
        )}
      </span>
    </>
  )
}

function PhaseRow({ phase }: { phase: TeamPhaseOption }) {
  return (
    <>
      <span className="h-6 w-6 rounded-xl bg-muted-foreground/10 text-muted-foreground flex items-center justify-center shrink-0">
        <ListChecks className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium truncate">{phase.title}</span>
        <span className="block text-[11px] text-muted-foreground capitalize">
          {phase.status.replace(/_/g, ' ')}
        </span>
      </span>
    </>
  )
}

function DocRow({ doc }: { doc: TeamDocOption }) {
  return (
    <>
      <span className="h-6 w-6 rounded-xl bg-muted-foreground/10 text-muted-foreground flex items-center justify-center shrink-0">
        <FileText className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium truncate">{doc.title}</span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {doc.is_pinned ? (
            <>
              <Pin className="h-3 w-3" />
              <span>Pinned</span>
            </>
          ) : (
            <span>Doc</span>
          )}
        </span>
      </span>
    </>
  )
}
