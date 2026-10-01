/**
 * Athena ↔ project board adapter (the 'project' authoring kind).
 *
 * Two pure functions, the same contract every other authoring kind implements:
 *
 *  - serializeProjectForAthena → the board as the generic AuthoringState the model
 *    reads in <screen>.
 *  - applyProjectOps → the model's ops turned into a STAGED PROPOSAL.
 *
 * Why a proposal and not a direct edit. Every other authoring kind fills unsaved
 * editor state, so "Athena fills the canvas, you press Save" is literally true there.
 * Master phases and rubric rows are not like that — they are written the moment they
 * are created, by their own server actions. So this adapter never touches the board:
 * it returns a description of what Athena wants to do, the board renders it as a
 * review card, and ONE transactional server action turns it real on Apply.
 *
 * Skipped ops are the load-bearing detail. An op this function refuses is excluded
 * from `changed` AND named in `summary`, because the panel reports `applied: changed > 0`
 * back to the model — count a refusal as a change and Athena will tell the professor it
 * did something it did not do.
 */

import type { ProjectOp } from '@/lib/ai/assignment-assistant/templates/registry'
import type { AuthoringState } from '@/lib/ai/assignment-assistant/schemas'

// ── The board state the host owns ───────────────────────────────────

export interface ProjectRubricRow {
  id: string
  itemType: 'assignment' | 'quiz' | 'manual' | 'attendance'
  title: string
  weight: number
  grain: 'team' | 'individual'
  scoringMode: 'numeric' | 'levels'
}

export interface ProjectPhaseRow {
  id: string
  name: string
  startDate: string | null
  endDate: string | null
  items: ProjectRubricRow[]
}

export interface ProjectBoardState {
  projectId: string
  title: string
  description: string
  guidelines: string
  dueDate: string | null
  phases: ProjectPhaseRow[]
  /** Any score saved against this project — restructuring is refused once true. */
  anyScored: boolean
  gradesReleased: boolean
}

// ── The staged proposal ─────────────────────────────────────────────

export type ProposalAction =
  | { kind: 'setBrief'; title?: string; description?: string; guidelines?: string }
  | { kind: 'addPhase'; key: string; name: string; startDate: string | null; endDate: string | null }
  | { kind: 'updatePhase'; phaseId: string; name?: string; startDate?: string | null; endDate?: string | null }
  | { kind: 'removePhase'; phaseId: string }
  | {
      kind: 'addItem'
      /** An existing phase id, or `newPhase:<key>` for a phase proposed in this batch. */
      phaseRef: string
      itemType: 'assignment' | 'quiz' | 'manual'
      sourceId?: string
      title: string
      weight: number
      grain: 'team' | 'individual'
      scoringMode: 'numeric' | 'levels'
      manualMax?: number
      levels?: { label: string; points: number }[]
    }
  | {
      kind: 'setItemGrading'
      itemId: string
      weight?: number
      grain?: 'team' | 'individual'
      scoringMode?: 'numeric' | 'levels'
      levels?: { label: string; points: number }[]
    }
  | { kind: 'removeItem'; itemId: string }

export interface ProjectProposal {
  actions: ProposalAction[]
}

export interface ApplyProjectOpsResult {
  proposal: ProjectProposal
  summary: string
  /** Ops that will actually do something. `applied` is reported as changed > 0. */
  changed: number
}

const MAX_LEVELS = 10
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Auto-pulled rows are resolved from each student's own record, so a shared team
 *  score is a number the grading engine will ignore. Refuse rather than store it. */
const AUTO_TYPES = new Set(['assignment', 'quiz', 'attendance'])

/** One normalisation for every phase-name key, so producers and consumers agree.
 *  Tolerates the "position N · " decoration and a stale "Phase N: " prefix, both of
 *  which have been observed coming back from the model as a reference. */
function normalisePhaseRef(ref: string): string {
  return ref
    .trim()
    .toLowerCase()
    .replace(/^(position\s*\d+\s*[·:-]\s*)/, '')
    .replace(/^phase\s*\d+\s*[:.-]\s*/, '')
    .trim()
}

function clampWeight(n: number): number {
  return Math.min(1000, Math.max(0, Math.round(n * 100) / 100))
}

// ── Serialize ───────────────────────────────────────────────────────

export function serializeProjectForAthena(state: ProjectBoardState): AuthoringState {
  const weightTotal = state.phases.reduce(
    (sum, p) => sum + p.items.reduce((s, i) => s + (Number(i.weight) || 0), 0),
    0,
  )
  return {
    kind: 'project',
    meta: {
      title: state.title.slice(0, 200),
      description: state.description.slice(0, 2000),
      guidelines: state.guidelines.slice(0, 2000),
      dueDate: state.dueDate ?? 'none set',
      phaseCount: state.phases.length,
      rubricRowCount: state.phases.reduce((n, p) => n + p.items.length, 0),
      weightTotal,
      // Spelled out rather than left as bare booleans: these two decide whether a
      // restructure is allowed at all, and a model reading `false` out of context
      // has repeatedly been the bug on other surfaces.
      scoringState: state.anyScored
        ? 'SOME WORK IS ALREADY SCORED — do not restructure; propose additive rows or discuss in prose.'
        : 'Nothing is scored yet — safe to propose a full structure.',
      releaseState: state.gradesReleased
        ? 'GRADES ARE RELEASED to students — structural changes would silently re-score work they have seen.'
        : 'Grades are not released yet.',
    },
    components: state.phases.map((p, idx) => ({
      id: p.id,
      type: 'phase',
      content: [
        // The NAME is quoted and the id sits beside it, because the model writes
        // phaseRef from whatever this line shows. An earlier version printed
        // "Phase 1: Proposal" as though that were the name; the model then both
        // referenced and RENAMED phases to that display string, and the prefix
        // compounded on every pass.
        `position ${idx + 1} · phaseId: ${p.id} · name: "${p.name}"`,
        p.startDate || p.endDate ? `dates: ${p.startDate ?? '?'} → ${p.endDate ?? '?'}` : 'dates: none set',
        p.items.length
          ? p.items
              .map(
                (i) =>
                  `  - [${i.id}] ${i.title} · ${i.itemType} · weight ${i.weight} · ${i.grain} · ${i.scoringMode}`,
              )
              .join('\n')
          : '  (no rubric rows on this phase)',
      ]
        .join('\n')
        .slice(0, 4000),
    })),
  }
}

// ── Apply ───────────────────────────────────────────────────────────

export function applyProjectOps(
  state: ProjectBoardState,
  ops: ProjectOp[],
  /** A proposal already staged but not yet applied. Its phases are real targets
   *  for this turn's rows: the model proposes a timeline, then sends the rubric
   *  in a follow-up turn, and those phases exist nowhere else yet. */
  pending?: ProjectProposal,
): ApplyProjectOpsResult {
  const actions: ProposalAction[] = []
  const skipped: string[] = []
  const degradedRows: string[] = []
  const existingPhaseIds = new Set(state.phases.map((p) => p.id))
  const existingItems = new Map(state.phases.flatMap((p) => p.items.map((i) => [i.id, i] as const)))

  /** Phases proposed in THIS batch, keyed by NORMALISED name — the same key shape
   *  every other lookup uses, so "  final demo " finds "Final Demo". */
  const proposedPhases = new Map<string, string>()
  /** Saved phases addressable by name, so a ref can use what <screen> displays. */
  const phaseIdByName = new Map<string, string>(
    state.phases.map((p) => [normalisePhaseRef(p.name), p.id]),
  )
  /** Phases still staged from an EARLIER turn of this same proposal. */
  const pendingPhaseKeyByName = new Map<string, string>(
    (pending?.actions ?? []).flatMap((a) =>
      a.kind === 'addPhase' ? [[normalisePhaseRef(a.name), a.key] as const] : [],
    ),
  )

  /* Seed past every key the pending proposal already used. This counter used to
     restart at 0 on each call, so a later turn re-minted "p1" while the merged
     proposal still held an earlier "p1" — and since the apply function resolves
     keys as it replays, a row aimed at the FIRST p1 silently landed on the second.
     Nothing errored and the review card could not show it. */
  let phaseSeq = (pending?.actions ?? []).reduce((max, a) => {
    if (a.kind !== 'addPhase') return max
    const n = Number(/^p(\d+)$/.exec(a.key)?.[1] ?? 0)
    return n > max ? n : max
  }, 0)

  // One gate for every destructive op, checked once. Additive rows stay allowed so a
  // professor mid-semester can still add a deliverable.
  const frozen = state.anyScored || state.gradesReleased
  const frozenWhy = state.gradesReleased ? 'grades are already released' : 'some work is already scored'

  const resolvePhaseRef = (ref: string | undefined): string | null => {
    if (!ref) return null
    if (existingPhaseIds.has(ref)) return ref
    const norm = normalisePhaseRef(ref)
    /* Order matters. A phase proposed in THIS batch wins, then one staged by an
       earlier turn of the same proposal, then a saved phase. Preferring a saved
       phase would silently attach the row to the old one whenever the professor is
       proposing a replacement of the same name — the model just said which one it
       meant by creating it. */
    const batchKey = proposedPhases.get(norm)
    if (batchKey) return `newPhase:${batchKey}`
    const pendingKey = pendingPhaseKeyByName.get(norm)
    if (pendingKey) return `newPhase:${pendingKey}`
    return phaseIdByName.get(norm) ?? null
  }

  for (const op of ops) {
    switch (op.op) {
      case 'setBrief': {
        const { title, description, guidelines } = op
        if (!title && !description && !guidelines) {
          skipped.push('a brief edit with no fields')
          break
        }
        actions.push({ kind: 'setBrief', title, description, guidelines })
        break
      }

      case 'addPhase': {
        if (!op.name?.trim()) {
          skipped.push('a phase with no name')
          break
        }
        if (op.startDate && !ISO_DATE.test(op.startDate)) {
          skipped.push(`phase "${op.name}" (start date is not YYYY-MM-DD)`)
          break
        }
        if (op.endDate && !ISO_DATE.test(op.endDate)) {
          skipped.push(`phase "${op.name}" (end date is not YYYY-MM-DD)`)
          break
        }
        if (op.startDate && op.endDate && op.endDate < op.startDate) {
          skipped.push(`phase "${op.name}" (ends before it starts)`)
          break
        }
        const key = `p${++phaseSeq}`
        proposedPhases.set(normalisePhaseRef(op.name), key)
        actions.push({
          kind: 'addPhase',
          key,
          name: op.name.trim(),
          startDate: op.startDate ?? null,
          endDate: op.endDate ?? null,
        })
        break
      }

      case 'updatePhase': {
        if (!op.phaseId || !existingPhaseIds.has(op.phaseId)) {
          skipped.push('a phase update for an id that is not on screen')
          break
        }
        // Validate dates to the SAME standard as addPhase. Without this an
        // unparseable date reaches ::date in SQL, raises there, and aborts the WHOLE
        // transaction — so one malformed field silently costs the professor every
        // phase and row in the proposal, under a generic failure message.
        if (op.startDate && !ISO_DATE.test(op.startDate)) {
          skipped.push('a phase update (start date is not YYYY-MM-DD)')
          break
        }
        if (op.endDate && !ISO_DATE.test(op.endDate)) {
          skipped.push('a phase update (end date is not YYYY-MM-DD)')
          break
        }
        if (op.startDate && op.endDate && op.endDate < op.startDate) {
          skipped.push('a phase update (ends before it starts)')
          break
        }
        const name = op.name?.trim()
        // A field-less update changes nothing, so counting it would have Athena
        // report work it did not do — the same guard setBrief already carries.
        if (!name && !op.startDate && !op.endDate) {
          skipped.push('a phase update with no fields')
          break
        }
        actions.push({
          kind: 'updatePhase',
          phaseId: op.phaseId,
          name,
          startDate: op.startDate,
          endDate: op.endDate,
        })
        break
      }

      case 'removePhase': {
        if (frozen) {
          skipped.push(`removing a phase (${frozenWhy}; that would delete saved scores)`)
          break
        }
        if (!op.phaseId || !existingPhaseIds.has(op.phaseId)) {
          skipped.push('a phase removal for an id that is not on screen')
          break
        }
        actions.push({ kind: 'removePhase', phaseId: op.phaseId })
        break
      }

      case 'addManualItem':
      case 'placeItem': {
        const isPlace = op.op === 'placeItem'
        const phaseRef = resolvePhaseRef(op.phaseRef)
        if (!phaseRef) {
          skipped.push(
            `a rubric row for phase "${op.phaseRef ?? '(none given)'}" (no phase on screen or proposed above has that id or name)`,
          )
          break
        }
        const itemType = isPlace ? op.itemType : 'manual'
        if (isPlace && !op.sourceId) {
          skipped.push('a placed row with no course item id')
          break
        }
        if (isPlace && !itemType) {
          skipped.push('a placed row with no item type')
          break
        }
        const title = op.itemTitle?.trim() || (isPlace ? 'Placed item' : '')
        if (!isPlace && !title) {
          skipped.push('a manual rubric row with no title')
          break
        }
        const weight = clampWeight(Number(op.weight ?? 0))
        if (!weight) {
          skipped.push(`rubric row "${title}" (weight must be above 0)`)
          break
        }
        const grain = op.grain ?? 'individual'
        if (isPlace && AUTO_TYPES.has(String(itemType)) && grain === 'team') {
          skipped.push(
            `rubric row "${title}" (a placed ${itemType} is scored from each student's own record, so a shared team score would be ignored)`,
          )
          break
        }
        const scoringMode = op.scoringMode ?? 'numeric'
        const levels =
          scoringMode === 'levels' && Array.isArray(op.levels)
            ? op.levels.slice(0, MAX_LEVELS).map((l) => ({ label: l.label, points: clampWeight(Number(l.points)) }))
            : undefined
        // The model regularly emits scoringMode 'levels' with no levels array. Dropping
        // the row loses a whole deliverable over a formatting slip, so degrade to numeric
        // and say so — the professor can switch it back in one click on the Rubric tab.
        let effectiveMode = scoringMode
        let degraded = false
        if (scoringMode === 'levels' && (!levels || levels.length < 2)) {
          effectiveMode = 'numeric'
          degraded = true
        }
        actions.push({
          kind: 'addItem',
          phaseRef,
          itemType: (isPlace ? itemType : 'manual') as 'assignment' | 'quiz' | 'manual',
          sourceId: isPlace ? op.sourceId : undefined,
          title,
          weight,
          grain,
          scoringMode: effectiveMode,
          manualMax: !isPlace && effectiveMode === 'numeric' ? (op.manualMax ?? weight) : undefined,
          levels: effectiveMode === 'levels' ? levels : undefined,
        })
        if (degraded) degradedRows.push(title)
        break
      }

      case 'setItemGrading': {
        if (!op.itemId || !existingItems.has(op.itemId)) {
          skipped.push('a grading change for a rubric row that is not on screen')
          break
        }
        if (frozen) {
          skipped.push(`re-weighting "${existingItems.get(op.itemId)!.title}" (${frozenWhy})`)
          break
        }
        const row = existingItems.get(op.itemId)!
        if (op.grain === 'team' && AUTO_TYPES.has(row.itemType)) {
          skipped.push(
            `setting "${row.title}" to a shared team score (a ${row.itemType} row is scored per student, so it would be ignored)`,
          )
          break
        }
        const levels = Array.isArray(op.levels)
          ? op.levels.slice(0, MAX_LEVELS).map((l) => ({ label: l.label, points: clampWeight(Number(l.points)) }))
          : undefined
        actions.push({
          kind: 'setItemGrading',
          itemId: op.itemId,
          weight: op.weight != null ? clampWeight(Number(op.weight)) : undefined,
          grain: op.grain,
          scoringMode: op.scoringMode,
          levels,
        })
        break
      }

      case 'removeItem': {
        if (frozen) {
          skipped.push(`removing a rubric row (${frozenWhy}; that would delete saved scores)`)
          break
        }
        if (!op.itemId || !existingItems.has(op.itemId)) {
          skipped.push('a row removal for an id that is not on screen')
          break
        }
        actions.push({ kind: 'removeItem', itemId: op.itemId })
        break
      }

      default:
        skipped.push('an unrecognised operation')
    }
  }

  const phases = actions.filter((a) => a.kind === 'addPhase').length
  const rows = actions.filter((a) => a.kind === 'addItem').length
  const edits = actions.length - phases - rows

  const parts: string[] = []
  if (phases) parts.push(`${phases} phase${phases === 1 ? '' : 's'}`)
  if (rows) parts.push(`${rows} rubric row${rows === 1 ? '' : 's'}`)
  if (edits) parts.push(`${edits} edit${edits === 1 ? '' : 's'}`)

  /* Name WHERE the proposal is waiting. On a narrow screen the dock is a full-height
     sheet that covers the review card it just created, and nothing otherwise points
     the professor back to it — they are told something was proposed and see no way to
     act on it. Reads correctly on desktop too, where the card is simply above. */
  let summary = parts.length
    ? `Proposed ${parts.join(', ')} — waiting in a review card above your tabs.`
    : 'Nothing to propose.'
  if (degradedRows.length) {
    summary += ` Scored ${degradedRows.length === 1 ? 'one row' : `${degradedRows.length} rows`} out of points instead of named levels (no levels were given).`
  }
  if (skipped.length) {
    summary += ` Skipped ${skipped.length}: ${skipped.slice(0, 4).join('; ')}${skipped.length > 4 ? '; …' : ''}.`
  }

  return { proposal: { actions }, summary, changed: actions.length }
}
