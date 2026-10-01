/**
 * ModulesViewToggle — Tiles or List, in the page header.
 *
 * In the header's `actions` slot rather than the search toolbar: the layout is a
 * property of the whole page, while the toolbar's controls all narrow WHAT is
 * shown. Follows the same outline ToggleGroup idiom the Warehouse and Calendar
 * toolbars use for view switching.
 *
 * Type: Client Component
 */
'use client'

import { LayoutGrid, List } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { type ModulesView } from '@/lib/hooks/use-modules-view'

interface ModulesViewToggleProps {
  view: ModulesView
  onViewChange: (view: ModulesView) => void
}

export function ModulesViewToggle({ view, onViewChange }: ModulesViewToggleProps) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={view}
      /* Radix clears the value when the ACTIVE item is re-clicked, so fall back to
         the layout we're already in — not to a default. Falling back to
         DEFAULT_MODULES_VIEW ('list') meant a reader in Tiles who clicked Tiles
         again, or pressed Space on the focused radio, was dropped into the list
         and had it persisted. A filter facet has a meaningful "off" (see
         ModulesToolbar, where this same shape is correct); a layout mode doesn't. */
      onValueChange={(value) => onViewChange((value as ModulesView) || view)}
      aria-label="Module layout"
    >
      {/* No aria-label on the items: it would replace the visible word with a
          longer one, and the group above already says what the choice is. */}
      {/* min-h, not h: size="sm" puts h-8 (32px) on each item, and min-height
          wins over height in CSS, so this lifts the touch target to the 44px
          floor the walkthrough asks for without fighting utility order. Scoped
          to below sm: so the desktop toolbar keeps its compact 32px. */}
      <ToggleGroupItem value="tile" className="min-h-11 sm:min-h-0">
        <LayoutGrid className="h-4 w-4" aria-hidden />
        Tiles
      </ToggleGroupItem>
      <ToggleGroupItem value="list" className="min-h-11 sm:min-h-0">
        <List className="h-4 w-4" aria-hidden />
        List
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
