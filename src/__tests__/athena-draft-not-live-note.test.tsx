/**
 * "Nothing is in your course yet" — the note that tells a professor an Athena draft
 * card has not written anything (#267).
 *
 * Professors were reading "Athena created the assignment" as "students can see it".
 * Before this note the only signals were a `Draft` pill and a composer-footer line
 * about double-checking drafts — neither said, in words, that the card is inert.
 * A professor acting on that misreading either thinks work is posted when it isn't,
 * or re-does it; both are expensive, so the note is a correctness surface, not decor.
 *
 * Two things are asserted, because the issue's requirement is "EVERY rendered draft":
 *
 *  1. CardShell renders the note, and names the card's own action button — the copy
 *     deliberately points at {approveLabel} instead of saying "publish", because the
 *     ten cards split into two families ("Create assignment" / "Save as draft" leave
 *     something still to publish; "Post discussion" / "Post reply" go live on the
 *     spot). Hardcoding "publish" would be wrong for half of them.
 *  2. Every draft card in the directory actually routes through CardShell. That is
 *     what makes "every" true, and it is the only part a render test can't cover —
 *     an 11th card built with its own markup would inherit nothing and no other
 *     test would notice.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { render, screen } from '@testing-library/react'
import { CardShell } from '@/components/professor/assistant/cards/CardShell'
import { ClipboardList } from 'lucide-react'

const CARDS_DIR = path.join(process.cwd(), 'src/components/professor/assistant/cards')

describe('CardShell — the draft-is-not-live note', () => {
  it('states that nothing exists yet, and names the card action', () => {
    render(
      <CardShell
        icon={ClipboardList}
        title="Draft assignment"
        approveLabel="Create assignment"
        submitting={false}
        onApprove={() => {}}
        onDiscard={() => {}}
      >
        <p>body</p>
      </CardShell>,
    )

    // The claim that kills the misconception. Split across elements by the bolded
    // button name, so match on the container's text rather than a single node.
    const note = screen.getByText(/Nothing is in your course yet/i).closest('p')
    expect(note?.textContent).toContain('Athena only drafts')
    // Points at the real button, not a generic "publish" that would be wrong for
    // the Post-* cards.
    expect(note?.textContent).toContain('Create assignment')
  })

  it('adapts the named action per card, so the instruction is never misleading', () => {
    render(
      <CardShell
        icon={ClipboardList}
        title="Draft discussion"
        approveLabel="Post discussion"
        submitting={false}
        onApprove={() => {}}
        onDiscard={() => {}}
      >
        <p>body</p>
      </CardShell>,
    )

    const note = screen.getByText(/Nothing is in your course yet/i).closest('p')
    expect(note?.textContent).toContain('Post discussion')
    expect(note?.textContent).not.toContain('Create assignment')
  })
})

describe('every Athena draft card inherits the note', () => {
  it('routes every draft card through CardShell', () => {
    const cards = readdirSync(CARDS_DIR).filter((f) => f.endsWith('DraftCard.tsx'))

    // Sanity-check the glob itself — a rename that empties this list must fail the
    // test, not vacuously pass it.
    expect(cards.length).toBeGreaterThanOrEqual(10)

    const bypassing = cards.filter(
      (f) => !readFileSync(path.join(CARDS_DIR, f), 'utf8').includes('CardShell'),
    )
    expect(bypassing).toEqual([])
  })
})
