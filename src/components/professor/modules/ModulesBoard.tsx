/**
 * ModulesBoard — every module and its materials on one page.
 *
 * Replaces the old overview → editor drill-in. The overview could only ever
 * say "11 items", so finding a specific PDF meant opening modules one at a
 * time; search now spans the whole course and a collapsed section states what
 * it holds. The retired /modules/[moduleId] route redirects here.
 *
 * Drag-and-drop uses ONE DndContext with two sortable groups, routed by
 * `active.data.current.type` — nesting DndContexts makes drag events bubble
 * into the parent and choke.
 *
 * Type: Client Component
 */
'use client'

import { useState, useCallback, useEffect, useMemo, useRef, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { ChevronDown, Eye, EyeOff, Layers, Loader2, Plus, SearchX, SeparatorHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { PageHeader } from '@/components/professor/PageHeader'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ModulesToolbar, type ModuleStatusFilter } from '@/components/shared/modules/ModulesToolbar'
import {
  itemMatches,
  isFiltering,
  type ItemFilterType,
} from '@/components/shared/modules/module-item-display'
import { useModuleExpansion } from '@/lib/hooks/use-module-expansion'
import { isUnlockPending, lockedModuleIds } from '@/lib/modules/unlock'
import { ProfessorModuleSection } from './ProfessorModuleSection'
import type { PrimerState } from './PrimerControl'
import { CreateModuleDialog } from './CreateModuleDialog'
import { DeleteModuleDialog } from './DeleteModuleDialog'
import { EditItemDialog } from './EditItemDialog'
import { ModuleDividerRow } from './ModuleDividerRow'
import { ModuleDividerDialog } from './ModuleDividerDialog'
import { DividerRule } from '@/components/shared/modules/DividerRule'
import {
  mergeModuleRows,
  dropEmptyDividerGroups,
  dividerRestoreOrder,
  type ModuleDivider,
  type ModuleRow,
} from '@/components/shared/modules/module-rows'
import {
  createModuleDivider,
  deleteModuleDivider,
  reorderModules,
  reorderModuleItems,
  moveModuleItem,
  updateModule,
  updateModuleItem,
  deleteModuleItem,
  type ModuleListEntry,
} from '@/app/(dashboard)/professor/courses/[sectionId]/modules/actions'
import type { ModuleItemType } from '@/lib/validations/module'
import type { Module, ModuleItem } from '@/lib/supabase/types'

interface ModulesBoardProps {
  sectionId: string
  modules: Module[]
  dividers: ModuleDivider[]
  itemsByModule: Record<string, ModuleItem[]>
  primersEnabled?: boolean
  primerStates?: Record<string, PrimerState>
}

type BoardRow = ModuleRow<Module>

export function ModulesBoard({
  sectionId,
  modules,
  dividers,
  itemsByModule,
  primersEnabled,
  primerStates,
}: ModulesBoardProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [query, setQuery] = useState('')
  const [type, setType] = useState<ItemFilterType>('all')
  const [status, setStatus] = useState<ModuleStatusFilter>('all')
  const [studentPreview, setStudentPreview] = useState(false)

  const [createOpen, setCreateOpen] = useState(searchParams.get('action') === 'create')
  const [editModule, setEditModule] = useState<Module | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Module | null>(null)
  const [unpublishTarget, setUnpublishTarget] = useState<Module | null>(null)
  const [deleteItemTarget, setDeleteItemTarget] = useState<{
    item: ModuleItem
    moduleId: string
  } | null>(null)
  const [publishMenuFor, setPublishMenuFor] = useState<Module | null>(null)

  const [itemDialogModuleId, setItemDialogModuleId] = useState<string | null>(null)
  const [itemDialogType, setItemDialogType] = useState<ModuleItemType | null>(null)
  const [editItem, setEditItem] = useState<ModuleItem | null>(null)

  const [dividerOpen, setDividerOpen] = useState(false)
  const [editDivider, setEditDivider] = useState<ModuleDivider | null>(null)
  /* the divider just created (or restored) — the row scrolls to it and rings
     briefly, because it appends at the END of a list taller than the viewport */
  const [justAdded, setJustAdded] = useState<string | null>(null)
  useEffect(() => {
    if (!justAdded) return
    const t = setTimeout(() => setJustAdded(null), 2600)
    return () => clearTimeout(t)
  }, [justAdded])

  const [isSaving, startTransition] = useTransition()
  /* Which row/section is mid-save. The summary-line indicator is off-screen
     the moment you act on anything below the fold, which is most of a
     12-module course — so the affordance has to travel to the row itself. */
  const [pendingId, setPendingId] = useState<string | null>(null)

  const runMutation = useCallback((id: string, action: () => Promise<{ error?: string }>) => {
    setPendingId(id)
    startTransition(async () => {
      const result = await action()
      if (result.error) toast.error(result.error)
      setPendingId(null)
    })
  }, [])

  // Clean the deep-link param so browser-back doesn't reopen the dialog.
  useEffect(() => {
    if (searchParams.get('action') === 'create') {
      router.replace(`/professor/courses/${sectionId}/modules`, { scroll: false })
    }
  }, [searchParams, router, sectionId])

  const moduleIds = useMemo(() => modules.map((m) => m.id), [modules])
  const { expanded, toggle, expand } = useModuleExpansion(sectionId, moduleIds)

  /* Deep links from the retired /modules/[moduleId] route and from citation
     hrefs: open the named section (or the one holding the named item) and
     scroll to it. */
  const deepLinkSection = searchParams.get('section')
  const deepLinkItem = searchParams.get('item')
  const deepLinkPage = Number(searchParams.get('page')) || undefined
  useEffect(() => {
    const owner =
      deepLinkSection ??
      Object.entries(itemsByModule).find(([, list]) =>
        list.some((i) => i.id === deepLinkItem),
      )?.[0]
    if (!owner) return
    /* Don't expand() an id that isn't on the page — a crafted or stale ?section=
       would only park dead state in sessionStorage. Same guard as the student
       board, so the shared behaviour is genuinely shared. */
    if (!moduleIds.includes(owner)) return

    expand(owner)
    const timer = setTimeout(() => {
      const target = deepLinkItem
        ? document.getElementById(`module-item-${deepLinkItem}`)
        : document.getElementById(`module-panel-${owner}`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 300)
    return () => clearTimeout(timer)
  }, [deepLinkSection, deepLinkItem, itemsByModule, moduleIds, expand])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  /* A content filter (text or type) matches items INSIDE sections, so matching
     sections must open — results you can't see aren't results. A status filter
     only narrows WHICH sections are listed, so those stay collapsed. */
  const contentFiltering = isFiltering(query, type)

  /* Student preview hides unpublished modules and invisible items — the same
     filters the student page applies server-side. A week that hasn't opened yet
     shows with NO items, matching the student page, which never fetches them. */
  const baseItemsByModule = useMemo(() => {
    if (!studentPreview) return itemsByModule
    const notOpen = new Set(lockedModuleIds(modules))
    const result: Record<string, ModuleItem[]> = {}
    for (const id of moduleIds) {
      result[id] = notOpen.has(id) ? [] : (itemsByModule[id] ?? []).filter((i) => i.is_visible)
    }
    return result
  }, [studentPreview, itemsByModule, moduleIds, modules])

  const visibleItemsByModule = useMemo(() => {
    if (!contentFiltering) return baseItemsByModule
    const result: Record<string, ModuleItem[]> = {}
    for (const mod of modules) {
      const matches = (baseItemsByModule[mod.id] ?? []).filter((item) =>
        itemMatches(item, query, type),
      )
      if (matches.length > 0) result[mod.id] = matches
    }
    return result
  }, [baseItemsByModule, modules, query, type, contentFiltering])

  const visibleModules = useMemo(() => {
    let list = modules
    /* Preview has to match what students actually get: drafts are invisible to them,
       but a week that hasn't opened yet IS on their page — dimmed and empty — so it
       stays here too. Its items are dropped instead (below), which is what the
       student page does, so the preview shows the same closed shell rather than
       either hiding the week or revealing what's inside it. */
    if (studentPreview) list = list.filter((m) => m.is_published)
    if (status === 'published') list = list.filter((m) => m.is_published)
    if (status === 'draft') list = list.filter((m) => !m.is_published)
    if (contentFiltering) list = list.filter((m) => visibleItemsByModule[m.id]?.length)
    return list
  }, [modules, studentPreview, status, contentFiltering, visibleItemsByModule])

  /* Dividers label the true curriculum order, so they only survive a filter
     that doesn't reorder or thin that order. Under a search or a status filter
     a break between "Week 3" and "Week 9" is a lie, so they drop out.

     Student preview KEEPS them, read-only: students see the same breaks on
     their own modules page and on the roadmap, so hiding them here would make
     the preview lie about what students see. */
  const showDividers = !contentFiltering && status === 'all'

  const rows = useMemo(() => mergeModuleRows(modules, dividers), [modules, dividers])

  /* latest rows for callbacks that fire long after their render — the undo in a
     toast runs once the delete has already revalidated the list */
  const rowsRef = useRef(rows)
  useEffect(() => { rowsRef.current = rows }, [rows])

  const visibleModuleIds = useMemo(() => new Set(visibleModules.map((m) => m.id)), [visibleModules])
  const visibleRows = useMemo<BoardRow[]>(() => {
    if (!showDividers) return rows.filter((r) => r.kind === 'module' && visibleModuleIds.has(r.id))
    const kept = rows.filter((r) => r.kind !== 'module' || visibleModuleIds.has(r.id))
    /* Student preview ONLY. Student preview hides unpublished modules, which can
       strand a divider above a group the student can't see — the same
       suppression the student page applies.

       It must never run on the professor's own editing list: there, "a divider
       that heads nothing yet" is a normal state (every divider is trailing for
       the moment between creating it and dragging a module under it), and
       hiding it makes a saved row unreachable — no way to rename, reorder or
       delete it, and a drag onto the last row loses it outright. */
    return studentPreview ? dropEmptyDividerGroups(kept) : kept
  }, [showDividers, rows, visibleModuleIds, studentPreview])
  const sortableIds = useMemo(() => visibleRows.map((r) => r.id), [visibleRows])

  /* Dragging is only honest when the list on screen IS the curriculum order. A
     filtered list is a few rows pulled out of that order, so a drag on it can't
     mean what it appears to mean — and the roadmap reads the order it writes, so
     the damage surfaces on another page. Filtering is a "find something" action,
     not a "change the order" one, so reordering is off whenever a search or
     status filter is on — with or without dividers, no special case. */
  const reorderable = !studentPreview && showDividers

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return

      const activeType = active.data.current?.type
      const overType = over.data.current?.type

      /* Modules and dividers interleave in ONE position scale, so both reorder
         through the same merged list — that shared order is what the roadmap
         reads to place its divider annotations. */
      if (activeType === 'module' || activeType === 'divider') {
        const from = rows.findIndex((r) => r.id === active.id)
        const to = rows.findIndex((r) => r.id === over.id)
        if (from === -1 || to === -1) return
        const reordered = [...rows]
        const [moved] = reordered.splice(from, 1)
        reordered.splice(to, 0, moved)
        runMutation(active.id as string, () =>
          reorderModules(
            sectionId,
            reordered.map((r): ModuleListEntry => ({ id: r.id, kind: r.kind })),
          ),
        )
        return
      }

      if (activeType !== 'item') return

      const fromModuleId = active.data.current?.moduleId as string | undefined
      if (!fromModuleId) return

      // Dropping onto another item, or onto a section header (which is how you
      // move something into a collapsed module — it lands at the end).
      const toModuleId =
        overType === 'item'
          ? (over.data.current?.moduleId as string | undefined)
          : overType === 'module'
            ? (over.id as string)
            : undefined
      if (!toModuleId) return

      if (toModuleId === fromModuleId) {
        const items = itemsByModule[fromModuleId] ?? []
        const from = items.findIndex((i) => i.id === active.id)
        const to = items.findIndex((i) => i.id === over.id)
        if (from === -1 || to === -1) return
        const reordered = [...items]
        const [moved] = reordered.splice(from, 1)
        reordered.splice(to, 0, moved)
        runMutation(active.id as string, () =>
          reorderModuleItems(fromModuleId, sectionId, reordered.map((i) => i.id)),
        )
        return
      }

      const targetItems = itemsByModule[toModuleId] ?? []
      const toIndex =
        overType === 'item' ? targetItems.findIndex((i) => i.id === over.id) : targetItems.length
      runMutation(active.id as string, () =>
        moveModuleItem(
          active.id as string,
          fromModuleId,
          toModuleId,
          sectionId,
          toIndex < 0 ? targetItems.length : toIndex,
        ),
      )
    },
    [rows, itemsByModule, sectionId, runMutation],
  )

  /* A divider only renders in the unfiltered, non-preview list, so writing one
     while a filter is up would land it somewhere the professor can't see — a
     toast claiming success over a screen that shows nothing. Clear the
     preconditions instead of accepting a write into a hidden view. */
  const revealDividers = useCallback(() => {
    setQuery('')
    setType('all')
    setStatus('all')
    setStudentPreview(false)
  }, [])

  /* Undo instead of a confirm dialog: a divider is a label and a position, so
     restoring it exactly is two calls (it re-appends at the end, then the list
     order puts it back at `index`). Keeps the one-click delete the in-module
     divider already has, without making the click unrecoverable. */
  const restoreDivider = useCallback(async (divider: ModuleDivider, index: number) => {
    revealDividers()
    // Clamp to the schema's cap: a divider stored before the 40-char limit would
    // otherwise fail validation on the way back, making its undo a dead end.
    /* Restore under the ORIGINAL id: ordering is position-driven, so a fresh id
       would look identical on screen, but anything keyed on a divider id (a deep
       link, an analytics event) would silently point at a row that no longer
       exists. */
    const created = await createModuleDivider(
      sectionId,
      { title: divider.title.slice(0, 40) },
      divider.id,
    )
    if (created.error || !created.dividerId) {
      toast.error(created.error ?? 'Could not restore the divider')
      return
    }
    const newId = created.dividerId
    const moved = await reorderModules(
      sectionId,
      dividerRestoreOrder(rowsRef.current, divider.id, newId, index),
    )
    // Report the outcome the professor cares about, not the step that failed:
    // after the create the divider is always back, just possibly at the end.
    if (moved.error) toast.error('Divider restored, but not back in its original spot — drag it into place.')
    setJustAdded(newId)
  }, [sectionId, revealDividers])

  const handleDeleteDivider = useCallback(async (divider: ModuleDivider) => {
    /* Index in the FULL list, not in what's rendered: restoreDivider splices
       into every row, and student preview or a suppressed empty group can make
       the rendered list shorter than it. */
    const index = rowsRef.current.findIndex((r) => r.id === divider.id)
    const result = await deleteModuleDivider(divider.id, sectionId)
    if (result.error) {
      toast.error(result.error)
      return
    }
    toast.success('Divider removed', {
      action: { label: 'Undo', onClick: () => void restoreDivider(divider, index) },
    })
  }, [sectionId, restoreDivider])

  const setPublished = (mod: Module, isPublished: boolean, notify: boolean) => {
    setPublishMenuFor(null)
    setUnpublishTarget(null)
    runMutation(mod.id, () =>
      updateModule(mod.id, sectionId, { is_published: isPublished, notify }),
    )
  }

  const handleTogglePublish = (mod: Module) => {
    // Unpublishing pulls live material away from students — confirm it.
    if (mod.is_published) setUnpublishTarget(mod)
    else setPublishMenuFor(mod)
  }

  /* "Open to students now" = clear the date. Not a second override flag: see
     lib/modules/unlock.ts for why a date plus a boolean can't be kept honest.
     The undo hands the original instant back, so a mis-click is one tap to fix
     (this is the only way to lose a release date without opening the dialog). */
  const handleOpenNow = (mod: Module) => {
    const previous = mod.unlock_date
    runMutation(mod.id, async () => {
      const result = await updateModule(mod.id, sectionId, { unlock_date: null })
      if (!result.error) {
        toast.success(`“${mod.title}” is open to students`, {
          action: previous
            ? {
                label: 'Undo',
                onClick: () => runMutation(mod.id, () =>
                  updateModule(mod.id, sectionId, { unlock_date: previous }),
                ),
              }
            : undefined,
        })
      }
      return result
    })
  }

  const handleToggleItemVisibility = (item: ModuleItem, moduleId: string) => {
    runMutation(item.id, () =>
      updateModuleItem(item.id, moduleId, sectionId, { is_visible: !item.is_visible }),
    )
  }

  /* Deleting an item destroys an uploaded file, and the control sits in a row
     of 26px circles that are permanently visible on touch — it needs the same
     guard module deletion already has. */
  const confirmDeleteItem = () => {
    if (!deleteItemTarget) return
    const { item, moduleId } = deleteItemTarget
    setDeleteItemTarget(null)
    runMutation(item.id, () => deleteModuleItem(item.id, moduleId, sectionId))
  }

  const openAddItem = (moduleId: string, itemType: ModuleItemType) => {
    setEditItem(null)
    setItemDialogModuleId(moduleId)
    setItemDialogType(itemType)
  }

  const openEditItem = (item: ModuleItem, moduleId: string) => {
    setEditItem(item)
    setItemDialogModuleId(moduleId)
    setItemDialogType(item.item_type as ModuleItemType)
  }

  // "New module" with a quiet chevron for the optional divider — the primary
  // action stays a single click; the divider is deliberately one level down.
  // Hand-rolled rather than two shadcn Buttons because a split control needs
  // asymmetric radii, which the project's radius scale doesn't express. The
  // focus rings are INSET: the wrapper clips, so an outside ring never shows.
  const SPLIT_FOCUS_RING =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-foreground/80'
  const addButton = (
    <div className="inline-flex shrink-0 items-stretch overflow-hidden rounded-xl bg-primary text-primary-foreground">
      <button
        type="button"
        onClick={() => setCreateOpen(true)}
        className={cn('inline-flex h-9 cursor-pointer items-center gap-2 px-3 text-sm font-medium transition-colors hover:bg-primary/90', SPLIT_FOCUS_RING)}
      >
        <Plus className="h-4 w-4" aria-hidden />
        New module
      </button>
      <div className="w-px bg-primary-foreground/25" />
      <DropdownMenu>
        <TooltipProvider>
          <Tooltip>
            {/* The divider sits one level down on purpose; the tooltip is what pays
                that discovery cost back. */}
            <TooltipTrigger asChild>
              {/* Accessible name matches the visible tooltip: on touch the
                  tooltip never fires, and this is the only entry point to the
                  whole divider feature — a vague "more options" is all a screen
                  reader would get. Widened to a 44px target below `sm` for the
                  same reason ModuleRowActions does. */}
              <DropdownMenuTrigger
                className={cn('inline-flex min-w-11 cursor-pointer items-center justify-center px-3 transition-colors hover:bg-primary/90 sm:min-w-0 sm:px-2.5', SPLIT_FOCUS_RING)}
                aria-label="Add a divider"
              >
                <ChevronDown className="h-4 w-4" aria-hidden />
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Add a divider</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => { revealDividers(); setEditDivider(null); setDividerOpen(true) }}>
            <SeparatorHorizontal className="h-4 w-4" aria-hidden />
            Add divider
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  /* ── First run: nothing exists yet. No toolbar — filters help nobody here.
     Dividers count: deleting the last module otherwise strands any divider in
     the DB with no UI left to rename or remove it. */
  if (modules.length === 0 && dividers.length === 0) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          title="Modules"
          description="Organize your course into weeks, and drop your materials in."
        />
        <EmptyState
          variant="teaching"
          icon={Layers}
          title="Build your first module"
          description="Group the readings, slides and videos for a week into one unit — then publish it to students."
        >
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            New module
          </Button>
        </EmptyState>
        <CreateModuleDialog open={createOpen} onOpenChange={setCreateOpen} sectionId={sectionId} />
      </div>
    )
  }

  /* In student preview the counts must describe what's actually rendered —
     otherwise the summary claims 12 modules while showing 9. */
  const countedModules = studentPreview ? visibleModules : modules
  const totalItems = countedModules.reduce(
    (sum, m) =>
      sum + (baseItemsByModule[m.id] ?? []).filter((i) => i.item_type !== 'section_divider').length,
    0,
  )
  const draftCount = modules.filter((m) => !m.is_published).length
  /* Scheduled weeks earn a segment for the same reason drafts do: this line is the
     only aggregate confirmation on the page, and setting a release date would
     otherwise be acknowledged nowhere except a chip you have to go find. */
  const notOpenCount = modules.filter((m) => m.is_published && isUnlockPending(m.unlock_date)).length
  const matchCount = visibleModules.reduce(
    (sum, m) => sum + (visibleItemsByModule[m.id] ?? []).length,
    0,
  )
  const moduleWord = (n: number) => `${n} ${n === 1 ? 'module' : 'modules'}`
  const summary = contentFiltering
    ? `${matchCount} ${matchCount === 1 ? 'match' : 'matches'} in ${moduleWord(visibleModules.length)}`
    : status !== 'all'
      // A status filter narrows which modules are listed; it doesn't "match" items.
      ? moduleWord(visibleModules.length)
      : [
          moduleWord(countedModules.length),
          `${totalItems} ${totalItems === 1 ? 'item' : 'items'}`,
          ...(draftCount > 0 && !studentPreview
            ? [`${draftCount} draft${draftCount === 1 ? '' : 's'}`]
            : []),
          ...(notOpenCount > 0 && !studentPreview ? [`${notOpenCount} not open yet`] : []),
        ].join('  ·  ')

  /* Say why the grips — and any dividers — went away, where the professor is
     already reading the result count. Without this the rule is undocumented, and
     re-adding a "missing" divider or hunting for a vanished grip is the obvious
     next move. Silent under student preview: nothing is editable in a preview,
     so "while filtering" would name the wrong cause. */
  const dividerNote = studentPreview || showDividers
    ? null
    : dividers.length > 0
      ? 'dividers hidden and reordering off while filtering'
      : 'reordering off while filtering'

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Modules"
        description="Organize your course into weeks, and drop your materials in."
        actions={addButton}
      />

      <ModulesToolbar
        query={query}
        onQueryChange={setQuery}
        type={type}
        onTypeChange={setType}
        status={status}
        onStatusChange={setStatus}
        trailing={
          <Button
            variant={studentPreview ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setStudentPreview((v) => !v)}
          >
            {studentPreview ? (
              <EyeOff className="h-4 w-4" aria-hidden />
            ) : (
              <Eye className="h-4 w-4" aria-hidden />
            )}
            {studentPreview ? 'Exit preview' : 'Student view'}
          </Button>
        }
      />

      <p className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
        {studentPreview ? `Showing what students see  ·  ${summary}` : summary}
        {dividerNote && <span>·  {dividerNote}</span>}
        {isSaving && (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
            Saving…
          </span>
        )}
      </p>

      {visibleModules.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-10 text-center">
          <SearchX className="mx-auto mb-2 h-5 w-5 text-muted-foreground/60" aria-hidden />
          <p className="text-sm text-muted-foreground">
            {studentPreview
              ? 'Students can’t see anything yet — nothing is published.'
              : 'Nothing matches your filters.'}
          </p>
          {!studentPreview && (
            /* Three independent dimensions means up to three actions to undo
               by hand — put the reset where the dead end is. */
            <Button
              variant="ghost"
              size="sm"
              className="mt-3"
              onClick={() => {
                setQuery('')
                setType('all')
                setStatus('all')
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <DndContext
          id="modules-board-dnd"
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            <AnimatedList className="space-y-3">
              {visibleRows.map((row) => (
                <AnimatedItem key={row.id}>
                  {row.kind === 'divider' ? (
                    /* Student preview is read-only, and a student's divider is
                       just the label — so preview renders exactly that. */
                    studentPreview ? (
                      <DividerRule title={row.divider.title} />
                    ) : (
                      <ModuleDividerRow
                        divider={row.divider}
                        highlight={justAdded === row.id}
                        pending={pendingId === row.id}
                        onEdit={() => { setEditDivider(row.divider); setDividerOpen(true) }}
                        onDelete={() => void handleDeleteDivider(row.divider)}
                      />
                    )
                  ) : (
                    <ProfessorModuleSection
                      module={row.module}
                      items={visibleItemsByModule[row.id] ?? []}
                      sectionId={sectionId}
                      expanded={contentFiltering || expanded.has(row.id)}
                      onToggle={() => toggle(row.id)}
                      studentPreview={studentPreview}
                      reorderable={reorderable}
                      primersEnabled={primersEnabled}
                      primerStates={primerStates}
                      onEditModule={() => setEditModule(row.module)}
                      onDeleteModule={() => setDeleteTarget(row.module)}
                      onTogglePublish={() => handleTogglePublish(row.module)}
                      onOpenNow={() => handleOpenNow(row.module)}
                      onAddItem={(itemType) => openAddItem(row.id, itemType)}
                      onEditItem={(item) => openEditItem(item, row.id)}
                      onDeleteItem={(item) => setDeleteItemTarget({ item, moduleId: row.id })}
                      onToggleItemVisibility={(item) => handleToggleItemVisibility(item, row.id)}
                      filtering={contentFiltering}
                      pendingId={pendingId}
                      deepLinkItemId={deepLinkItem}
                      deepLinkPage={deepLinkPage}
                    />
                  )}
                </AnimatedItem>
              ))}
            </AnimatedList>
          </SortableContext>
        </DndContext>
      )}

      {/* ── Publish choice ─────────────────────────────────────── */}
      <AlertDialog
        open={!!publishMenuFor}
        onOpenChange={(open) => !open && setPublishMenuFor(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish “{publishMenuFor?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Students will be able to see this module and everything visible inside it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => publishMenuFor && setPublished(publishMenuFor, true, false)}
            >
              Publish silently
            </Button>
            <AlertDialogAction
              onClick={() => publishMenuFor && setPublished(publishMenuFor, true, true)}
            >
              Publish &amp; notify
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Unpublish confirmation ─────────────────────────────── */}
      <AlertDialog
        open={!!unpublishTarget}
        onOpenChange={(open) => !open && setUnpublishTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unpublish “{unpublishTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Students will immediately lose access to this module. Nothing is deleted — publish
              it again at any time and everything comes back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep published</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => unpublishTarget && setPublished(unpublishTarget, false, false)}
            >
              Unpublish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete an item ─────────────────────────────────────── */}
      <AlertDialog
        open={!!deleteItemTarget}
        onOpenChange={(open) => !open && setDeleteItemTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{deleteItemTarget?.item.title || itemFileName(deleteItemTarget?.item) || 'this item'}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {itemFileName(deleteItemTarget?.item)
                ? `This removes the item and its uploaded file (${itemFileName(deleteItemTarget?.item)}) from the course. This can’t be undone.`
                : 'This removes the item from the course. This can’t be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteItem}
              variant="destructive"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Module + item dialogs ──────────────────────────────── */}
      <CreateModuleDialog open={createOpen} onOpenChange={setCreateOpen} sectionId={sectionId} />
      {/* `key` is load-bearing: this instance stays mounted while `editModule` is
          null, so react-hook-form captured its defaultValues from NO module and
          kept them — every Edit opened with a blank title, week and opens-on date,
          and saving reported "Title is required" instead of the module's own
          values. Keying on the id remounts the form per module. */}
      <CreateModuleDialog
        key={editModule?.id ?? 'no-module'}
        open={!!editModule}
        onOpenChange={(open) => !open && setEditModule(null)}
        sectionId={sectionId}
        module={editModule}
      />
      <ModuleDividerDialog
        open={dividerOpen}
        onOpenChange={(open) => { setDividerOpen(open); if (!open) setEditDivider(null) }}
        sectionId={sectionId}
        divider={editDivider}
        onCreated={setJustAdded}
      />
      <DeleteModuleDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        sectionId={sectionId}
        module={deleteTarget}
        itemCount={deleteTarget ? (itemsByModule[deleteTarget.id] ?? []).length : 0}
      />
      {itemDialogModuleId && itemDialogType && (
        <EditItemDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setItemDialogModuleId(null)
              setItemDialogType(null)
              setEditItem(null)
            }
          }}
          sectionId={sectionId}
          moduleId={itemDialogModuleId}
          itemType={itemDialogType}
          item={editItem}
        />
      )}
    </div>
  )
}

/** The uploaded filename behind an item, when it has one. */
function itemFileName(item: ModuleItem | undefined): string | undefined {
  const content = (item?.content ?? {}) as { fileName?: unknown }
  return typeof content.fileName === 'string' && content.fileName ? content.fileName : undefined
}
