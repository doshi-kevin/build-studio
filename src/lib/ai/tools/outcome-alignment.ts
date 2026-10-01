/**
 * ABET outcome-alignment tools, shared across Athena surfaces (#628).
 *
 * These two used to live inside the professor console's own tool factory, which is why
 * accreditation coverage was reachable from exactly one hidden URL. The problem the issue
 * names is structural rather than specific to ABET: every surface built its tool set from
 * scratch, so a capability added to one was invisible to the others by construction, and
 * each new Athena instance started with nothing inherited.
 *
 * Deliberately NOT a registry — no named map, no lookup, no per-surface allowlist. There
 * is one shared capability today, and a plugin system for one caller buys indirection
 * instead of safety. A plain factory that surfaces spread gets the property that actually
 * matters: TypeScript refuses to compile a surface that forgets part of the context.
 *
 * ── Tenancy ─────────────────────────────────────────────────────────────────────────
 * The CALLER owns authorization. Both ids must already be route-verified (the console
 * does getAuthUser → verifySectionAccess → canWriteAsStaff; the builder route does the
 * same) because `adminDb` is a service-role client that bypasses row-level security. This
 * module re-verifies nothing, on purpose: a second check here would duplicate the route's
 * logic and add a query to every tool-using turn, while still trusting whatever ids it
 * was handed. Passing an unverified sectionId here is a cross-tenant read.
 *
 * ── Why the surfaces get different tools ────────────────────────────────────────────
 * The READ is on every professor surface: coverage is a property of the section, held in
 * course_outcome_alignments and keyed by nothing else, so wherever it is asked the answer
 * is the same rows. That is what makes "same course, same numbers, whichever screen" true
 * by construction rather than by a caching scheme.
 *
 * `analyze_outcome_alignment` stays console-only. It enqueues a job that runs for minutes,
 * and the progress chip, the completion watcher and the result card all live in
 * AssistantConsole. Elsewhere the panel is ephemeral and renders nothing for it, so a job
 * started there is silent on success AND on failure, and the professor is left polling by
 * asking — which costs a full priced turn each time. Registering the tool without first
 * moving that delivery into the shared panel would be shipping a promise the UI cannot
 * keep. The read's description sends them to the console instead.
 *
 * The read's DESCRIPTION also has to differ per surface, which is the non-obvious part.
 * The console's copy tells the model the result renders "as a compact card" and to call it
 * only when the card should appear. Nowhere else has a card, so that wording would make
 * the model announce one that never arrives. The payload semantics are stated once and
 * shared; only the "why you would call this here" clause varies.
 */

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { loadOutcomeCoverage } from '@/lib/ai/professor-assistant/outcome-coverage'
import { enqueueJob } from '@/lib/jobs/enqueue'

// The admin client is loosely typed across the codebase; mirror the surfaces' own alias.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

/**
 * Where the tools are mounted. Decides which tools exist and how their results are
 * described, NOT what they are allowed to read.
 *
 *  - `console`: the professor assistant page. Renders a progress chip and a coverage card.
 *  - `builder`: the dock inside the assignment/quiz editor. Ephemeral, no cards.
 */
export type OutcomeToolSurface =
  | 'console'
  | 'about'
  | 'quiz'
  | 'builder'
  | 'grade'
  | 'general'

/**
 * What each surface is allowed to do. `full` additionally gets the job starter.
 *
 * A Record rather than a Set of the read-only ones, because the two differ in what they do
 * when someone adds a surface and forgets it. A Set membership test falls through to the
 * `full` branch, so the omission silently grants `analyze_outcome_alignment` to a panel with
 * no progress chip and no completion watcher — the exact thing the header spends a
 * paragraph forbidding, and neither the compiler nor any test can see it happen. An
 * exhaustive Record makes the same omission a build error.
 */
const SURFACE_CAPABILITY: Record<OutcomeToolSurface, 'read' | 'full'> = {
  console: 'full',
  about: 'read',
  quiz: 'read',
  builder: 'read',
  grade: 'read',
  general: 'read',
}

export interface OutcomeAlignmentToolsContext {
  /** Service-role client. The caller must have verified access to `sectionId` already. */
  adminDb: AdminDb
  /** Route-verified section. Never accept this from the model or the client. */
  sectionId: string
  /** Route-verified caller, recorded as the job's creator. */
  userId: string
  surface: OutcomeToolSurface
}

/* What the payload means. Identical on every surface because the payload is identical —
   the same rows, read by the same function, whichever screen asked. Only the "what to do
   with it here" clause below differs. */
const COVERAGE_PAYLOAD =
  "Returns, per Student Outcome (SO-1..7), the highest level reached (Introduced/Reinforced/Mastered), how many of its performance indicators have supporting evidence, overall totals, and the gap list. READ `analysisState` FIRST and let it decide what you say. 'never_run' = no analysis has ever completed for this course, so every zero means NOT MEASURED and never 'covers nothing' — tell them no analysis has run yet and do NOT report gaps or name uncovered outcomes. 'ready' = the numbers come from a completed analysis. Then check `runInFlight` SEPARATELY: true means a run is happening right now, so the figures may still be the previous run's and you cannot tell which — mention a refresh is in progress rather than presenting them as the finished answer. Both can be true at once on a first-ever run: that is still 'never_run', so report no numbers and say the analysis is running. `lastAnalyzedAt` is when the course was actually read (not when it was last checked), so mention the date if it is not recent — recent course edits may not be reflected. `lastSummary` is the pipeline's own sentence and is safe to quote verbatim."

const NO_CARD =
  'There is NO card on this surface, so nothing appears on screen when you call it: read the result into your own context and then say what matters IN YOUR REPLY. Never tell the professor to look at a card, table or panel.'

const CANNOT_START =
  'It only reads the persisted alignment: it never re-runs the analysis, and it cannot start one here. If they want a fresh or first analysis, say so in one line and send them to the Athena console on this course.'

const ONCE_PER_TURN =
  'Call it at most once per turn; it takes no arguments, so a second call returns the same data.'

/** The per-surface "why you would call this here" clause. */
const COVERAGE_USE: Record<OutcomeToolSurface, string> = {
  console:
    'Call this ONLY when the card should (re)appear: (1) right after an analyze_outcome_alignment run finishes and you are told the results are ready, and (2) when the professor explicitly asks to SEE / pull up / revisit the coverage card. Do NOT call it for analytical follow-ups (which gaps, how to close one, summarize) — that data is already in your context; answer from memory without re-rendering.',
  about:
    'Use it when they ask about ABET or accreditation, or when they are writing the learning-outcomes section of this page and want it to reflect what the course actually teaches. Coverage describes the whole course, not this page, so never edit the page to make the numbers look better.',
  quiz:
    'Use it when they ask which outcomes are weak, or what this quiz should target — so you can point questions at indicators that currently have no evidence instead of guessing.',
  builder:
    'Use it when they ask what this assignment should target, which outcomes are weak, or whether what they are building closes a gap — so your answer names real gaps from their course instead of generic ones.',
  grade:
    'Course-level context only. Use it if they ask how this work fits the accreditation picture. NEVER use coverage to justify, raise or lower an individual student grade: it describes the course design, not this submission.',
  general:
    'Use it when they ask about ABET or accreditation coverage for this course.',
}

/** The read-only coverage tool. Present on every professor surface. */
function showOutcomeCoverage(ctx: OutcomeAlignmentToolsContext) {
  const isConsole = ctx.surface === 'console'
  const description = [
    isConsole
      ? "Read-only: fetch and DISPLAY this course's current ABET outcome coverage as a compact card."
      : "Read-only: fetch this course's current ABET outcome coverage.",
    COVERAGE_PAYLOAD,
    COVERAGE_USE[ctx.surface],
    isConsole ? '' : NO_CARD,
    isConsole ? '' : ONCE_PER_TURN,
    isConsole
      ? 'It only reads the persisted alignment; it never re-runs the analysis or grades anyone.'
      : CANNOT_START,
  ]
    .filter(Boolean)
    .join(' ')

  return tool({
    description,
    inputSchema: z.object({}),
    execute: async () => {
      return await loadOutcomeCoverage(ctx.adminDb, ctx.sectionId)
    },
  })
}

/** Starts the background analysis. Console only — see the header. */
function analyzeOutcomeAlignment(ctx: OutcomeAlignmentToolsContext) {
  return tool({
    description:
      'Start an ABET outcomes-alignment analysis for THIS course. It reads the course content in the background and maps it to the ABET engineering Student Outcomes, then shows the coverage — with evidence and any gaps — inline right here in the chat (there is no separate page). Use this when the professor asks whether their course covers ABET / accreditation outcomes, or wants to find coverage gaps. Returns a status immediately — the live progress and results render in the chat.',
    inputSchema: z.object({}),
    execute: async () => {
      const { data: section } = await ctx.adminDb
        .from('course_sections')
        .select('institution_id')
        .eq('id', ctx.sectionId)
        .maybeSingle()
      if (!section?.institution_id) {
        return { status: 'error', message: 'This section is not linked to an institution.' }
      }
      const { data: standard } = await ctx.adminDb
        .from('accreditation_standards')
        .select('id')
        .eq('name', 'ABET Engineering')
        .eq('version', 'EAC 2025-2026')
        .is('institution_id', null)
        .maybeSingle()
      if (!standard?.id) {
        return { status: 'error', message: 'The ABET standard is not available.' }
      }
      const { jobId, alreadyActive } = await enqueueJob({
        type: 'outcome_alignment',
        params: { standardId: standard.id },
        institutionId: section.institution_id,
        sectionId: ctx.sectionId,
        createdBy: ctx.userId,
      })
      return {
        status: alreadyActive ? 'already_running' : 'started',
        jobId,
        message: alreadyActive
          ? "An analysis is already running for this course. Reply in ONE short, casual sentence that it's still going and you'll flag them the moment it's ready — the live status is in the panel just above the message box. Do NOT describe outcomes or coverage; results arrive separately when it finishes."
          : "The background analysis has started. Reply in ONE short, casual sentence that you're on it and will nudge them the moment it's ready — the live progress shows in the panel just above the message box. Do NOT describe outcomes or coverage yet; results arrive separately when it finishes.",
      }
    },
  })
}

/**
 * The accreditation tools this surface should expose.
 *
 * Spread into a surface's tool object. The student tutor gets neither and must never call
 * this: accreditation coverage is faculty/administrative information, so exposure is
 * opt-in per surface rather than inherited.
 */
export function outcomeAlignmentTools(ctx: OutcomeAlignmentToolsContext): ToolSet {
  /* Annotated as ToolSet rather than inferred. The inferred union gives the console
     branch an `analyze_outcome_alignment?: undefined` member, which a spread then carries
     into the surface's tool object and ToolSet's index signature rejects. */
  if (SURFACE_CAPABILITY[ctx.surface] !== 'full') {
    return { show_outcome_coverage: showOutcomeCoverage(ctx) }
  }
  return {
    analyze_outcome_alignment: analyzeOutcomeAlignment(ctx),
    show_outcome_coverage: showOutcomeCoverage(ctx),
  }
}
