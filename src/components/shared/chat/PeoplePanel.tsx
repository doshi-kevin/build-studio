// People panel — scrollable list of users in a section or team.
// Clicking a row opens a direct-message thread. Unread badges surface
// unseen DM counts. Sorting: unread first, then by last DM interaction
// (most recent at top), then alphabetically.
'use client'

import { useMemo } from 'react'
import { Loader2, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PersonOption } from '@/app/(dashboard)/dms/actions'

interface PeoplePanelProps {
  people: PersonOption[]
  loading: boolean
  activeUserId?: string | null
  onSelect: (userId: string) => void
  /** Header label — defaults to "People". */
  label?: string
  /** Empty-state subtitle. */
  emptyText?: string
}

export function PeoplePanel({
  people,
  loading,
  activeUserId,
  onSelect,
  label = 'People',
  emptyText = 'No one else here yet.',
}: PeoplePanelProps) {
  const totalUnread = useMemo(
    () => people.reduce((sum, p) => sum + (p.unread_count || 0), 0),
    [people],
  )

  const sorted = useMemo(() => {
    return [...people].sort((a, b) => {
      const aUnread = a.unread_count || 0
      const bUnread = b.unread_count || 0
      if (aUnread > 0 && bUnread === 0) return -1
      if (bUnread > 0 && aUnread === 0) return 1

      const aTime = a.last_dm_at ? new Date(a.last_dm_at).getTime() : 0
      const bTime = b.last_dm_at ? new Date(b.last_dm_at).getTime() : 0
      if (aTime !== bTime) return bTime - aTime

      return (a.name || a.email).localeCompare(b.name || b.email)
    })
  }, [people])

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 px-3 pt-3 pb-1 flex items-center gap-1.5">
        <Users className="h-3 w-3 text-foreground/50" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/70">
          {label}
        </span>
        {totalUnread > 0 && (
          <span className="ml-1 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold px-1">
            {totalUnread}
          </span>
        )}
        {!loading && (
          <span className="ml-auto text-[10px] text-foreground/40">
            {people.length}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-4 shrink-0">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : people.length === 0 ? (
        <div className="px-4 py-2 flex items-start gap-2 text-muted-foreground shrink-0">
          <Users className="h-3 w-3 mt-0.5 shrink-0" />
          <p className="text-xs leading-snug">{emptyText}</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 pt-0.5 space-y-px">
          {sorted.map((p) => (
            <PersonRow
              key={p.id}
              person={p}
              isActive={p.id === activeUserId}
              onClick={() => onSelect(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PersonRow({
  person,
  isActive,
  onClick,
}: {
  person: PersonOption
  isActive: boolean
  onClick: () => void
}) {
  const displayName = person.name || person.email
  const initials = displayName.slice(0, 2).toUpperCase()
  const unread = person.unread_count || 0
  const roleLabel =
    person.role === 'professor'
      ? 'Prof'
      : person.role === 'lead'
        ? 'Lead'
        : person.role === 'ta'
          ? 'TA'
          : person.role === 'grader'
            ? 'Grader'
            : null

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-[color,background-color,box-shadow] duration-150 text-left',
        isActive
          ? 'bg-primary/10 text-primary font-semibold shadow-sm ring-1 ring-primary/10'
          : unread > 0
            ? 'text-foreground font-semibold hover:bg-muted'
            : 'text-foreground/80 hover:bg-muted hover:text-foreground',
      )}
      title={displayName}
    >
      {person.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={person.avatar_url}
          alt={displayName}
          className="h-6 w-6 rounded-full object-cover shrink-0"
        />
      ) : (
        <div
          className={cn(
            'h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0',
            isActive
              ? 'bg-primary/15 text-primary'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {initials}
        </div>
      )}
      <span className="truncate flex-1 text-[13px]">{displayName}</span>
      {unread > 0 && !isActive && (
        <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold px-1 shrink-0">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
      {roleLabel && (
        <span
          className={cn(
            'text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0',
            isActive
              ? 'bg-primary/15 text-primary'
              : 'bg-muted-foreground/10 text-muted-foreground',
          )}
        >
          {roleLabel}
        </span>
      )}
    </button>
  )
}
