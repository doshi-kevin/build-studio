/**
 * The "ask line" — Athena's single trigger across the assignments feature and the
 * quiz studio. It replaces the old header toggle button (AthenaTriggerButton).
 *
 * At rest it is a translucent pill fixed to the bottom centre of the viewport,
 * reading just "Ask Athena" with a ⌘K hint. On hover or focus it expands into a
 * real text field. The professor can type a request and press Enter, which opens
 * the dock with that prompt already sent — one step instead of three (click,
 * wait, find the composer). The bot icon is also a real button: click it and the
 * dock opens with whatever's typed, or empty if nothing is — typing first is
 * optional, not required.
 *
 * The field is deliberately FIXED WIDTH. A long prompt scrolls horizontally inside
 * it rather than growing the bar, so typing never moves anything on screen.
 *
 * Mounted per-surface, not once in the provider: three of its call sites gate it
 * conditionally (a studio hides Athena while previewing, or outside the build
 * stage), and mounting here keeps those gates working with no extra plumbing. It
 * is `fixed`, so where it sits in the tree does not matter.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useRef, useState } from 'react'
import { Bot } from 'lucide-react'
import { useAthenaDock, AthenaActivityDot, useAthenaAskLineSlot } from './AssignmentAthenaDock'

export function AthenaAskLine({ className }: { className?: string }) {
  // Only one ask line may render per provider — see useAthenaAskLineSlot. A page and a
  // nested panel can both mount one; two fixed bars overlap and the upper one stops being
  // clickable.
  const mayRender = useAthenaAskLineSlot()
  // No editor registered (a list page) → nothing is "changeable", so don't offer to change it.
  const { hasHost, entitled } = useAthenaDock()
  const { open, setOpen, ask, activity } = useAthenaDock()
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)

  // Expanded whenever the professor is engaging with it, or has text in flight.
  const expanded = hovered || focused || value.length > 0

  // ⌘K / Ctrl+K puts the cursor in the field; if the dock is already open it
  // closes it instead. Resolved through the DOM rather than this instance's ref so
  // that a bar gated off-screen makes the shortcut a harmless no-op, and a
  // transient double-mount during navigation converges on one element. Same
  // approach the dock already uses for [data-athena-trigger].
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return
      const input = document.querySelector<HTMLInputElement>('input[data-athena-ask-input]')
      if (!input) return
      e.preventDefault()
      if (open) {
        setOpen(false)
        return
      }
      input.focus()
      input.select()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, setOpen])

  const submit = () => {
    const trimmed = value.trim()
    setValue('')
    inputRef.current?.blur()
    // Empty field is still a valid "just open it" gesture.
    if (trimmed) ask(trimmed)
    else setOpen(true)
  }

  if (!mayRender) return null
  /* The school does not have Athena. Offering the bar would invite the
     professor into a request the API refuses by design, which is how QA found
     a raw JSON envelope in a toast next to "Try again." for a refusal that can
     never succeed. The AI kill switch is deliberately NOT handled here: that is
     a temporary safety state, and the bar stays with a policy message. */
  if (!entitled) return null

  return (
    <label
      // The bar retires while the dock is open — the dock has its own composer, and two
      // inputs for the same conversation is one too many. `inert` (not just
      // pointer-events) so the hidden field leaves the tab order and the a11y tree,
      // the same way the dock's own panel hides itself when closed.
      inert={open}
      // The three states are ONE exclusive chain, never merged. Tailwind resolves
      // conflicting utilities by its own emission order — not by where a class sits in
      // this string — so emitting `opacity-0` alongside `opacity-90` silently keeps the
      // wrong one and the bar never fades. Each branch owns its own opacity and size.
      className={`fixed bottom-12 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card/60 px-2.5 backdrop-blur-md transition-[width,height,opacity,background-color,border-color,box-shadow,transform] ease-drawer has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50 motion-reduce:transition-none md:bottom-5 ${
        open
          ? // Retired: the dock has its own composer. Leaving is quicker than arriving —
            // `inert` applies instantly, so a slow fade leaves a visible-but-dead bar.
            'h-11 w-56 translate-y-5 opacity-0 duration-200 md:h-7 md:w-42'
          : expanded
            ? 'h-11 w-80 cursor-text border-border bg-card/90 opacity-100 shadow-lg duration-500 md:h-9'
            : // Resting. NO layer opacity here, deliberately — that was the bug behind three
              // rounds of "where is the textbox?". Layer opacity MULTIPLIES against the
              // label's own `text-muted-foreground`, which is already a recessive token, so
              // the two compounded: even at 75% the label measured ~2.6:1 against the page,
              // under WCAG 1.4.3's 4.5:1, and no opacity value fixes that without also
              // killing the recession the design wants. Let the tokens carry it instead —
              // `text-muted-foreground` on `bg-card` is a vetted, compliant pair — and the
              // bar is legible at full strength while still reading as quiet.
              //
              // Activity therefore has to signal through something other than opacity, so
              // it uses the border: working/has-a-result tints toward primary and firms the
              // card up. That also satisfies "don't rely on opacity alone" for anyone whose
              // OS asked for more contrast, which is why `contrast-more:` is gone too.
              // Size is UNCHANGED (h-7 / w-42 on desktop) — this is contrast only.
              `h-11 w-56 cursor-text opacity-100 shadow-sm duration-500 md:h-7 md:w-42 ${
                activity === 'idle' ? 'border-border' : 'border-primary/50 bg-card/90'
              }`
      } ${className ?? ''}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label="Open Athena"
        title="Open Athena"
        // Stop the parent label's default action (focusing the input) — this
        // button already did the thing focusing was a means to.
        onClick={(e) => {
          e.stopPropagation()
          submit()
        }}
        // A bare 14px icon reads as decoration, not a control — nothing about it changed
        // when it became clickable. The hover/focus pill is the same "this is a button"
        // affordance icon-only buttons use elsewhere; the negative margin keeps the bigger
        // hit target from nudging the row's layout.
        className="-m-1 shrink-0 rounded-full p-1 transition-colors duration-200 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Bot
          aria-hidden="true"
          className={`h-3.5 w-3.5 transition-colors duration-300 ${focused ? 'text-primary' : 'text-muted-foreground'}`}
        />
      </button>

      {/* Two placeholders crossfade. Swapping one string would pop mid-transition,
          and a real ::placeholder can't be transitioned, so they live outside the
          input and hide as soon as there is a value. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute left-8 text-xs font-medium text-muted-foreground transition-opacity duration-300 ${
          expanded || value ? 'opacity-0' : 'opacity-100'
        }`}
      >
        Ask Athena
      </span>
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute left-8 text-xs font-medium text-muted-foreground transition-opacity duration-300 ${
          expanded && !value ? 'opacity-100 delay-100' : 'opacity-0'
        }`}
      >
        {hasHost ? 'Tell Athena what to change…' : 'Ask about this course…'}
      </span>

      <input
        ref={inputRef}
        // Resolves the ⌘K shortcut; see the handler above.
        data-athena-ask-input=""
        // The dock restores focus here when it closes (WCAG 2.4.3).
        data-athena-trigger
        type="text"
        value={value}
        autoComplete="off"
        spellCheck={false}
        // STABLE name. Activity used to be appended here, which no screen reader ever
        // announces (the field isn't focused when it changes), re-announces the field
        // mid-typing when it is, and breaks voice control's "click Ask Athena" (WCAG
        // 2.5.3). Activity now lives in the provider's live region instead.
        aria-label="Ask Athena"
        // The ⌘K chip is aria-hidden decoration, so this is the only way a screen
        // reader user learns the shortcut exists.
        aria-keyshortcuts="Meta+K Control+K"
        // Relabels the iOS virtual return key to "Send" — the only submit affordance on
        // touch, where there's no hover and ⌘K means nothing.
        enterKeyHint="send"
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            // Blur only — Escape is a reflex, and wiping a half-written prompt with no
            // undo is worse than leaving the bar expanded holding the draft.
            e.preventDefault()
            inputRef.current?.blur()
          }
        }}
        // text-base below md: iOS Safari zooms the viewport on focus for any input under
        // 16px. Same defence as ui/input.tsx and ui/textarea.tsx.
        // pr-8 keeps the scrolling text clear of the ⌘K chip.
        className="h-full min-w-0 flex-1 bg-transparent pr-8 text-base font-medium text-foreground outline-none md:text-xs"
      />

      {/* No opacity of its own. It used to carry `opacity-75` AND `text-…/80`, which
          multiplied with the bar's own 40% to 0.24 — leaving the one element that is
          meant to read at rest dimmer than the label beside it. It fades with the bar. */}
      <kbd
        aria-hidden="true"
        className="pointer-events-none absolute right-2 rounded-md border border-border/60 bg-card/80 px-1 font-mono text-xs leading-4 text-muted-foreground"
      >
        ⌘K
      </kbd>

      <AthenaActivityDot activity={activity} className="-right-0.5 -top-0.5" />
    </label>
  )
}
