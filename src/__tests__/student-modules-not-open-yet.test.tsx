/**
 * A week behind a future `modules.unlock_date` on the student Modules page.
 *
 * Three states get confused easily, and the page has to distinguish two of them
 * on screen:
 *   - unpublished  → never in `modules` at all (the query drops it server-side)
 *   - not open yet → LISTED, dimmed, "Opens Aug 6", holding nothing
 *   - open         → normal, expandable
 *
 * The middle one is shown rather than hidden so the student can see the course
 * continues past today — the same call the roadmap makes. What's withheld is the
 * CONTENTS: the page never fetches items for a locked module, so these render with
 * an empty `itemsByModule`, exactly as the server hands them over. The oracle is
 * therefore "no disclosure, and no expand affordance", not item counts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StudentModulesList } from '@/components/student/modules/StudentModulesList'
import type { StudentModule, StudentModuleItem } from '@/components/student/modules/types'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
const PAST = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()

const mod = (
  id: string,
  title: string,
  position: number,
  unlock_date: string | null = null,
): StudentModule => ({ id, title, description: '', week_number: position, position, unlock_date })

const item = (id: string, moduleId: string, title: string): StudentModuleItem => ({
  id,
  module_id: moduleId,
  item_type: 'lecture',
  title,
  description: '',
  content: {},
  position: 0,
})

const OPEN = mod('m1', 'Transformers', 7)
const LOCKED = mod('m2', 'Reasoning & Agents', 9, FUTURE)

function renderList(modules: StudentModule[], itemsByModule: Record<string, StudentModuleItem[]>) {
  return render(
    <StudentModulesList
      sectionId="sec-1"
      modules={modules}
      dividers={[]}
      itemsByModule={itemsByModule}
    />,
  )
}

/* localStorage too: the layout preference lives there, and every oracle below
   assumes the LIST. Without this the file silently inherits whatever the default
   happens to be — flipping DEFAULT_MODULES_VIEW to 'tile' passed all five of these
   in the wrong layout, because the tile and the list section share both the
   `module-header-<id>` id and `aria-expanded`. Pin the premise. */
beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('StudentModulesList — weeks that are not open yet', () => {
  it('lists the closed week and says when it opens', () => {
    renderList([OPEN, LOCKED], { m1: [item('i1', 'm1', 'Lecture 6: Transformers')] })
    // Present — the point of showing it at all is that the course visibly continues.
    expect(screen.getByText('Reasoning & Agents')).toBeInTheDocument()
    expect(screen.getByText(/^Opens /)).toBeInTheDocument()
  })

  /* The disclosure boundary. A closed week's row must offer no way in — and since
     the server never fetched its items, there is nothing behind it to open. The
     oracle is the header button (which carries aria-expanded), not any button on
     the page: the toolbar's filter radios are buttons too. */
  it('gives the closed week no expand control, while the open one keeps its own', () => {
    renderList([OPEN, LOCKED], { m1: [item('i1', 'm1', 'Lecture 6: Transformers')] })
    expect(screen.getByRole('button', { name: /Transformers/ })).toHaveAttribute('aria-expanded')
    expect(screen.queryByRole('button', { name: /Reasoning & Agents/ })).toBeNull()
  })

  /* Defence in depth: if a caller ever DID pass a locked week's items, the row must
     still not render them. The gate is the loader, but a component that would
     happily print them is one refactor away from being the leak. */
  it('renders no item titles for a closed week even when handed some', () => {
    renderList([OPEN, LOCKED], {
      m1: [item('i1', 'm1', 'Lecture 6: Transformers')],
      m2: [item('i2', 'm2', 'Lecture 9: Reasoning and Agents')],
    })
    expect(screen.queryByText('Lecture 9: Reasoning and Agents')).not.toBeInTheDocument()
  })

  // A date that has passed is spent — the week is simply open, as if it were unset.
  it('treats a past unlock date as open', () => {
    const opened = mod('m3', 'Word Vectors', 4, PAST)
    renderList([opened], { m3: [item('i3', 'm3', 'Lecture 3: Word Vectors')] })
    expect(screen.queryByText(/^Opens /)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Word Vectors/ })).toHaveAttribute('aria-expanded')
  })

  /* The summary line counts a closed week as a module but not as items — without
     its own segment the line would read "2 modules · 1 item" and make the closed
     week look like one the professor forgot to fill. */
  it('counts the closed week as a module, not as items, and names it', () => {
    renderList([OPEN, LOCKED], { m1: [item('i1', 'm1', 'Lecture 6: Transformers')] })
    expect(screen.getByText(/2 modules.*1 item.*1 not open yet/)).toBeInTheDocument()
  })
})
