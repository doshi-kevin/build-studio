'use client'

// Where Radix portals should mount (#653).
//
// Radix portals — Tooltip, Dialog, DropdownMenu, Select, Popover — and Sonner's
// <Toaster> all mount on document.body. Under the Fullscreen API only the fullscreen
// element and its DOM DESCENDANTS are painted in the viewport's top layer, so while a
// professor presents in fullscreen every toast, tooltip and dropdown renders outside it
// and is invisible. That is the failure path, not a cosmetic one: `advanceSlide` fails,
// `toast.error` renders nowhere, and the slide silently doesn't move.
//
// Solved with context rather than a `container` prop threaded through the shared
// primitives. Those primitives have 266 consumers between them (91 dialog, 69 select,
// 44 tooltip, 43 dropdown-menu, 19 popover) and only two components ever go fullscreen —
// a prop would touch every call site to serve two, and would be silently forgotten at
// the 267th.
//
// The default is `undefined`, which is exactly what Radix already receives, so a surface
// that never provides a container behaves byte-identically to before.

import { createContext, useContext } from 'react'

/** The element Radix portals mount into; undefined = document.body (Radix's default). */
const PortalContainerContext = createContext<HTMLElement | undefined>(undefined)

export const PortalContainerProvider = PortalContainerContext.Provider

/**
 * Portal target for the current subtree. Pass straight to a Radix `Portal`'s
 * `container` — `undefined` is the documented "use the default" value.
 */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext)
}
