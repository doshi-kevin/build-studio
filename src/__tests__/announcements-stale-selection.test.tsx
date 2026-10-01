// The professor reading pane holds its selection in `?a=<id>` instead of local
// state, which means the URL can name an announcement that no longer exists —
// a deleted announcement, or a stale/shared link. AnnouncementList has an
// effect that drops such an id back to the bare path.
//
// The failure mode worth guarding is the effect being scoped wrong in either
// direction: too eager and it clears VALID selections (the reading pane becomes
// unopenable), too loose and a stale id sits in the URL pointing at an empty
// pane. Both are invisible to typecheck.
//
// Deliberately NOT tested here: the push-vs-replace history choice and the
// tri-state `pendingId`. Both only differ while a router transition is still
// pending, and jsdom settles the transition between clicks — the fixed and the
// buggy code produce identical calls here, so a test would assert nothing.
// Those belong in a live browser walkthrough.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AnnouncementList } from '@/components/professor/announcements/AnnouncementList'
import type { Announcement } from '@/lib/supabase/types'

const replace = vi.fn()
let searchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => searchParams,
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), info: vi.fn() },
}))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/announcements/actions', () => ({
  toggleAnnouncementPin: vi.fn(),
  /* The reading pane now loads the announcement's comments, which the professor could not
     see before (#669 part 2). Not under test here; resolve empty so the pane still renders. */
  getAnnouncementCommentsForStaff: vi.fn(async () => ({ data: [] })),
}))
// The create/edit dialogs pull in the tiptap editor and the detail pane pulls in
// the rich-content renderer; neither is under test and both drag CSS imports
// vitest can't resolve.
vi.mock('@/components/professor/announcements/CreateAnnouncementDialog', () => ({
  CreateAnnouncementDialog: () => null,
}))
vi.mock('@/components/professor/announcements/DeleteAnnouncementDialog', () => ({
  DeleteAnnouncementDialog: () => null,
}))
vi.mock('@/components/shared/announcements/RichContentRenderer', () => ({
  RichContentRenderer: () => null,
}))
vi.mock('@/components/ui/material-viewer', () => ({ MaterialViewer: () => null }))

const BASE_PATH = '/professor/courses/sec-1/announcements'

function buildAnnouncement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: 'ann-1',
    title: 'Week 1 reading',
    content: 'Chapters 1 through 3.',
    status: 'published',
    published_at: '2026-01-05T12:00:00Z',
    scheduled_at: null,
    is_pinned: false,
    is_important: false,
    requires_acknowledgement: false,
    visibility: 'all',
    attachments: [],
    links: [],
    rich_content: null,
    allow_reactions: true,
    allow_comments: true,
    section_id: 'sec-1',
    ...overrides,
  } as Announcement
}

function renderList(announcements: Announcement[]) {
  return render(<AnnouncementList sectionId="sec-1" announcements={announcements} />)
}

describe('AnnouncementList — stale ?a= selection', () => {
  beforeEach(() => {
    replace.mockClear()
    searchParams = new URLSearchParams()
  })

  it('drops a ?a= id that no longer resolves to an announcement', () => {
    searchParams = new URLSearchParams('a=deleted-ann')

    renderList([buildAnnouncement()])

    // Back to the bare path, once — a re-firing effect here would be a redirect loop.
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith(BASE_PATH, { scroll: false })
  })

  it('keeps a ?a= id that resolves, and opens it in the reading pane', () => {
    searchParams = new URLSearchParams('a=ann-2')

    renderList([
      buildAnnouncement(),
      buildAnnouncement({ id: 'ann-2', title: 'Midterm moved to Friday' }),
    ])

    expect(replace).not.toHaveBeenCalled()
    // The detail pane renders the selected announcement, not the empty state.
    expect(screen.getByRole('heading', { name: 'Midterm moved to Friday' })).toBeTruthy()
    expect(screen.queryByText('No announcement selected')).toBeNull()
  })

  it('leaves the URL alone when nothing is selected', () => {
    renderList([buildAnnouncement()])

    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByText('No announcement selected')).toBeTruthy()
  })
})
