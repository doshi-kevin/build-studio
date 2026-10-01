// A roadmap link whose destination is the page the reader is already on.
//
// Both "Study with Athena" affordances (the node card's per-skill link and the
// S19 canvas note) point at the roadmap itself with `?athena-topic=` — the param
// AthenaShell consumes to open the chat dock. That makes them STATE changes, not
// navigations, and treating them as navigations is visibly wrong in two ways:
// the canvas note's renderer opens links with target="_blank", so it duplicated
// the roadmap into a second tab, and a router.push refetched this page's whole
// RSC payload (several awaited queries above the Suspense boundary, no
// loading.tsx) before the dock could open — a click with no feedback until the
// server came back.
//
// Writing the param through the History API instead is instant, and Next mirrors
// pushState/replaceState into useSearchParams, which is what AthenaShell and the
// canvas's own `?node=` sync both read.

/**
 * Apply `href` in place when it targets the current page, merging its query on
 * top of the URL already showing.
 *
 * Merged, not replaced: the roadmap keeps its open node card in `?node=`, and
 * dropping that would make the canvas read the card as closed — which pops the
 * history entry the card owns and undoes this very write.
 *
 * @returns true when handled in place; false when the href leaves this page and
 *          the caller should let the browser navigate normally.
 */
export function applySamePageLink(href: string): boolean {
  if (typeof window === 'undefined') return false
  let url: URL
  try {
    url = new URL(href, window.location.origin)
  } catch {
    return false
  }
  if (url.origin !== window.location.origin || url.pathname !== window.location.pathname) return false

  const params = new URLSearchParams(window.location.search)
  url.searchParams.forEach((value, key) => params.set(key, value))
  const qs = params.toString()
  // replaceState, not pushState: the param is consumed and stripped the moment it
  // arrives, so a pushed entry would leave a Back press that visibly does nothing.
  window.history.replaceState(null, '', qs ? `${url.pathname}?${qs}` : url.pathname)
  return true
}
