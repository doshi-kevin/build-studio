/**
 * StudentModulesList — the course's materials, on one page.
 *
 * Sections are collapsed by default and the choice is remembered. The previous
 * build expanded every module on mount, so a nine-module course dumped ~100
 * near-identical rows on first paint and reset on every navigation.
 *
 * Supports `?item=<id>` (and the older `?highlight=<id>`) to open the
 * containing section, scroll to the item and pulse it — the target of the
 * citation links produced by lib/extraction/citation.ts.
 *
 * Also supports `?section=<moduleId>`, which is what the retired
 * `/modules/[moduleId]` route redirects to via buildModulesHref(). Without it a
 * student following one of those links landed on the board with the default
 * first section open and the linked module still shut.
 *
 * Two layouts, one set of state: the reader can switch to a tile grid (see
 * module-tile-rows.ts for where the detail panel lands). Both views read the SAME
 * expansion state, so switching keeps your place and the deep links above work in
 * either — the difference is only that the list can hold several sections open
 * while the grid has one panel, hence `setOnly`.
 *
 * Type: Client Component
 */
'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { Layers, SearchX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { PageHeader } from '@/components/professor/PageHeader'
import { ModulesToolbar } from '@/components/shared/modules/ModulesToolbar'
import {
  itemMatches,
  isFiltering,
  type ItemFilterType,
} from '@/components/shared/modules/module-item-display'
import { DividerRule } from '@/components/shared/modules/DividerRule'
import {
  mergeModuleRows,
  dropEmptyDividerGroups,
  type ModuleDivider,
} from '@/components/shared/modules/module-rows'
import { useModuleExpansion } from '@/lib/hooks/use-module-expansion'
import { useModulesView } from '@/lib/hooks/use-modules-view'
import { isUnlockPending } from '@/lib/modules/unlock'
import { StudentModuleSection } from './StudentModuleSection'
import { StudentModuleTile } from './StudentModuleTile'
import { StudentModulePanel } from './StudentModulePanel'
import { ModulesViewToggle } from './ModulesViewToggle'
import { TILE_GRID_CLASS, useTileColumns, panelInsertAfterIndex } from './module-tile-rows'
import type { StudentModule, StudentModuleItem } from './types'

interface StudentModulesListProps {
  sectionId: string
  modules: StudentModule[]
  /** Labelled breaks between sections — the same ones the roadmap draws. */
  dividers: ModuleDivider[]
  itemsByModule: Record<string, StudentModuleItem[]>
  /** Lecture item ids with a primer the professor has made available. */
  availablePrimerItemIds?: string[]
}

const HIGHLIGHT_MS = 3000

export function StudentModulesList({
  sectionId,
  modules,
  dividers,
  itemsByModule,
  availablePrimerItemIds,
}: StudentModulesListProps) {
  const searchParams = useSearchParams()
  const deepLinkSectionId = searchParams.get('section')
  const deepLinkItemId = searchParams.get('item') ?? searchParams.get('highlight')
  const deepLinkPage = Number(searchParams.get('page')) || undefined

  const [query, setQuery] = useState('')
  const [type, setType] = useState<ItemFilterType>('all')
  /* Seeded from the URL so the pulse is correct on first paint. */
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(deepLinkItemId)

  const primerItemIds = useMemo(
    () => new Set(availablePrimerItemIds ?? []),
    [availablePrimerItemIds],
  )
  const moduleIds = useMemo(() => modules.map((m) => m.id), [modules])
  const { expanded, toggle, expand, setOnly, usingDefault } = useModuleExpansion(
    sectionId,
    moduleIds,
  )
  const { view, setView } = useModulesView()

  const filtering = isFiltering(query, type)

  /* While filtering, every matching week force-opens (below) — and in a grid every
     open week is full width, so a filtered tile view IS the list, just assembled by
     more code and with gaps in it. Render the list outright instead. The toggle
     itself is untouched, so clearing the search returns the reader to tiles. */
  const tiles = view === 'tile' && !filtering

  /* While filtering, a section shows only its matching items and sections with
     no matches drop out entirely. */
  const visibleItemsByModule = useMemo(() => {
    if (!filtering) return itemsByModule
    const result: Record<string, StudentModuleItem[]> = {}
    for (const mod of modules) {
      const matches = (itemsByModule[mod.id] ?? []).filter((item) =>
        itemMatches(item, query, type),
      )
      if (matches.length > 0) result[mod.id] = matches
    }
    return result
  }, [filtering, itemsByModule, modules, query, type])

  const visibleModules = useMemo(
    () => (filtering ? modules.filter((m) => visibleItemsByModule[m.id]?.length) : modules),
    [filtering, modules, visibleItemsByModule],
  )

  /* Dividers label the curriculum's real order, so a filtered list can't carry
     them — a break between "Week 3" and "Week 9" is a lie. Unfiltered, they
     interleave by the position scale they share with modules, minus any whose
     group the professor hasn't published yet. */
  const visibleRows = useMemo(
    () =>
      filtering
        ? mergeModuleRows(visibleModules, [])
        : dropEmptyDividerGroups(mergeModuleRows(modules, dividers)),
    [filtering, modules, dividers, visibleModules],
  )

  /* The pulse is seeded from the URL, so its clear-timer has to run whether or
     not the link resolves to anything. Hanging it off the resolution below
     stranded the ring for the life of the page whenever the link named a module
     that isn't here (unpublished, deleted) or an item id that no longer exists.
     Only an item pulses — pulsing a whole section is noise, not a signpost. */
  useEffect(() => {
    if (!deepLinkItemId) return
    const clearTimer = setTimeout(() => setHighlightedItemId(null), HIGHLIGHT_MS)
    return () => clearTimeout(clearTimer)
  }, [deepLinkItemId])

  /* Which week a deep link points at — the explicit ?section= if there is one,
     otherwise whichever week holds the ?item=. An explicit ?section= takes
     precedence, as on the professor board, because that is what buildModulesHref()
     always sets. Lifted out of the scroll effect below so the tile view can select
     the same week rather than duplicating the lookup. */
  const deepLinkOwner = useMemo(
    () =>
      deepLinkSectionId ??
      Object.entries(itemsByModule).find(([, items]) =>
        items.some((item) => item.id === deepLinkItemId),
      )?.[0],
    [deepLinkSectionId, deepLinkItemId, itemsByModule],
  )

  /* Deep link: open the named section — or the one holding the named item — and
     scroll to it. */
  useEffect(() => {
    const owner = deepLinkOwner
    if (!owner) return
    /* A student's list excludes unpublished modules, so a link to one resolves
       to nothing here. Bail rather than expand() an id that isn't on the page,
       which would only park dead state in sessionStorage. */
    if (!moduleIds.includes(owner)) return

    /* Published-but-not-yet-open is the case the id check above misses: a locked
       week IS in moduleIds, so expand() used to run, commit the default set to
       sessionStorage, and flip usingDefault false — after which selectedModule
       fell through to "first openable week". The reader followed a link to one
       week and got a different one, with dead state persisted (#720). A locked
       week has no items fetched and can never fill a panel, so there is nothing
       to open: bail exactly as we do for unpublished. */
    const ownerModule = visibleModules.find((m) => m.id === owner)
    if (!ownerModule || isUnlockPending(ownerModule.unlock_date)) return

    expand(owner)

    const scrollTimer = setTimeout(() => {
      /* When ?section= and ?item= disagree the item's row may sit inside a
         section we didn't open, so it isn't in the DOM — fall back to the
         section itself rather than leaving the reader at the top of the page. */
      const target =
        (deepLinkItemId && document.getElementById(`module-item-${deepLinkItemId}`)) ||
        document.getElementById(`module-panel-${owner}`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 300)
    return () => clearTimeout(scrollTimer)
  }, [deepLinkOwner, deepLinkItemId, moduleIds, visibleModules, expand])

  /* The tile grid has ONE panel, so exactly one week can be open in it. A deep
     link's week wins; failing that, the first open week in course order — which is
     what makes switching List → Tiles keep the reader's place when the list had
     several sections open. A week that hasn't opened yet can never be selected:
     the page never fetched its items, so there is nothing to put in a panel. */
  const selectedModule = useMemo(() => {
    if (!tiles) return null
    const openable = visibleModules.filter((m) => !isUnlockPending(m.unlock_date))
    const deepLinked = openable.find((m) => m.id === deepLinkOwner && expanded.has(m.id))
    if (deepLinked) return deepLinked
    /* The grid arrives fully collapsed: opening the first section on a first visit
       is a list default, and a panel already sitting under row one reads as though
       something had been clicked. A deep link above still wins, and anything the
       reader has actually opened (here or in the list) is honoured below. */
    if (usingDefault) return null
    return openable.find((m) => expanded.has(m.id)) ?? null
  }, [tiles, visibleModules, deepLinkOwner, expanded, usingDefault])

  /* Where the panel goes. The column count is only read while the grid is on
     screen, and the grid only ever renders in the browser (the layout preference
     comes from localStorage), so there is no server/client mismatch here. */
  const columns = useTileColumns(tiles)
  const panelAfterIndex = panelInsertAfterIndex(visibleRows, columns, selectedModule?.id ?? null)

  /* Both focus moves live in the event handlers, never in an effect: only a gesture
     should move focus, so a panel restored from the reader's remembered state on
     load leaves them where they are. */
  const focusAfterPaint = (id: string) =>
    requestAnimationFrame(() => document.getElementById(id)?.focus())

  const selectTile = useCallback(
    (moduleId: string) => {
      const closing = selectedModule?.id === moduleId
      setOnly(closing ? null : moduleId)
      /* Bring the reader to the panel. It opens after the whole ROW of tiles, so on
         a bottom row it would otherwise render below the fold with nothing but a
         border change on the tile to say anything happened — and a keyboard user
         has no way to reach it (support for acting on aria-controls is effectively
         JAWS-only). Focusing scrolls it into view for the same price. */
      if (!closing) focusAfterPaint(`module-panel-${moduleId}`)
    },
    [selectedModule, setOnly],
  )

  /* Collapse unmounts the panel — and with it the button that was just pressed,
     which holds focus. Left alone, focus falls to <body> and the next Tab restarts
     at the top of the document, past the rail, the header and every tile. Hand it
     back to the tile that opened the panel (which also scrolls it into view). */
  const collapsePanel = useCallback(() => {
    const returnTo = selectedModule?.id
    setOnly(null)
    if (returnTo) focusAfterPaint(`module-header-${returnTo}`)
  }, [selectedModule, setOnly])

  // First-run empty state hides the toolbar entirely — filters help nobody
  // when there is nothing to filter.
  if (modules.length === 0) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title="Modules" description="Course content organized by week." />
        <EmptyState
          variant="teaching"
          icon={Layers}
          title="No materials yet"
          description="Your instructor hasn’t published any course materials. They’ll appear here as soon as they do."
        />
      </div>
    )
  }

  const totalItems = modules.reduce(
    (sum, m) =>
      sum + (itemsByModule[m.id] ?? []).filter((i) => i.item_type !== 'section_divider').length,
    0,
  )
  const matchCount = visibleModules.reduce(
    (sum, m) => sum + (visibleItemsByModule[m.id] ?? []).length,
    0,
  )
  const moduleWord = (n: number) => `${n} ${n === 1 ? 'module' : 'modules'}`
  /* Weeks that haven't opened are on screen but hold nothing, so they belong in the
     module count and never in the item count — and they earn their own segment,
     because otherwise the line reads as though those weeks were empty. */
  const notOpenCount = modules.filter((m) => isUnlockPending(m.unlock_date)).length
  const summary = filtering
    ? `${matchCount} ${matchCount === 1 ? 'match' : 'matches'} in ${moduleWord(visibleModules.length)}`
    : [
        moduleWord(modules.length),
        `${totalItems} ${totalItems === 1 ? 'item' : 'items'}`,
        ...(notOpenCount > 0 ? [`${notOpenCount} not open yet`] : []),
      ].join('  ·  ')

  return (
    /* Tiles need the room for four columns; the list stays narrow, where rows of
       titles and descriptions read better. */
    <div className={cn('mx-auto space-y-6', tiles ? 'max-w-6xl' : 'max-w-5xl')}>
      <PageHeader
        title="Modules"
        description="Course content organized by week."
        actions={<ModulesViewToggle view={view} onViewChange={setView} />}
      />

      <ModulesToolbar
        query={query}
        onQueryChange={setQuery}
        type={type}
        onTypeChange={setType}
      />

      <p className="text-xs tabular-nums text-muted-foreground">{summary}</p>

      {visibleModules.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-10 text-center">
          <SearchX className="mx-auto mb-2 h-5 w-5 text-muted-foreground/60" aria-hidden />
          <p className="text-sm text-muted-foreground">Nothing matches your search.</p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            onClick={() => {
              setQuery('')
              setType('all')
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <AnimatedList className={tiles ? TILE_GRID_CLASS : 'space-y-3'}>
          {visibleRows.flatMap((row, index) => {
            const node = (
              <AnimatedItem
                key={row.id}
                /* A divider labels everything after it, so in the grid it takes a
                   row of its own — which is also what makes it end the row above
                   (see panelInsertAfterIndex). */
                className={cn(tiles && row.kind === 'divider' && 'col-span-full')}
              >
                {row.kind === 'divider' ? (
                  <DividerRule title={row.divider.title} />
                ) : tiles ? (
                  <StudentModuleTile
                    module={row.module}
                    items={visibleItemsByModule[row.id] ?? []}
                    selected={selectedModule?.id === row.id}
                    onSelect={() => selectTile(row.id)}
                  />
                ) : (
                  <StudentModuleSection
                    module={row.module}
                    items={visibleItemsByModule[row.id] ?? []}
                    sectionId={sectionId}
                    /* While filtering, matching sections open regardless of the
                       remembered state — results you can't see aren't results. */
                    expanded={filtering || expanded.has(row.id)}
                    onToggle={() => toggle(row.id)}
                    primerItemIds={primerItemIds}
                    highlightedItemId={highlightedItemId}
                    deepLinkItemId={deepLinkItemId}
                    deepLinkPage={deepLinkPage}
                    filtering={filtering}
                  />
                )}
              </AnimatedItem>
            )

            // The panel is a sibling of the tiles, spanning the grid, rendered
            // after the last tile of the row that holds the selected week.
            if (!selectedModule || index !== panelAfterIndex) return [node]
            return [
              node,
              <AnimatedItem key={`panel-${selectedModule.id}`} className="col-span-full">
                <StudentModulePanel
                  module={selectedModule}
                  items={visibleItemsByModule[selectedModule.id] ?? []}
                  sectionId={sectionId}
                  onCollapse={collapsePanel}
                  primerItemIds={primerItemIds}
                  highlightedItemId={highlightedItemId}
                  deepLinkItemId={deepLinkItemId}
                  deepLinkPage={deepLinkPage}
                />
              </AnimatedItem>,
            ]
          })}
        </AnimatedList>
      )}
    </div>
  )
}
