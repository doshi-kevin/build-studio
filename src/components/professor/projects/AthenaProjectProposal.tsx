/**
 * The review step between Athena proposing a project structure and it existing.
 *
 * Athena's apply_edits does NOT write here — unlike every other authoring kind,
 * phases and rubric rows are saved by server actions the moment they are created,
 * so there is no unsaved canvas to fill. Instead the proposal is held in this card
 * until the professor reads it and presses Apply, which is one transactional write.
 *
 * Deliberately lists every proposed row with its weight, the phase it lands on, and
 * the running total: the autonomy rule for a draft is that the review is a REAL
 * check, not a one-click rubber stamp. Naming the parent phase is not decoration —
 * a row filed against the wrong phase is otherwise indistinguishable from a correct
 * one, which is exactly how a mis-keyed row got through QA once.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Sparkles, Check, X, Loader2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { ProposalAction } from '@/lib/projects/athena-project-adapter'
import { applyAthenaProjectProposal } from '@/app/(dashboard)/professor/courses/[sectionId]/projects/actions'

interface AthenaProjectProposalProps {
  sectionId: string
  projectId: string
  proposalId: string
  actions: ProposalAction[]
  /** Saved phases, so a row can name the phase it lands on. */
  existingPhases: { id: string; name: string }[]
  /** Saved rubric rows. Needed for two things a count cannot do: naming what a
   *  removal or re-weight ACTS ON, and simulating the resulting project total. */
  existingRows: { id: string; title: string; weight: number; phaseId: string | null }[]
  onDiscard: () => void
  onApplied: () => void
}

function describe(
  a: ProposalAction,
  /** batch key or saved id -> phase name, so a row can name where it lands. */
  phaseNames: Map<string, string>,
  /** saved row id -> the row, so a removal or re-weight can name its target. */
  rowsById: Map<string, { title: string; weight: number }>,
): { label: string; weight?: number; detail?: string } {
  switch (a.kind) {
    case 'setBrief':
      return { label: 'Update the project brief', detail: 'title / description / guidelines' }
    case 'addPhase':
      return {
        label: `New phase: ${a.name}`,
        detail: a.startDate || a.endDate ? `${a.startDate ?? '?'} → ${a.endDate ?? '?'}` : undefined,
      }
    case 'updatePhase': {
      const which = phaseNames.get(a.phaseId) ?? 'a phase'
      return {
        label: a.name ? `Rename ${which} to "${a.name}"` : `Change the dates on ${which}`,
        detail: a.startDate || a.endDate ? `${a.startDate ?? '?'} → ${a.endDate ?? '?'}` : undefined,
      }
    }
    case 'removePhase':
      // Naming the target is the whole job here: Apply is one irreversible
      // transaction, and removing a phase takes every rubric row under it.
      return {
        label: `Remove phase ${phaseNames.get(a.phaseId) ?? '(unknown)'}`,
        detail: 'and every rubric row on it',
      }
    case 'addItem':
      return {
        label: a.title,
        weight: a.weight,
        detail: [
          `on ${phaseNames.get(a.phaseRef) ?? 'an existing phase'}`,
          a.itemType === 'manual' ? 'manual row' : `placed ${a.itemType}`,
          a.grain === 'team' ? 'one team score' : 'per student',
          a.scoringMode === 'levels' ? `${a.levels?.length ?? 0} levels` : 'numeric',
        ].join(' · '),
      }
    case 'setItemGrading': {
      const row = rowsById.get(a.itemId)
      return {
        label: `Re-weight "${row?.title ?? 'a rubric row'}"`,
        weight: a.weight,
        detail: row && a.weight != null ? `${row.weight} → ${a.weight} pts` : undefined,
      }
    }
    case 'removeItem': {
      const row = rowsById.get(a.itemId)
      return {
        label: `Remove "${row?.title ?? 'a rubric row'}"`,
        detail: row ? `currently ${row.weight} pts` : undefined,
      }
    }
  }
}

export function AthenaProjectProposal({
  sectionId,
  projectId,
  proposalId,
  actions,
  existingPhases,
  existingRows,
  onDiscard,
  onApplied,
}: AthenaProjectProposalProps) {
  const [applying, setApplying] = useState(false)

  /* Resolve every reference to something readable: phases staged in this proposal by
     their batch key, saved phases and saved rows by their id. */
  const phaseNames = new Map<string, string>()
  for (const a of actions) if (a.kind === 'addPhase') phaseNames.set(`newPhase:${a.key}`, `"${a.name}"`)
  for (const p of existingPhases) phaseNames.set(p.id, `"${p.name}"`)
  const rowsById = new Map(existingRows.map((r) => [r.id, { title: r.title, weight: r.weight }]))

  /* SIMULATE the resulting total rather than adding up the new rows. A batch that adds
     a 20-point demo and rebalances the rest down to 80 nets to 100; summing only the
     additions reports 120 and warns on a correct proposal. And a batch that ONLY
     re-weights must still show a total — that is exactly the "do my weights add up?"
     request. So: start from the saved rows, drop what is being removed, apply weight
     overrides, then add the new rows. */
  const removedPhaseIds = new Set(
    actions.flatMap((a) => (a.kind === 'removePhase' ? [a.phaseId] : [])),
  )
  const removedRowIds = new Set(actions.flatMap((a) => (a.kind === 'removeItem' ? [a.itemId] : [])))
  const weightOverrides = new Map(
    actions.flatMap((a) =>
      a.kind === 'setItemGrading' && a.weight != null ? [[a.itemId, a.weight] as const] : [],
    ),
  )
  const survivingWeight = existingRows.reduce((sum, r) => {
    if (removedRowIds.has(r.id)) return sum
    if (r.phaseId && removedPhaseIds.has(r.phaseId)) return sum
    return sum + (weightOverrides.get(r.id) ?? r.weight)
  }, 0)
  const addedWeight = actions.reduce((sum, a) => sum + (a.kind === 'addItem' ? a.weight : 0), 0)
  const resultingTotal = survivingWeight + addedWeight

  // Show the total whenever the proposal moves weight at all, in either direction.
  const showTotal = actions.some(
    (a) =>
      a.kind === 'addItem' ||
      a.kind === 'removeItem' ||
      a.kind === 'removePhase' ||
      (a.kind === 'setItemGrading' && a.weight != null),
  )

  async function handleApply() {
    setApplying(true)
    try {
      const res = await applyAthenaProjectProposal(projectId, sectionId, proposalId, actions)
      if (res.error) {
        toast.error(res.error)
        return
      }
      toast.success(res.summary ?? 'Applied.')
      onApplied()
    } catch {
      /* The action catches its own errors, but the request itself can still fail — a
         dropped connection, a deploy mid-flight. Without this the card stays disabled
         forever, and the proposal is client-only state that a reload destroys, so the
         professor loses it with no way to retry. Retrying is safe: the proposal id is
         the idempotency key. */
      toast.error('Could not reach the server. Nothing was applied — try again.')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="rounded-2xl border border-dashed border-primary/40 bg-primary/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden />
          <h3 className="text-sm font-semibold">Athena proposed a structure</h3>
          <Badge variant="outline" className="text-xs">Not saved yet</Badge>
        </div>
        <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={applying}>
            <X className="mr-1 h-3.5 w-3.5" aria-hidden />
            Discard
          </Button>
          <Button size="sm" onClick={handleApply} disabled={applying}>
            {applying ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Check className="mr-1 h-3.5 w-3.5" aria-hidden />
            )}
            {applying ? 'Applying…' : 'Apply'}
          </Button>
        </div>
      </div>

      <ul className="mt-3 space-y-1.5">
        {actions.map((a, i) => {
          const d = describe(a, phaseNames, rowsById)
          return (
            <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate text-foreground">
                {d.label}
                {d.detail && <span className="ml-2 text-xs text-muted-foreground">{d.detail}</span>}
              </span>
              {d.weight != null && (
                <span className="shrink-0 tabular-nums text-muted-foreground">{d.weight} pts</span>
              )}
            </li>
          )
        })}
      </ul>

      {showTotal && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-primary/20 pt-2 text-sm">
          <span className="text-muted-foreground">Project total if applied</span>
          <span className="font-medium tabular-nums">{resultingTotal}</span>
          {resultingTotal !== 100 && (
            <span className="flex items-center gap-1 text-xs text-warning-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              not 100 — edit the weights after applying, or ask Athena to rebalance
            </span>
          )}
        </div>
      )}
    </div>
  )
}
