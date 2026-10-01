'use client'

/**
 * Shared chrome for assistant draft cards: a header (icon + "Draft" label), a
 * nothing-is-live-yet note, an editable body (the card's fields), and a footer
 * with Discard / Approve.
 * Fields are edited inline, so there is no separate "edit" mode — the card IS
 * the editor. `ResolvedCard` renders the terminal state after approve/discard
 * (persisted via the tool result so it survives re-render / reload).
 */

import { Loader2, Check, X, ArrowUpRight, Bot, Info } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

export interface DraftToolOutput {
  approved: boolean
  note?: string
  href?: string
}

export function CardShell({
  icon: Icon,
  title,
  children,
  onApprove,
  onDiscard,
  approveLabel,
  submitting,
  approveDisabled,
}: {
  icon: LucideIcon
  title: string
  children: React.ReactNode
  onApprove: () => void
  onDiscard: () => void
  approveLabel: string
  submitting: boolean
  approveDisabled?: boolean
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary/10">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className="ml-auto rounded-full bg-warning-muted px-2 py-0.5 text-xs font-medium text-warning-muted-foreground">
          Draft
        </span>
      </div>

      {/* Athena NEVER writes on the professor's behalf — every card is a proposal
          until they act on it. Professors were reading "Athena created the
          assignment" as "students can see it" (#267), and neither the pill above
          nor the composer's footer disclaimer said otherwise in plain words.
          Lives here, in the shell all 10 draft cards render through, so no card
          can ship without it.

          The copy names {approveLabel} rather than saying "publish" because the
          two card families differ: "Create assignment" / "Save as draft" /
          "Create unpublished module" leave something the professor still has to
          publish, while "Post discussion" / "Post reply" go live on the spot.
          "Nothing is in your course yet" is the one claim true of all ten, and
          the button's own wording carries what happens next. */}
      <p className="flex items-start gap-2 border-b border-border bg-warning-muted px-4 py-2 text-xs text-warning-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          Nothing is in your course yet — Athena only drafts. This exists only once you choose{' '}
          <span className="font-semibold">{approveLabel}</span> below.
        </span>
      </p>

      <div className="space-y-3 px-4 py-3.5">{children}</div>

      {/* flex-wrap: at 390px the two buttons need ~229px but the card column is
          ~198px, and `justify-end` spilled the overflow off the LEFT edge — the
          rounded-2xl clip cut "Discard" to "scard" and swallowed half its tap
          target, so the card behind it took the tap. Wrapping keeps both buttons
          whole and reachable. */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/30 px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={submitting} className="gap-1.5">
          <X className="h-3.5 w-3.5" />
          Discard
        </Button>
        <Button size="sm" onClick={onApprove} disabled={submitting || approveDisabled} className="gap-1.5">
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          {approveLabel}
        </Button>
      </div>
    </div>
  )
}

/** Terminal state shown once a draft has been approved or discarded. */
export function ResolvedCard({ output, title }: { output: DraftToolOutput; title: string }) {
  if (!output.approved) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        <X className="h-4 w-4 shrink-0" />
        <span>Discarded the {title.toLowerCase()}.</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2.5 rounded-2xl border border-success/30 bg-success/10 px-4 py-3 text-sm">
      <Check className="h-4 w-4 shrink-0 text-success" />
      <span className="flex-1 text-foreground">{output.note || 'Saved.'}</span>
      {output.href && (
        <Link
          href={output.href}
          className="inline-flex h-7 items-center gap-1 rounded-full bg-secondary px-3 text-xs font-medium text-secondary-foreground transition hover:bg-secondary/80"
        >
          Open
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  )
}

/** Skeleton shown while the model is still streaming a draft tool's input. */
export function DraftingCard({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-2xl border border-border bg-card px-4 py-3.5 text-sm text-muted-foreground shadow-sm">
      <Bot className="h-4 w-4 shrink-0 text-primary motion-safe:animate-pulse" />
      <span>{label}</span>
      <Loader2 className="ml-auto h-4 w-4 animate-spin" />
    </div>
  )
}
