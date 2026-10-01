/**
 * ModulesToolbar — search + type facet for the Modules surfaces.
 *
 * Presentational only: it owns no filtering logic and knows nothing about
 * roles, so both the professor and student boards can use it. The professor
 * board passes `statusFilter` to get the extra Published/Draft facet and
 * `trailing` for its Student View toggle.
 *
 * Follows the established toolbar idiom (announcements, quizzes, warehouse):
 * a flex-1 search wrapper with an absolutely-positioned icon, then outline
 * ToggleGroups, stacking on mobile.
 *
 * Type: Client Component
 */
'use client'

import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  ITEM_FILTER_LABELS,
  ITEM_FILTER_TYPES,
  FOCUS_RING,
  type ItemFilterType,
} from './module-item-display'

export const MODULE_STATUS_FILTERS = ['all', 'published', 'draft'] as const
export type ModuleStatusFilter = (typeof MODULE_STATUS_FILTERS)[number]

const STATUS_LABELS: Record<ModuleStatusFilter, string> = {
  all: 'All',
  published: 'Published',
  draft: 'Drafts',
}

interface ModulesToolbarProps {
  query: string
  onQueryChange: (value: string) => void
  type: ItemFilterType
  onTypeChange: (value: ItemFilterType) => void
  /** Professor only — omit to hide the publish-state facet entirely. */
  status?: ModuleStatusFilter
  onStatusChange?: (value: ModuleStatusFilter) => void
  /** Extra control pinned to the end of the row (e.g. Student View). */
  trailing?: React.ReactNode
  placeholder?: string
}

export function ModulesToolbar({
  query,
  onQueryChange,
  type,
  onTypeChange,
  status,
  onStatusChange,
  trailing,
  placeholder = 'Search materials…',
}: ModulesToolbarProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          aria-label="Search course materials"
          className="pl-9"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label="Clear search"
            className={cn(
              "absolute inset-y-0 right-1 my-auto flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              "h-9 w-11 sm:h-6 sm:w-6 sm:right-2",
              FOCUS_RING,
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={type}
          /* Radix clears the value when the active item is re-clicked; keep a
             facet always selected so the list can't land in a blank state. */
          onValueChange={(value) => onTypeChange((value || 'all') as ItemFilterType)}
          className="shrink-0"
        >
          {ITEM_FILTER_TYPES.map((key) => (
            <ToggleGroupItem key={key} value={key} aria-label={`Show ${ITEM_FILTER_LABELS[key]}`}>
              {ITEM_FILTER_LABELS[key]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {status !== undefined && onStatusChange && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={status}
            onValueChange={(value) => onStatusChange((value || 'all') as ModuleStatusFilter)}
            className="shrink-0"
          >
            {MODULE_STATUS_FILTERS.map((key) => (
              <ToggleGroupItem key={key} value={key} aria-label={`Show ${STATUS_LABELS[key]} modules`}>
                {STATUS_LABELS[key]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}

        {trailing}
      </div>
    </div>
  )
}
