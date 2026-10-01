// SetupSpotlight always shows on a new resource (the naming + "Start building"
// step matters even with no modules) — but only the MODULE PICKER is
// conditional: shown when the section has modules, dropped when it has none.
// Guards the exact behaviour the no-modules branch exists to provide.
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/roadmap/placement-actions', () => ({ getPlacementModules: vi.fn() }))

import { getPlacementModules } from '@/lib/roadmap/placement-actions'
import { SetupSpotlight } from '@/components/professor/roadmap/SetupSpotlight'

const mockGet = vi.mocked(getPlacementModules)

function renderSpotlight() {
  const onOpenChange = vi.fn()
  render(
    <SetupSpotlight
      open
      onOpenChange={onOpenChange}
      sectionId="sec-1"
      description="Name it and place it."
      ariaLabel="Set up your new quiz"
      onConfirm={vi.fn()}
    >
      <input aria-label="title" />
    </SetupSpotlight>,
  )
  return onOpenChange
}

beforeEach(() => mockGet.mockReset())

describe('SetupSpotlight — no-modules behaviour', () => {
  it('still shows the popup (naming + Start building) but hides the module picker when there are no modules', async () => {
    mockGet.mockResolvedValue({ data: [] })
    const onOpenChange = renderSpotlight()
    // Popup appears for the naming step…
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start building/i })).toBeInTheDocument()
    // …and once the (empty) module fetch resolves, there is NO picker and no
    // auto-dismiss.
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByText(/module it belongs to/i)).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('shows the module picker when the section has modules', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'm1', title: 'Week 1', weekNumber: 1 }] })
    renderSpotlight()
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByRole('combobox')).toBeInTheDocument()
    expect(screen.getByText(/module it belongs to/i)).toBeInTheDocument()
  })
})
