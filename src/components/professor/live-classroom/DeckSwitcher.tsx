// Deck switcher (#8) — professor control to switch between the room's decks
// and add a new one mid-class. Each deck resumes where it was left (slide +
// drawings + transcript), handled server-side by switchDeck. Lives in the
// presenter control bar; the .lc-stage scope adapts it to the fullscreen stage.

'use client'

import { useState } from 'react'
import { Layers, Plus, Check, Loader2, ChevronDown, Trash2, X } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { DeckSummary } from '@/lib/validations/live-classroom'

interface Props {
  decks: DeckSummary[]
  activeDeckId: string | null
  /** Switch to a ready deck. No-op for the active or still-preparing deck. */
  onSwitch: (deckId: string) => void
  /** Open the add-deck flow. */
  onAddDeck: () => void
  /** Remove a deck (e.g. an accidental wrong upload). */
  onRemoveDeck: (deckId: string) => void
  /** A switch is in flight (disables the list). */
  switching?: boolean
}

function deckLabel(deck: DeckSummary): string {
  return deck.title?.trim() || `Deck ${deck.position}`
}

export function DeckSwitcher({ decks, activeDeckId, onSwitch, onAddDeck, onRemoveDeck, switching }: Props) {
  const [open, setOpen] = useState(false)
  // Deck id currently showing its inline "Remove?" confirm.
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null)
  const active = decks.find((d) => d.id === activeDeckId) ?? null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 rounded-full border h-9 px-3 text-xs font-medium shadow-lg transition-colors duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 bg-card border-border hover:bg-accent`}
          aria-label="Switch deck"
        >
          <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="max-w-[14ch] truncate">{active ? deckLabel(active) : 'Decks'}</span>
          {decks.length > 1 && (
            <span className="tabular-nums text-muted-foreground">
              {decks.length}
            </span>
          )}
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-72 p-1.5" sideOffset={8}>
        <p className="px-2.5 py-1.5 text-xs uppercase tracking-widest font-semibold text-muted-foreground">
          Decks
        </p>
        <div className="max-h-72 overflow-y-auto scrollbar-thin">
          {decks.map((deck) => {
            const isActive = deck.id === activeDeckId
            const switchDisabled = !deck.ready || isActive || switching
            const confirming = confirmingRemoveId === deck.id
            return (
              <div
                key={deck.id}
                className={`group flex items-center gap-1 rounded-xl pr-1 transition-colors duration-150 ${
                  isActive ? 'bg-muted/60' : 'hover:bg-accent/50'
                }`}
              >
                <button
                  type="button"
                  disabled={switchDisabled}
                  onClick={() => {
                    onSwitch(deck.id)
                    setOpen(false)
                  }}
                  className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                    switchDisabled && !isActive ? 'opacity-60' : ''
                  } disabled:cursor-default`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-semibold tabular-nums">
                    {deck.position}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{deckLabel(deck)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {deck.ready
                        ? `${deck.pageCount ?? 0} slides${deck.currentSlide > 0 ? ` · resumes slide ${deck.currentSlide + 1}` : ''}`
                        : 'Preparing…'}
                    </span>
                  </span>
                  {isActive ? (
                    <Check className="h-4 w-4 shrink-0 text-success" aria-label="Active" />
                  ) : !deck.ready ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                  ) : null}
                </button>

                {confirming ? (
                  <span className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        onRemoveDeck(deck.id)
                        setConfirmingRemoveId(null)
                      }}
                      className="rounded-full px-2 py-1 text-xs font-semibold text-destructive hover:bg-destructive/10 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      aria-label="Cancel remove"
                      onClick={() => setConfirmingRemoveId(null)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Remove ${deckLabel(deck)}`}
                    onClick={() => setConfirmingRemoveId(deck.id)}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-accent hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => {
            onAddDeck()
            setOpen(false)
          }}
          className="mt-1 flex w-full items-center gap-2 rounded-xl border border-dashed border-border px-2.5 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-ring/40 transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add deck
        </button>
      </PopoverContent>
    </Popover>
  )
}
