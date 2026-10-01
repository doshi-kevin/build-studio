/**
 * trapTab — keep Tab/Shift+Tab cycling inside a card that declares
 * `aria-modal="true"` without being a real portal dialog (the tracked-skills
 * drawer's in-drawer cards: mastery settings, delete confirm). Attach as the
 * card's onKeyDown. Without this, Tab walks out into the drawer behind —
 * content assistive tech has just been told doesn't exist.
 */
export function trapTab(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab') return
  const root = e.currentTarget
  const focusables = root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
  )
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}
