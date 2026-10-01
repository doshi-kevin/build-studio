/**
 * ProfessorModuleSection — one module: a collapsible section of items.
 *
 * Collapsed is the default across a whole semester of modules, so the header
 * has to be self-describing: week, title, and what's inside ("3 readings,
 * 1 deck"). The week sits ABOVE the title rather than in a side rail — the
 * rail only rendered for modules that had a week, which left the list with
 * two different left edges.
 *
 * Type: Client Component
 */
'use client'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CalendarClock, ChevronDown, ChevronRight, GripVertical, Loader2, Lock, Pencil, Plus, Trash2, Unlock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { isUnlockPending, unlockLabel } from '@/lib/modules/unlock'
import { sectionContentsSummary, FOCUS_RING } from '@/components/shared/modules/module-item-display'
import { ProfessorModuleItemRow } from './ProfessorModuleItemRow'
import { AddItemPopover } from './AddItemPopover'
import { SECTION_ACTIONS, ICON_BUTTON, RowAction } from './ModuleRowActions'
import type { PrimerState } from './PrimerControl'
import type { ModuleItemType } from '@/lib/validations/module'
import type { Module, ModuleItem } from '@/lib/supabase/types'

interface ProfessorModuleSectionProps {
  module: Module
  items: ModuleItem[]
  sectionId: string
  expanded: boolean
  onToggle: () => void
  /** Read-only student preview: no controls, hidden items already filtered. */
  studentPreview: boolean
  /** Whether this section can be dragged. False when the list on screen isn't
   *  the real curriculum order — see the board's `reorderable`. */
  reorderable: boolean
  primersEnabled?: boolean
  primerStates?: Record<string, PrimerState>
  onEditModule: () => void
  onDeleteModule: () => void
  onTogglePublish: () => void
  /** Clear `unlock_date` — the whole of "unlock it early" (see lib/modules/unlock). */
  onOpenNow: () => void
  onAddItem: (type: ModuleItemType) => void
  onEditItem: (item: ModuleItem) => void
  onDeleteItem: (item: ModuleItem) => void
  onToggleItemVisibility: (item: ModuleItem) => void
  filtering: boolean
  /** id of the row/section currently mid-save, if any */
  pendingId?: string | null
  deepLinkItemId?: string | null
  deepLinkPage?: number
}

export function ProfessorModuleSection({
  module: mod,
  items,
  sectionId,
  expanded,
  onToggle,
  studentPreview,
  reorderable,
  primersEnabled,
  primerStates,
  onEditModule,
  onDeleteModule,
  onTogglePublish,
  onOpenNow,
  onAddItem,
  onEditItem,
  onDeleteItem,
  onToggleItemVisibility,
  filtering,
  pendingId,
  deepLinkItemId,
  deepLinkPage,
}: ProfessorModuleSectionProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: mod.id,
    data: { type: 'module' },
    disabled: !reorderable,
  })
  const style = { transform: CSS.Transform.toString(transform), transition }

  const summary = sectionContentsSummary(items)
  const contentCount = items.filter((i) => i.item_type !== 'section_divider').length
  const hiddenCount = items.filter((i) => !i.is_visible).length
  const panelId = `module-panel-${mod.id}`
  const headerId = `module-header-${mod.id}`
  const summaryText = summary || (contentCount === 0 ? 'Empty' : `${contentCount} items`)
  /* A date already in the past is spent, not state worth a chip — the module is
     simply open, exactly as if the field were empty. Nor does a DRAFT get one:
     students can't see it either way, so "opens Aug 6" would be a second, quieter
     answer to a question the Draft badge has already answered. */
  const unlockPending = mod.is_published === true && isUnlockPending(mod.unlock_date)
  const unlockChip = unlockLabel(mod.unlock_date)
  /* While a content filter is live the board forces sections open, so the
     disclosure isn't the user's to control — make it inert rather than
     silently recording a toggle that applies once the filter clears. */
  const toggleLocked = filtering
  const showGrip = reorderable && pendingId !== mod.id
  const showSpinner = !studentPreview && pendingId === mod.id
  /* Nothing occupies the leading slot — pad the header so the list keeps one
     left edge whether or not a grip is there to drag. */
  const padForMissingGrip = !showGrip && !showSpinner

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group/section overflow-hidden rounded-2xl border border-border bg-card transition duration-200 ease-out hover:border-ring/40',
        isDragging && 'opacity-50 shadow-lg ring-2 ring-ring/30',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pb-2 pr-3 sm:flex-nowrap sm:pb-0">
        {showSpinner && (
          <span className="py-4 pl-3 text-muted-foreground" aria-live="polite" aria-label="Saving">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          </span>
        )}
        {showGrip && (
          <button
            type="button"
            aria-label={`Reorder ${mod.title}`}
            className={cn(
              "flex cursor-grab text-muted-foreground/40 transition-colors hover:text-muted-foreground active:cursor-grabbing",
              "min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 items-center justify-center py-4 pl-3",
              FOCUS_RING,
            )}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" aria-hidden />
          </button>
        )}

        <button
          type="button"
          id={headerId}
          onClick={toggleLocked ? undefined : onToggle}
          aria-expanded={expanded}
          aria-disabled={toggleLocked || undefined}
          {...(expanded ? { 'aria-controls': panelId } : {})}
          className={cn(
            'flex min-w-0 flex-1 basis-0 items-center gap-3 py-4 text-left',
            FOCUS_RING,
            padForMissingGrip && 'pl-5',
          )}
        >
          <ChevronRight
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
              expanded && 'rotate-90',
              toggleLocked && 'opacity-40',
            )}
            aria-hidden
          />

          <div className="min-w-0 flex-1">
            {mod.week_number !== null && (
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Week {mod.week_number}
              </p>
            )}
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-foreground">{mod.title}</h3>
              {!studentPreview && !mod.is_published && (
                <Badge
                  variant="outline"
                  className="shrink-0 border-warning/40 bg-warning-muted text-warning-muted-foreground"
                >
                  Draft
                </Badge>
              )}
              {/* Independent of Draft, not a replacement for it: a skipped module can still
                  be published as optional reading. It drops the module from BOTH sides of
                  the roadmap's delivery percentage, so it has to be visible where modules
                  are managed — otherwise the only way to tell is to open the edit dialog,
                  and the roadmap number looks wrong for no visible reason. */}
              {!studentPreview && mod.coverage_state === 'skipped' && (
                <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
                  Not covering
                </Badge>
              )}
              {/* In preview the interactive chip is gone with the rest of the
                  controls, and a closed week holds no items — so without this the row
                  would read "Empty" and look like a week the professor forgot to fill
                  rather than one students can't open yet. A span, not a button: this
                  sits inside the header button. */}
              {studentPreview && unlockPending && (
                <Badge variant="outline" className="shrink-0 gap-1 font-normal text-muted-foreground">
                  <Lock className="h-3 w-3" aria-hidden />
                  <span suppressHydrationWarning>{unlockChip}</span>
                </Badge>
              )}
            </div>
            {mod.description && (
              <p className="line-clamp-1 text-xs text-muted-foreground">{mod.description}</p>
            )}
            {/* On phones the summary drops to its own line rather than being
                hidden — "what's in here?" is the only reason to collapse. */}
            <p className="flex flex-wrap items-center gap-2 text-xs tabular-nums text-muted-foreground sm:hidden">
              {summaryText}
              {!studentPreview && hiddenCount > 0 && (
                <Badge variant="outline" className="shrink-0 font-normal tabular-nums">
                  {hiddenCount} hidden
                </Badge>
              )}
            </p>
          </div>

          <div className="hidden shrink-0 items-center gap-2 text-xs text-muted-foreground sm:flex">
            {!studentPreview && hiddenCount > 0 && (
              <Badge variant="outline" className="shrink-0 font-normal tabular-nums">
                {hiddenCount} hidden
              </Badge>
            )}
            <span className="tabular-nums">{summaryText}</span>
          </div>
        </button>

        {/* Publishing a draft is the professor's key decision on this screen, so
            it stays visible at rest. Once published the state is already legible
            (no Draft badge) and unpublishing is rare, so that control joins the
            quiet hover cluster instead of shouting on every row. */}
        {!studentPreview && (
          <div className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:min-w-64">
            {/* Published, but not open to students yet. The chip IS the control:
                clicking it offers the two things wanted here — open it now, or move
                the date — without leaving the row. Visible at rest rather than in
                the hover cluster, because it is state as much as an action, and it
                sits OUTSIDE the header button: a button inside a button is invalid
                HTML that the parser unnests, which cost a real hydration error. */}
            {unlockPending && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${unlockChip} — change when ${mod.title} opens to students`}
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 rounded-full border border-input bg-muted/60',
                      'px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors',
                      'hover:bg-muted hover:text-foreground',
                      FOCUS_RING,
                    )}
                  >
                    {/* Glyph + chevron, because this pill sits inches from two
                        read-only badges ("N hidden", "Draft") that share its shape.
                        A dashed border was carrying that distinction at 1.19:1 —
                        imperceptible at 12px — so the icons do the work instead and
                        visually tie the chip to the menu item it opens. */}
                    <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                    {/* The date is formatted in the reader's own timezone, so the
                        server's string and the browser's can differ by a day when
                        the instant sits near midnight. The client's is the right
                        one to keep. */}
                    <span suppressHydrationWarning>{unlockChip}</span>
                    <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={onOpenNow}>
                    <Unlock className="mr-2 h-4 w-4" aria-hidden />
                    Open to students now
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onEditModule}>
                    <CalendarClock className="mr-2 h-4 w-4" aria-hidden />
                    Change the date…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {!mod.is_published && (
              <Button variant="outline" size="xs" onClick={onTogglePublish}>
                Publish
              </Button>
            )}
            <div className={SECTION_ACTIONS}>
              {mod.is_published && (
                <Button variant="secondary" size="xs" onClick={onTogglePublish}>
                  Published
                </Button>
              )}
              <AddItemPopover onSelect={onAddItem}>
                <button
                  type="button"
                  aria-label={`Add material to ${mod.title}`}
                  title={`Add material to ${mod.title}`}
                  className={cn(ICON_BUTTON, "hover:bg-muted hover:text-foreground")}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                </button>
              </AddItemPopover>
              <RowAction icon={Pencil} label={`Edit ${mod.title}`} onClick={onEditModule} />
              <RowAction
                icon={Trash2}
                label={`Delete ${mod.title}`}
                onClick={onDeleteModule}
                destructive
              />
            </div>
          </div>
        )}
      </div>

      {expanded && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={headerId}
          className="border-t border-border/60"
        >
          {items.length > 0 ? (
            <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
              <div className="divide-y divide-border/50">
                {items.map((item) => (
                  <ProfessorModuleItemRow
                    key={item.id}
                    item={item}
                    moduleId={mod.id}
                    sectionId={sectionId}
                    primersEnabled={primersEnabled}
                    primerState={primerStates?.[item.id]}
                    studentPreview={studentPreview}
                    reorderable={reorderable}
                    pending={pendingId === item.id}
                    openAtPage={deepLinkItemId === item.id ? deepLinkPage : undefined}
                    onEdit={() => onEditItem(item)}
                    onDelete={() => onDeleteItem(item)}
                    onToggleVisibility={() => onToggleItemVisibility(item)}
                  />
                ))}
              </div>
            </SortableContext>
          ) : (
            <div className="px-5 py-6 text-center">
              <p className="text-xs text-muted-foreground">
                {filtering
                  ? 'Nothing in this module matches your search.'
                  : studentPreview
                    ? 'Students see nothing in this module yet.'
                    : 'Nothing in this module yet.'}
              </p>
              {!filtering && !studentPreview && (
                <AddItemPopover onSelect={onAddItem}>
                  <Button variant="outline" size="sm" className="mt-3">
                    <Plus className="h-4 w-4" aria-hidden />
                    Add material
                  </Button>
                </AddItemPopover>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
