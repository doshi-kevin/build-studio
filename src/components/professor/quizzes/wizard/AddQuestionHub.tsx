// Center-canvas add hub — Option D's landing screen, reused mid-quiz via the
// rail's "Add from AI, bank & import" button. One component, two moments:
// first visit ("Start with your first question") and re-opened ("Add questions").

'use client'

import { Bot, Import, Library, PenLine } from 'lucide-react'
import type { QuizItemType } from '@/lib/validations/quiz'
import { AddQuestionSplitButton } from './AddQuestionSplitButton'

interface AddQuestionHubProps {
  /** True when the quiz has no questions yet — adjusts heading copy only */
  firstVisit: boolean
  stickyType: QuizItemType
  onAddType: (type: QuizItemType) => void
  /** Whether Adaptive Mode is on — unlocks the Explanation/Walkthrough types */
  adaptive: boolean
  /** Opens the Athena dock — the single AI entry point. */
  onOpenAthena: () => void
  onOpenBank: () => void
  onOpenJSON: () => void
}

export function AddQuestionHub({
  firstVisit,
  stickyType,
  onAddType,
  adaptive,
  onOpenAthena,
  onOpenBank,
  onOpenJSON,
}: AddQuestionHubProps) {
  return (
    // min-h-full (not h-full): when zoom/short viewports make the content
    // taller than the canvas, the hub grows and the canvas scrolls instead of
    // flex compressing the children (the split button was collapsing).
    <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center px-6 py-10 text-center">
      <PenLine className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <h2 className="mt-2 text-lg font-semibold text-foreground">
        {firstVisit ? 'Start with your first question' : 'Add questions'}
      </h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        One click adds a question of your default type. Pick a different type from the arrow
        once — it sticks for every question after.
      </p>

      {/* Split button — one-click sticky-type add; the ingestion paths live in
          the cards below */}
      <AddQuestionSplitButton
        stickyType={stickyType}
        onAddType={onAddType}
        adaptive={adaptive}
        menuAlign="center"
        className="mx-auto mt-5 w-fit"
      />

      {/* The signpost into Athena. Consolidating five AI surfaces into one was the point;
          deleting the last LABEL for it was not — a capability reachable only behind a
          proper-noun button effectively doesn't exist for the ~85% of professors who never
          go exploring. Named in their words, not ours, and sat with the authoring paths
          rather than under "bring questions in": generating from your own lectures is
          authoring, not importing. */}
      <button
        type="button"
        onClick={onOpenAthena}
        className="mx-auto mt-3 flex min-h-11 w-fit items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bot className="h-4 w-4 text-primary" aria-hidden="true" />
        Generate questions with AI
        <span className="text-xs text-muted-foreground">from your lecture material</span>
      </button>

      <div className="mt-7 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">or bring questions in</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {/* Ingestion cards. AI generation is not here — it lives in Athena, in the header,
          where the professor can say what they want instead of filling in a form. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <HubCard
          icon={<Library className="h-4 w-4" aria-hidden="true" />}
          title="Pick from question bank"
          description="Reuse questions from this section's question bank, with search and filters."
          onClick={onOpenBank}
        />
        <HubCard
          icon={<Import className="h-4 w-4" aria-hidden="true" />}
          title="Import questions"
          description="Bring questions in from another tool — paste or upload a JSON export. They land in the rail for review."
          onClick={onOpenJSON}
        />
      </div>
    </div>
  )
}

function HubCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-2xl border border-border p-4 text-left transition-colors hover:border-foreground/30"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-muted/50">
        {icon}
      </span>
      <span className="mt-2 block text-sm font-medium text-foreground">{title}</span>
      <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
    </button>
  )
}
