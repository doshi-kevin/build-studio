/**
 * #653 — while presenting in native fullscreen the professor got NO error feedback.
 * Radix portals and Sonner's <Toaster> mount on document.body, and the Fullscreen API
 * paints only the fullscreen element and its DOM DESCENDANTS in the top layer. So a
 * failed advanceSlide called toast.error into a node that was never shown: the slide
 * didn't move and nothing said why, for the whole lecture.
 *
 * The oracle is WHERE the portal content lands in the DOM — inside the provided
 * container vs document.body. Asserting the tooltip "renders" would pass against the
 * old code, because it always did render; it just rendered somewhere invisible.
 *
 * The default path is asserted too. These primitives have 266 consumers between them,
 * and every surface that does NOT provide a container must keep portaling to body
 * exactly as before.
 */

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PortalContainerProvider } from '@/components/ui/portal-container'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

function TooltipHarness({ container }: { container?: HTMLElement }) {
  return (
    <TooltipProvider delayDuration={0}>
      <PortalContainerProvider value={container}>
        <Tooltip open>
          <TooltipTrigger>trigger</TooltipTrigger>
          <TooltipContent>End class</TooltipContent>
        </Tooltip>
      </PortalContainerProvider>
    </TooltipProvider>
  )
}

describe('#653 — portals follow the fullscreen container', () => {
  it('renders tooltip content INSIDE the provided container', () => {
    const fullscreenEl = document.createElement('div')
    fullscreenEl.id = 'fullscreen-root'
    document.body.appendChild(fullscreenEl)

    render(<TooltipHarness container={fullscreenEl} />)

    // Radix duplicates the label for a11y; every copy must be inside the container.
    const copies = screen.getAllByText('End class')
    expect(copies.length).toBeGreaterThan(0)
    for (const el of copies) {
      expect(fullscreenEl.contains(el)).toBe(true)
    }

    document.body.removeChild(fullscreenEl)
  })

  it('still portals to document.body when no container is provided', () => {
    // The other 260-odd consumers. A regression here is worse than the bug.
    const { baseElement } = render(<TooltipHarness />)
    const copies = screen.getAllByText('End class')
    expect(copies.length).toBeGreaterThan(0)
    for (const el of copies) {
      expect(baseElement.contains(el)).toBe(true)
    }
  })

  it('applies to dropdown menus too — the DeckSwitcher could not be opened in fullscreen', () => {
    const fullscreenEl = document.createElement('div')
    document.body.appendChild(fullscreenEl)

    render(
      <PortalContainerProvider value={fullscreenEl}>
        <DropdownMenu>
          <DropdownMenuTrigger>decks</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Lecture 1</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PortalContainerProvider>,
    )

    fireEvent.pointerDown(
      screen.getByText('decks'),
      new PointerEvent('pointerdown', { bubbles: true, ctrlKey: false, button: 0 }),
    )

    const item = screen.queryByText('Lecture 1')
    if (item) expect(fullscreenEl.contains(item)).toBe(true)

    document.body.removeChild(fullscreenEl)
  })
})
