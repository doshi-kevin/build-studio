/**
 * The 'project' authoring adapter. What these assert, and why:
 *
 * `changed` is what the panel reports back to the model as `applied`. An op this
 * adapter refuses must therefore be excluded from it AND named in `summary`, or
 * Athena tells the professor it restructured a rubric it did not touch.
 *
 * The block at the bottom is regressions from runtime QA. Each one silently ate
 * rubric rows — the entire point of the surface — without erroring.
 */
import { describe, it, expect } from 'vitest'
import {
  serializeProjectForAthena,
  applyProjectOps,
  type ProjectBoardState,
} from '@/lib/projects/athena-project-adapter'
import type { ProjectOp } from '@/lib/ai/assignment-assistant/templates/registry'

function board(over: Partial<ProjectBoardState> = {}): ProjectBoardState {
  return {
    projectId: 'proj-1',
    title: 'Capstone',
    description: 'Build a thing.',
    guidelines: 'Proposal, report, demo.',
    dueDate: '2026-12-31',
    phases: [
      {
        id: 'phase-A',
        name: 'Proposal',
        startDate: null,
        endDate: null,
        items: [
          { id: 'item-1', itemType: 'manual', title: 'Written proposal', weight: 20, grain: 'team', scoringMode: 'numeric' },
          { id: 'item-2', itemType: 'assignment', title: 'Lit review', weight: 10, grain: 'individual', scoringMode: 'numeric' },
        ],
      },
    ],
    anyScored: false,
    gradesReleased: false,
    ...over,
  }
}

describe('serializeProjectForAthena', () => {
  it('spells the scoring and release state out as sentences, not bare booleans', () => {
    const clean = serializeProjectForAthena(board())
    expect(String(clean.meta?.scoringState)).toContain('Nothing is scored yet')

    const scored = serializeProjectForAthena(board({ anyScored: true, gradesReleased: true }))
    expect(String(scored.meta?.scoringState)).toContain('ALREADY SCORED')
    expect(String(scored.meta?.releaseState)).toContain('RELEASED')
  })

  it('reports the real weight total so Athena can reconcile against 100', () => {
    expect(serializeProjectForAthena(board()).meta?.weightTotal).toBe(30)
  })

  it('shows the phase id beside a QUOTED name, never as a "Phase N:" display label', () => {
    // The model writes phaseRef from this line. Presenting "Phase 1: Proposal" as
    // though it were the name made it both reference AND rename phases to that
    // string, and the prefix compounded on every pass.
    const content = serializeProjectForAthena(board()).components?.[0]?.content ?? ''
    expect(content).toContain('phaseId: phase-A')
    expect(content).toContain('name: "Proposal"')
    expect(content).not.toMatch(/^Phase 1: Proposal/m)
  })

  it('exposes every rubric row id, since ops address rows by id', () => {
    const content = serializeProjectForAthena(board()).components?.[0]?.content ?? ''
    expect(content).toContain('[item-1]')
    expect(content).toContain('[item-2]')
  })
})

describe('applyProjectOps', () => {
  it('resolves a row onto a phase proposed earlier in the SAME batch, by name', () => {
    const ops: ProjectOp[] = [
      { op: 'addPhase', name: 'Final demo' },
      { op: 'addManualItem', phaseRef: 'Final demo', itemTitle: 'Live demo', weight: 25, scoringMode: 'numeric' },
    ]
    const res = applyProjectOps(board(), ops)
    expect(res.changed).toBe(2)
    const add = res.proposal.actions.find((a) => a.kind === 'addItem')
    expect(add && 'phaseRef' in add && add.phaseRef).toMatch(/^newPhase:/)
  })

  it('skips a row whose phase neither exists nor was proposed, and says so', () => {
    const res = applyProjectOps(board(), [
      { op: 'addManualItem', phaseRef: 'Nonexistent phase', itemTitle: 'X', weight: 10 },
    ])
    expect(res.changed).toBe(0)
    expect(res.summary).toContain('Nonexistent phase')
  })

  it('refuses a shared team score on a PLACED assignment, because the engine ignores it', () => {
    const res = applyProjectOps(board(), [
      {
        op: 'placeItem', phaseRef: 'phase-A', itemType: 'assignment', sourceId: 'asg-9',
        itemTitle: 'Essay', weight: 10, grain: 'team',
      },
    ])
    expect(res.changed).toBe(0)
    expect(res.summary).toMatch(/would be ignored/i)
  })

  it('allows a shared team score on a MANUAL row, which is the legitimate case', () => {
    const res = applyProjectOps(board(), [
      { op: 'addManualItem', phaseRef: 'phase-A', itemTitle: 'Team demo', weight: 15, grain: 'team' },
    ])
    expect(res.changed).toBe(1)
  })

  it('refuses every destructive op once work is scored, but still allows additive rows', () => {
    const scored = board({ anyScored: true })
    const destructive = applyProjectOps(scored, [
      { op: 'removePhase', phaseId: 'phase-A' },
      { op: 'removeItem', itemId: 'item-1' },
      { op: 'setItemGrading', itemId: 'item-1', weight: 99 },
    ])
    expect(destructive.changed).toBe(0)
    expect(destructive.summary).toContain('already scored')

    const additive = applyProjectOps(scored, [
      { op: 'addManualItem', phaseRef: 'phase-A', itemTitle: 'Extra deliverable', weight: 5 },
    ])
    expect(additive.changed).toBe(1)
  })

  it('refuses a zero weight and an end date before the start date', () => {
    const zero = applyProjectOps(board(), [
      { op: 'addManualItem', phaseRef: 'phase-A', itemTitle: 'Freebie', weight: 0 },
    ])
    expect(zero.changed).toBe(0)
    expect(zero.summary).toContain('weight must be above 0')

    const backwards = applyProjectOps(board(), [
      { op: 'addPhase', name: 'Backwards', startDate: '2026-05-01', endDate: '2026-04-01' },
    ])
    expect(backwards.changed).toBe(0)
    expect(backwards.summary).toContain('ends before it starts')
  })

  it('counts only the ops that will act, so a mixed batch cannot over-report', () => {
    const res = applyProjectOps(board(), [
      { op: 'addManualItem', phaseRef: 'phase-A', itemTitle: 'Real row', weight: 10 },
      { op: 'addManualItem', phaseRef: 'ghost phase', itemTitle: 'Doomed row', weight: 10 },
      { op: 'removeItem', itemId: 'not-a-real-id' },
    ])
    expect(res.changed).toBe(1)
    expect(res.summary).toContain('Skipped 2')
  })

  it('validates updatePhase dates to the same standard as addPhase', () => {
    // Unvalidated, a bad date reaches ::date in SQL and aborts the WHOLE transaction,
    // so one malformed field costs the professor every phase and row in the proposal.
    const bad = applyProjectOps(board(), [
      { op: 'updatePhase', phaseId: 'phase-A', startDate: 'soon' },
    ])
    expect(bad.changed).toBe(0)
    expect(bad.summary).toContain('not YYYY-MM-DD')

    const backwards = applyProjectOps(board(), [
      { op: 'updatePhase', phaseId: 'phase-A', startDate: '2026-05-01', endDate: '2026-04-01' },
    ])
    expect(backwards.changed).toBe(0)
    expect(backwards.summary).toContain('ends before it starts')
  })

  it('never reports a change for a field-less updatePhase', () => {
    const res = applyProjectOps(board(), [{ op: 'updatePhase', phaseId: 'phase-A' }])
    expect(res.changed).toBe(0)
  })

  it('matches a same-batch phase regardless of case and surrounding whitespace', () => {
    // The batch map was keyed by the exact trimmed name but looked up before
    // normalisation, so "  final demo " staged the phase and then skipped its row.
    const res = applyProjectOps(board(), [
      { op: 'addPhase', name: 'Final Demo' },
      { op: 'addManualItem', phaseRef: '  final demo ', itemTitle: 'Demo', weight: 20 },
    ])
    expect(res.changed).toBe(2)
    const add = res.proposal.actions.find((a) => a.kind === 'addItem')
    expect(add && 'phaseRef' in add && add.phaseRef).toMatch(/^newPhase:/)
  })

  it('prefers a phase proposed in this batch over a saved one of the same name', () => {
    // The professor is proposing a replacement; attaching the row to the OLD phase
    // silently contradicts what the model just said by creating a new one.
    const res = applyProjectOps(board(), [
      { op: 'addPhase', name: 'Proposal' },
      { op: 'addManualItem', phaseRef: 'Proposal', itemTitle: 'New row', weight: 10 },
    ])
    const add = res.proposal.actions.find((a) => a.kind === 'addItem')
    expect(add && 'phaseRef' in add && add.phaseRef).toMatch(/^newPhase:/)
    expect(add && 'phaseRef' in add && add.phaseRef).not.toBe('phase-A')
  })

  it('never reports a change for an empty brief edit', () => {
    expect(applyProjectOps(board(), [{ op: 'setBrief' }]).changed).toBe(0)
  })

  // ── Runtime-QA regressions. Each of these dropped every rubric row Athena
  // produced, which is the entire point of the surface.

  it('resolves a row onto a SAVED phase by the name <screen> shows, not just its id', () => {
    // The serialization displays the name; the model refs what it is shown. Before this,
    // resolvePhaseRef took the uuid only and silently skipped every such row — while the
    // skip message claimed it accepted "id or name".
    const res = applyProjectOps(board(), [
      { op: 'addManualItem', phaseRef: 'Proposal', itemTitle: 'Peer review', weight: 5 },
    ])
    expect(res.changed).toBe(1)
    const add = res.proposal.actions.find((a) => a.kind === 'addItem')
    expect(add && 'phaseRef' in add && add.phaseRef).toBe('phase-A')
  })

  it('tolerates the display decoration coming back as a phaseRef', () => {
    for (const ref of ['position 1 · Proposal', 'Phase 1: Proposal', '  proposal  ']) {
      expect(
        applyProjectOps(board(), [{ op: 'addManualItem', phaseRef: ref, itemTitle: 'X', weight: 5 }]).changed,
      ).toBe(1)
    }
  })

  it('resolves a row onto a phase staged by an EARLIER turn of the same proposal', () => {
    // Athena proposes the timeline, then sends the rubric in a follow-up turn. Those
    // phases are staged, not saved, so without the pending proposal they resolve nowhere.
    const turn1 = applyProjectOps(board(), [{ op: 'addPhase', name: 'Final demo' }])
    const turn2 = applyProjectOps(
      board(),
      [{ op: 'addManualItem', phaseRef: 'Final demo', itemTitle: 'Demo', weight: 20 }],
      turn1.proposal,
    )
    expect(turn2.changed).toBe(1)
    const add = turn2.proposal.actions.find((a) => a.kind === 'addItem')
    expect(add && 'phaseRef' in add && add.phaseRef).toMatch(/^newPhase:/)
  })

  it('degrades a levels row with no levels to numeric instead of dropping the deliverable', () => {
    const res = applyProjectOps(board(), [
      { op: 'addManualItem', phaseRef: 'phase-A', itemTitle: 'Report', weight: 30, scoringMode: 'levels' },
    ])
    expect(res.changed).toBe(1)
    const add = res.proposal.actions.find((a) => a.kind === 'addItem')
    expect(add && 'scoringMode' in add && add.scoringMode).toBe('numeric')
    expect(res.summary).toContain('instead of named levels')
  })

  it('degrades a one-level row too, rather than losing the row', () => {
    const res = applyProjectOps(board(), [
      {
        op: 'addManualItem', phaseRef: 'phase-A', itemTitle: 'Report', weight: 30,
        scoringMode: 'levels', levels: [{ label: 'Good', points: 30 }],
      },
    ])
    expect(res.changed).toBe(1)
    const add = res.proposal.actions.find((a) => a.kind === 'addItem')
    expect(add && 'scoringMode' in add && add.scoringMode).toBe('numeric')
  })

  it('never re-mints a batch key a pending proposal already used', () => {
    // phaseSeq restarted at 0 each call, so a later turn minted "p1" again while the
    // merged proposal still held an earlier "p1". The apply function resolves keys as
    // it replays, so a row aimed at the FIRST p1 silently landed on the second phase.
    // No error, and the review card could not show it.
    const t1 = applyProjectOps(board(), [
      { op: 'addPhase', name: 'Proposal Phase' },
      { op: 'addPhase', name: 'Development Phase' },
    ])
    const t2 = applyProjectOps(board(), [{ op: 'addPhase', name: 'Retrospective' }], t1.proposal)

    const keys = [...t1.proposal.actions, ...t2.proposal.actions].flatMap((a) =>
      a.kind === 'addPhase' ? [a.key] : [],
    )
    expect(new Set(keys).size).toBe(keys.length)

    // The uniqueness assertion above is what actually guards the regression. The
    // check below passes even WITH the bug (pendingPhaseKeyByName is keyed by name,
    // so the lookup finds the right key either way) — it is kept as a sanity check on
    // the name path, not as the regression guard. The real wrong-phase behaviour
    // happens in SQL and is covered in src/__tests__/db/apply-project-proposal.test.ts.
    const merged = { actions: [...t1.proposal.actions, ...t2.proposal.actions] }
    const t3 = applyProjectOps(
      board(),
      [{ op: 'addManualItem', phaseRef: 'Proposal Phase', itemTitle: 'Presentation', weight: 5 }],
      merged,
    )
    const add = t3.proposal.actions.find((a) => a.kind === 'addItem')
    const proposalKey = t1.proposal.actions.find((a) => a.kind === 'addPhase' && a.name === 'Proposal Phase')
    expect(add && 'phaseRef' in add && add.phaseRef).toBe(
      `newPhase:${proposalKey && 'key' in proposalKey ? proposalKey.key : '?'}`,
    )
  })
})
