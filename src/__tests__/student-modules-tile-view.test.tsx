/**
 * The student Modules tile grid, rendered.
 *
 * modules-tile-layout.test.ts covers the placement arithmetic in isolation; this
 * asserts the two things only the assembled component can show:
 *
 *   1. The panel really is a SIBLING of the tiles, after the last tile of the row
 *      holding the selected week — the behaviour the mockup asks for and the thing
 *      that breaks if the grid is ever rebuilt as one-grid-per-row or the panel is
 *      nested inside its tile.
 *   2. The grid holds exactly ONE panel open, where the list holds several
 *      sections — while sharing the list's expansion state.
 *
 * The locked-week case is re-asserted here rather than left to the list's own test:
 * "no way in" is a disclosure boundary, and a second layout is a second place to
 * get it wrong.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StudentModulesList } from '@/components/student/modules/StudentModulesList'
import type { StudentModule, StudentModuleItem } from '@/components/student/modules/types'

/* Mutable so the deep-link block can drive ?section= / ?item=. vi.hoisted rather
   than a plain `let`: the mock factory can run before module-scope initialisers,
   which would put a `let` in its temporal dead zone. */
const mocks = vi.hoisted(() => ({ searchParams: new URLSearchParams() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.searchParams }))

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()

const mod = (id: string, title: string, unlock_date: string | null = null): StudentModule => ({
  id,
  title,
  description: '',
  week_number: Number(id.replace('m', '')),
  position: Number(id.replace('m', '')),
  unlock_date,
})

const item = (id: string, moduleId: string, title: string): StudentModuleItem => ({
  id,
  module_id: moduleId,
  item_type: 'lecture',
  title,
  description: '',
  content: {},
  position: 0,
})

/** Five weeks at four columns: row one is m1–m4, row two is m5 alone. */
const MODULES = [
  mod('m1', 'Intro & Setup'),
  mod('m2', 'Lifecycle Data Processing'),
  mod('m3', 'K-Nearest Neighbour'),
  mod('m4', 'Algorithm Basics'),
  mod('m5', 'Data Mining'),
]

const ITEMS: Record<string, StudentModuleItem[]> = {
  m1: [item('i1', 'm1', 'Syllabus')],
  m2: [item('i2', 'm2', 'Lifecycle slides'), item('i3', 'm2', 'Introduction to R')],
  m3: [item('i4', 'm3', 'Distance metrics')],
  m4: [item('i5', 'm4', 'Complexity analysis')],
  m5: [item('i6', 'm5', 'Underwriting case study')],
}

function renderTiles(
  modules: StudentModule[] = MODULES,
  itemsByModule: Record<string, StudentModuleItem[]> = ITEMS,
) {
  return render(
    <StudentModulesList
      sectionId="sec-1"
      modules={modules}
      dividers={[]}
      itemsByModule={itemsByModule}
    />,
  )
}

const tile = (id: string) => document.getElementById(`module-header-${id}`) as HTMLElement
const panel = (id: string) => document.getElementById(`module-panel-${id}`)

/* A single-select Radix ToggleGroup is a radiogroup, so its items are radios —
   named by their visible text, since the items carry no aria-label. */
const tilesRadio = () => screen.getByRole('radio', { name: 'Tiles' })
const listRadio = () => screen.getByRole('radio', { name: 'List' })

/* How many detail panels are open, and the only reliable way to ask. The tile and
   the list section share BOTH the `module-header-<id>` and `module-panel-<id>` ids
   by design (that sharing is what keeps citation deep links working in either
   view), so neither id discriminates. The Collapse button exists only on the tile
   panel. Counting `[id^="module-panel-"]` is also wrong for a second reason: it
   matches the panel's `module-panel-title-<id>` heading too. */
const openPanels = () => screen.queryAllByRole('button', { name: /Collapse/ })

/** True when `b` appears after `a` in document order. */
const precedes = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  mocks.searchParams = new URLSearchParams()
  // The saved preference is what puts the board in tile view at all.
  localStorage.setItem('scholera_modules_view', 'tile')
  /* jsdom has no matchMedia, and the grid asks it how many columns it has. A
     1400px-wide window matches every breakpoint up to xl → four columns. */
  window.matchMedia = ((query: string) => ({
    matches: Number(query.match(/(\d+)px/)?.[1] ?? 0) <= 1400,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

describe('Student Modules — tile view', () => {
  it('renders a tile per week from the remembered preference', () => {
    renderTiles()
    for (const m of MODULES) {
      expect(tile(m.id)).toBeInTheDocument()
    }
    // The tile summarises its contents while closed — "2 readings" for m2.
    expect(tile('m2')).toHaveTextContent('2 readings')
  })

  /* Opening the first section on a first visit is a LIST default. Carried into the
     grid it puts a panel under row one before the reader has clicked anything,
     which reads as though the page did it for them. */
  it('arrives fully collapsed rather than inheriting the list’s first-open default', () => {
    renderTiles()
    expect(openPanels()).toHaveLength(0)
    expect(tile('m1')).toHaveAttribute('aria-expanded', 'false')
  })

  /* …but a week the reader actually opened IS honoured, which is what makes
     switching List → Tiles keep their place. */
  it('opens the week the reader had already opened in the list', () => {
    sessionStorage.setItem('scholera_modules_expanded:sec-1', JSON.stringify(['m3']))
    renderTiles()
    expect(panel('m3')).toBeInTheDocument()
  })

  /* The whole point of the layout: the panel is a sibling AFTER the row, so the
     tiles that share that row keep their place instead of being pushed below it. */
  it('opens the panel after the last tile of the selected tile’s row', () => {
    renderTiles()
    fireEvent.click(tile('m2'))

    const opened = panel('m2')
    expect(opened).toBeInTheDocument()
    expect(opened).toHaveTextContent('Introduction to R')

    // m2 is 2nd of 4 on row one: the panel follows m4 and precedes m5.
    expect(precedes(tile('m4'), opened as Element)).toBe(true)
    expect(precedes(opened as Element, tile('m5'))).toBe(true)
    // And it is NOT nested inside the tile that opened it.
    expect(tile('m2').contains(opened as Node)).toBe(false)
  })

  it('moves the panel to the next row when a later week is selected', () => {
    renderTiles()
    fireEvent.click(tile('m5'))

    const opened = panel('m5') as Element
    // m5 is alone on row two, so nothing follows the panel.
    expect(precedes(tile('m5'), opened)).toBe(true)
  })

  it('keeps exactly one panel open', () => {
    renderTiles()
    fireEvent.click(tile('m2'))
    expect(panel('m2')).toBeInTheDocument()

    fireEvent.click(tile('m4'))
    expect(panel('m4')).toBeInTheDocument()
    expect(panel('m2')).toBeNull()
    expect(openPanels()).toHaveLength(1)
  })

  it('closes the panel via the tile again, and via Collapse', () => {
    renderTiles()

    fireEvent.click(tile('m3'))
    expect(panel('m3')).toBeInTheDocument()
    fireEvent.click(tile('m3'))
    expect(panel('m3')).toBeNull()

    fireEvent.click(tile('m3'))
    fireEvent.click(screen.getByRole('button', { name: /Collapse/ }))
    expect(panel('m3')).toBeNull()
  })

  /* Same disclosure boundary the list enforces: a week that hasn't opened has no
     expand affordance, and the component must not print items even if handed
     some — the page never fetches them, but a component that would is one
     refactor away from being the leak. */
  it('gives a week that is not open yet no way in, and prints none of its items', () => {
    const locked = mod('m6', 'Clustering Methods', FUTURE)
    renderTiles([...MODULES, locked], {
      ...ITEMS,
      m6: [item('i7', 'm6', 'k-means walkthrough')],
    })

    expect(screen.getByText('Clustering Methods')).toBeInTheDocument()
    expect(screen.getByText(/^Opens /)).toBeInTheDocument()
    expect(tile('m6')).toBeNull() // no button, so nothing to click
    expect(screen.queryByText('k-means walkthrough')).not.toBeInTheDocument()
  })

  it('switches back to the list, keeping the week that was open', () => {
    renderTiles()
    fireEvent.click(tile('m4'))

    fireEvent.click(listRadio())

    /* Discriminate the two views by something a styling tweak can't disarm. An
       earlier version asserted `.xl\:grid-cols-4` was absent, which passed after a
       one-character rename of the grid class — and passed with a completely dead
       toggle. The toggle's own state plus a list-only item row can't both lie.
       NOT the tile's contents summary: the collapsed list section prints the same
       string, so it fails to discriminate at all. */
    expect(listRadio()).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Complexity analysis')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Algorithm Basics/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  /* Radix fires onValueChange('') when the ACTIVE item is re-clicked. Falling back
     to the module default ('list') meant this exact gesture — a confirming click,
     a mis-click, or Space on the focused radio — silently dropped the reader out of
     tile view and persisted it. The fastest possible way to lose the feature. */
  it('stays in tiles when the already-selected Tiles button is re-clicked', () => {
    renderTiles()
    fireEvent.click(tile('m2'))

    fireEvent.click(tilesRadio())

    expect(tilesRadio()).toHaveAttribute('aria-checked', 'true')
    expect(panel('m2')).toBeInTheDocument()
    expect(localStorage.getItem('scholera_modules_view')).toBe('tile')
  })
})

/* The layout the reader gets while searching, which is NOT the one the toggle says.
   Matching weeks force-open, and in a grid every open week is full width — so a
   filtered tile view IS a list, assembled by more code. The fallback renders the
   list outright; the preference must survive it untouched. */
describe('Student Modules — tile view during search', () => {
  const search = () => screen.getByRole('searchbox', { name: /Search course materials/ })

  it('hands the page to the list while a search is active', () => {
    renderTiles()
    expect(tile('m2')).toBeInTheDocument()

    fireEvent.change(search(), { target: { value: 'Introduction to R' } })

    /* The list's expanded section renders the matching item inline, and no tile
       detail panel exists — the grid is gone, not merely emptied. */
    expect(screen.getByText('Introduction to R')).toBeInTheDocument()
    expect(openPanels()).toHaveLength(0)
    expect(screen.getByRole('button', { name: /Lifecycle Data Processing/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('returns to tiles when the search is cleared, preference untouched', () => {
    renderTiles()
    fireEvent.change(search(), { target: { value: 'Introduction to R' } })
    // The toggle still reads Tiles even though a list is on screen — accepted cost.
    expect(tilesRadio()).toHaveAttribute('aria-checked', 'true')
    expect(localStorage.getItem('scholera_modules_view')).toBe('tile')

    fireEvent.change(search(), { target: { value: '' } })

    expect(tile('m2')).toBeInTheDocument()
  })
})

/* Citation links (lib/extraction/citation.ts) point into a specific week, and the
   grid resolves them through `selectedModule` rather than the list's expand path.
   Untested, this regressed silently: because the deep-link effect calls expand()
   ADDITIVELY, a reader with Week 1 already open who follows ?section=m3 gets
   expanded = {m1, m3}, and a naive "first expanded in course order" lands them on
   Week 1. Same bug student-modules-deeplink.test.tsx exists to prevent, one layout
   over. */
describe('Student Modules — tile view deep links', () => {
  const renderWithParams = (params: string, modules = MODULES, items = ITEMS) => {
    mocks.searchParams = new URLSearchParams(params)
    return renderTiles(modules, items)
  }

  it('selects the week named by ?section=, not the one left open', () => {
    sessionStorage.setItem('scholera_modules_expanded:sec-1', JSON.stringify(['m1']))
    renderWithParams('section=m3')

    expect(panel('m3')).toBeInTheDocument()
    expect(panel('m1')).toBeNull()
  })

  it('selects the week that owns ?item=', () => {
    renderWithParams('item=i5')
    expect(panel('m4')).toBeInTheDocument()
    expect(panel('m4')).toHaveTextContent('Complexity analysis')
  })

  it('lets an explicit ?section= win over ?item= in another week', () => {
    renderWithParams('section=m3&item=i5')
    expect(panel('m3')).toBeInTheDocument()
    expect(panel('m4')).toBeNull()
  })

  /* The one place the grid can print a week's materials, so the unlock gate has to
     hold here too — a link is not an entitlement. */
  it('refuses to open a week that is not open yet', () => {
    const locked = mod('m6', 'Clustering Methods', FUTURE)
    renderWithParams('section=m6', [...MODULES, locked], {
      ...ITEMS,
      m6: [item('i7', 'm6', 'k-means walkthrough')],
    })

    expect(panel('m6')).toBeNull()
    expect(screen.queryByText('k-means walkthrough')).not.toBeInTheDocument()
    /* And nothing OPENS IN ITS PLACE (#720). The two assertions above were already
       true before the fix and so never caught it: a locked week is excluded from
       `openable`, so its own panel could never appear. What did happen is that the
       deep-link effect ran anyway — `moduleIds` contains a locked week, only an
       unpublished one is absent — and expand('m6') committed the default set to
       sessionStorage and flipped `usingDefault` false. `selectedModule` then fell
       through to "first expanded openable week" and opened WEEK 1. The reader
       followed a link to Clustering Methods and got Intro & Setup, with no
       indication either that they had been redirected or that the week was closed. */
    expect(openPanels()).toHaveLength(0)
  })

  /* The other half of that bug, and the half that outlives the page: expand() wrote
     the visited default into sessionStorage, so "nothing chosen yet" became a
     recorded choice. Every later visit to this course skipped the first-visit
     default because of one click on a link that opened nothing. */
  it('parks no expansion state when the link names a week that is not open yet', () => {
    const locked = mod('m6', 'Clustering Methods', FUTURE)
    renderWithParams('section=m6', [...MODULES, locked], ITEMS)

    expect(sessionStorage.getItem('scholera_modules_expanded:sec-1')).toBeNull()
  })

  it('opens nothing when the link names a week that is not on the page', () => {
    renderWithParams('section=unpublished-module')
    expect(openPanels()).toHaveLength(0)
  })
})
