// Auto-generated study flashcards — click-to-flip cards (no drag). Front =
// prompt/term, back = the answer. The face crossfades on flip and the card
// lifts on hover; motion is skipped under prefers-reduced-motion.

'use client'

import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import type { Flashcard } from '@/lib/validations/lc-class-insights'
import { SPRING_SNAPPY } from '@/lib/motion'

export function FlashcardDeck({ cards }: { cards: Flashcard[] }) {
  if (cards.length === 0) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {cards.map((card, i) => (
        <FlashcardItem key={i} card={card} />
      ))}
    </div>
  )
}

function FlashcardItem({ card }: { card: Flashcard }) {
  const [flipped, setFlipped] = useState(false)
  const reduce = useReducedMotion()
  return (
    <button
      type="button"
      onClick={() => setFlipped((v) => !v)}
      aria-pressed={flipped}
      className="flex min-h-[120px] flex-col rounded-2xl border border-border bg-card p-4 text-left transition duration-200 ease-out hover:-translate-y-0.5 hover:border-ring/40 hover:shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {card.concept}
      </span>
      <div className="flex-1 text-sm">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={flipped ? 'back' : 'front'}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={SPRING_SNAPPY}
            className={flipped ? '' : 'font-medium'}
          >
            <MarkdownLatex content={flipped ? card.back : card.front} />
          </motion.div>
        </AnimatePresence>
      </div>
      <span className="mt-3 text-xs text-muted-foreground">
        {flipped ? 'Tap to hide answer' : 'Tap to reveal answer'}
      </span>
    </button>
  )
}
