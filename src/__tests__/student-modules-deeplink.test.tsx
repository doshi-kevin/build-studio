// The retired `/modules/[moduleId]` route redirects to the one-page board via
// buildModulesHref(), which always appends `?section=<moduleId>`. ModulesBoard
// (professor) reads it; StudentModulesList did not, so a student following one
// of those links landed on the board with the DEFAULT first section open and
// the linked module still shut — the exact case the shim exists to fix.
//
// Browser QA measured it: professor targetExpanded=true, student false, on the
// same hop. These tests pin the student side to the professor's behaviour.
//
// Oracle is `aria-expanded` on each section header, not the presence of item
// rows: it is the user-visible state, it works for a module with zero items
// (which renders placeholder copy instead of rows), and it does not depend on
// the row tree — so this file needs no component mocks.
//
// scrollIntoView is asserted by ELEMENT IDENTITY only (which branch ran), never
// by geometry: jsdom has no layout, so asserting `behavior: 'smooth'` would be
// hollow. The repo stubs it the same way in quiz-studio-sidebar.test.tsx and
// athena-ask-line.test.tsx.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { StudentModulesList } from '@/components/student/modules/StudentModulesList'
import type { StudentModule, StudentModuleItem } from '@/components/student/modules/types'
import type { ModuleDivider } from '@/components/shared/modules/module-rows'

let searchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
}))

// jsdom has no scrollIntoView (same stub as quiz-studio-sidebar.test.tsx:22).
const scrollIntoView = vi.fn()
Element.prototype.scrollIntoView = scrollIntoView

const STORAGE_KEY = 'scholera_modules_expanded:sec-1'

function mod(id: string, title: string, position: number, unlock_date: string | null = null): StudentModule {
  return { id, title, description: '', week_number: position, position, unlock_date }
}

function item(id: string, moduleId: string): StudentModuleItem {
  return {
    id,
    module_id: moduleId,
    item_type: 'lecture',
    title: `Item ${id}`,
    description: '',
    content: {},
    position: 0,
  }
}

// m3 deliberately holds no items — an empty module still has to expand.
const MODULES = [
  mod('m1', 'Week 1 Intro', 1),
  mod('m2', 'Week 2 Attention', 2),
  mod('m3', 'Week 3 Empty', 3),
]
const ITEMS: Record<string, StudentModuleItem[]> = {
  m1: [item('i1', 'm1')],
  m2: [item('i2', 'm2')],
}

/** The section header button carries aria-expanded and the module's title. */
function expandedState(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const m of MODULES) {
    const header = screen.getByRole('button', { name: new RegExp(m.title) })
    out[m.id] = header.getAttribute('aria-expanded') === 'true'
  }
  return out
}

function renderList(storedExpansion?: string[], dividers: ModuleDivider[] = []) {
  if (storedExpansion) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(storedExpansion))
  return render(
    <StudentModulesList
      sectionId="sec-1"
      modules={MODULES}
      dividers={dividers}
      itemsByModule={ITEMS}
    />,
  )
}

function stored(): string[] {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  return raw ? (JSON.parse(raw) as string[]) : []
}

describe('StudentModulesList deep links', () => {
  beforeEach(() => {
    sessionStorage.clear()
    /* The layout preference lives in localStorage, and these oracles assume the
       LIST. Pin the premise rather than inheriting the default — 11 of these passed
       against the tile grid when DEFAULT_MODULES_VIEW was flipped to 'tile'. Tile
       coverage of the same deep links lives in student-modules-tile-view.test.tsx. */
    localStorage.clear()
    searchParams = new URLSearchParams()
    scrollIntoView.mockClear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the module named by ?section= and leaves the default one shut', () => {
    // Seeded from an empty stored choice so the default-open first section is
    // out of the picture — otherwise this passes against an implementation that
    // simply expands everything.
    searchParams = new URLSearchParams('section=m2')
    renderList([])

    expect(expandedState()).toEqual({ m1: false, m2: true, m3: false })
  })

  it('still opens the section holding ?item= when no ?section= is given', () => {
    searchParams = new URLSearchParams('item=i2')
    renderList([])

    expect(expandedState()).toEqual({ m1: false, m2: true, m3: false })
  })

  it('honours the legacy ?highlight= alias', () => {
    searchParams = new URLSearchParams('highlight=i2')
    renderList([])

    expect(expandedState()).toEqual({ m1: false, m2: true, m3: false })
  })

  it('prefers ?section= over the module holding ?item=', () => {
    // buildModulesHref forwards the original query AND sets section=, so both
    // arrive together. The explicit section must win, as on the professor board.
    searchParams = new URLSearchParams('section=m2&item=i1')
    renderList([])

    expect(expandedState().m2).toBe(true)
  })

  it('opens a ?section= module that has no items', () => {
    searchParams = new URLSearchParams('section=m3')
    renderList([])

    expect(expandedState().m3).toBe(true)
  })

  it('adds to the reader’s existing choice rather than replacing it', () => {
    searchParams = new URLSearchParams('section=m1')
    renderList(['m2'])

    expect(expandedState()).toEqual({ m1: true, m2: true, m3: false })
    expect(stored()).toEqual(['m2', 'm1'])
  })

  it('ignores a ?section= id that is not on the page and never stores it', () => {
    // A student's list excludes unpublished modules, so a link to one resolves
    // to nothing here. Expanding it would only park dead state.
    searchParams = new URLSearchParams('section=m-unpublished')
    renderList([])

    expect(expandedState()).toEqual({ m1: false, m2: false, m3: false })
    expect(stored()).not.toContain('m-unpublished')
  })

  it('clears the item pulse even when ?section= does not resolve', () => {
    // The guard's early return used to sit above the pulse's clear-timer, so
    // this pair left the row ringed for the life of the page. No stored choice,
    // so m1 is open by default and i1's row (and its ring) actually renders.
    searchParams = new URLSearchParams('section=m-unpublished&item=i1')
    renderList()

    const ringed = () => document.querySelector('.ring-2') !== null
    expect(ringed()).toBe(true)
    // act() so the timer's setState is flushed to the DOM before we re-read it.
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(ringed()).toBe(false)
  })

  it('scrolls to the item when one is named, and to the section otherwise', () => {
    searchParams = new URLSearchParams('item=i2')
    const first = renderList([])
    vi.advanceTimersByTime(400)
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById('module-item-i2'))
    first.unmount()

    scrollIntoView.mockClear()
    sessionStorage.clear()
    searchParams = new URLSearchParams('section=m2')
    renderList([])
    vi.advanceTimersByTime(400)
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById('module-panel-m2'))
  })

  it('falls back to the section when the named item is in a module it did not open', () => {
    // i1 lives in m1, which stays shut — so its row is not in the DOM at all.
    searchParams = new URLSearchParams('section=m2&item=i1')
    renderList([])
    vi.advanceTimersByTime(400)

    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById('module-panel-m2'))
  })

  it('falls back to the default first section with no deep link at all', () => {
    renderList()

    expect(expandedState()).toEqual({ m1: true, m2: false, m3: false })
  })

  /* Dividers landed in this same render path from the roadmap branch. They sit
     BETWEEN sections in the merged row list, so a resolution that walked the
     rendered list by index rather than by id would open the wrong section once
     a divider shifted everything down. */
  it('resolves ?section= to the same module when a divider sits above it', () => {
    searchParams = new URLSearchParams('section=m2')
    renderList([], [{ id: 'd1', title: 'Unit 2', position: 1 }])

    expect(screen.getByText('Unit 2')).toBeInTheDocument()
    expect(expandedState()).toEqual({ m1: false, m2: true, m3: false })
  })
})
