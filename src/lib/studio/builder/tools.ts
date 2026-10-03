/**
 * The builder's tool registry: the eleven tools, and nothing else, that the model may call
 * (approved decision 1.6, plus propose_memory in Step 8B and search_course_material in
 * Step 9). Each entry defines its name,
 * schema, what it may change and what is recorded about it. No tool takes an id, a path
 * outside the two views, or any scope: every tool is a closure over the run. The one
 * thing that looks like a reference, propose_memory's `replaces`, is a short label the
 * prompt showed (m1, m2); the harness maps it to a row of this project, or refuses it.
 *
 * Tools don't persist anything. `execute` returns an outcome and the harness writes it
 * through one fenced database call (studio_builder_apply / _pause / _end), or refuses.
 * So a tool can't skip the claim token, Stop, the working-copy revision or a cap.
 *
 * Step summaries hold paths, byte counts, short content hashes, enum values and reason
 * codes. Never file content, manifest text, plan text or model prose.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { KIT_IMPORTABLE_NAMES, type KitImportName } from '../kit/plugin-kit-types'
import {
  STUDIO_BUILDER_EDIT_OLD_TEXT_MAX_BYTES,
  STUDIO_BUILDER_FILE_MAX_BYTES,
  STUDIO_BUILDER_MANIFEST_MAX_BYTES,
  STUDIO_BUILDER_MAX_BYTES_WRITTEN,
  STUDIO_BUILDER_MAX_CHECK_RUNS,
  STUDIO_BUILDER_MAX_QUESTIONS,
  STUDIO_BUILDER_MAX_REPAIR_ROUNDS,
  STUDIO_BUILDER_MAX_SEARCHES,
  STUDIO_BUILDER_MAX_WRITES,
  STUDIO_BUILDER_OPEN_QUESTIONS_MAX,
  STUDIO_BUILDER_QUESTION_MAX_CHARS,
  STUDIO_BUILDER_SAME_FINDING_LIMIT,
  STUDIO_BUILDER_SUMMARY_MAX_CHARS,
  STUDIO_COURSE_QUERY_MAX_BYTES,
  STUDIO_MATERIAL_SOURCES_MAX,
  STUDIO_MEMORY_EVIDENCE_MAX_CHARS,
  STUDIO_MEMORY_EVIDENCE_MIN_CHARS,
  STUDIO_MEMORY_MAX_ACTIVE,
  STUDIO_MEMORY_PROPOSALS_PER_RUN,
  STUDIO_MEMORY_STATEMENT_MAX_CHARS,
} from '../limits'
import type { StudioManifest } from '../manifest'
import { blockingKeys, type DraftCheckResult } from './checks'
import { CheckFault, CheckTimeout } from './check-worker-errors'
import { cleanQuery, FOCUS_PATTERN, withSources, type MaterialFocus } from './course-material'
import type { SearchOutcome } from './course-retriever'
import { evidenceProblem, isSlotOf, MEMORY_KINDS, MEMORY_SLOT_KEYS, MEMORY_SLOTS, MEMORY_TOPICS, statementProblem, supports, type MemoryKind, type MemorySlot, type MemoryTopic } from './memory'
import { deltaHash, proposeManifest, type DeltaItem } from './manifest-delta'
import type { ModelToolDecl } from './model'
import { characterProblem, PLUGIN_PATHS, stripBom, utf8Bytes, viewContentProblem, VIEW_OF, type PluginPath } from './paths'
import { contentHash, sha16, workHash } from './snapshot'
import { planSchema, type Plan, type ValidationCode, type Work } from './work'

export const TOOL_NAMES = [
  'read_file', 'get_kit_reference', 'write_file', 'edit_file', 'propose_manifest_change',
  'run_checks', 'submit_plan', 'ask_professor', 'propose_memory', 'search_course_material', 'finish',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export type RefusalCode =
  | 'unknown_tool' | 'invalid_args' | 'sdk_invalid' | 'no_tool_call' | 'turn_timeout' | 'turn_truncated' | 'turn_call_limit'
  | 'plan_required' | 'file_missing' | 'not_in_working_set' | 'match_count' | 'file_too_large' | 'bad_characters'
  | 'write_limit' | 'bytes_limit' | 'check_limit' | 'question_limit' | 'search_limit'
  | 'manifest_invalid' | 'capability_unavailable' | 'collection_frozen' | 'purpose_flagged'
  | 'memory_slot' | 'memory_statement' | 'memory_evidence' | 'memory_limit' | 'memory_replaces' | 'memory_duplicate' | 'memory_full' | 'memory_unavailable'

/** The refusals a memory proposal can come back with from the database. */
export const MEMORY_REFUSALS = ['memory_evidence', 'memory_limit', 'memory_replaces', 'memory_duplicate', 'memory_full', 'memory_unavailable'] as const satisfies readonly RefusalCode[]

/** The only refusal vocabulary, each with its fixed hint for the next turn. */
export const REFUSAL_HINTS: Record<RefusalCode, string> = {
  unknown_tool: 'Use one of the listed tools.',
  invalid_args: 'The arguments don’t match the tool’s schema. Paths are exactly views/student.tsx or views/professor.tsx.',
  sdk_invalid: 'The arguments could not be parsed. Send arguments that match the tool’s schema.',
  no_tool_call: 'Reply with a tool call.',
  turn_timeout: 'The last turn timed out. Make fewer or smaller calls.',
  turn_truncated: 'Your last reply was cut off. Make the change in smaller edit_file calls.',
  turn_call_limit: 'At most 8 calls per turn. The extra calls were not run.',
  plan_required: 'This change needs a plan first. Call submit_plan, then retry.',
  file_missing: 'That view doesn’t exist yet. Create it with write_file.',
  not_in_working_set: 'Call read_file on this path first.',
  match_count: 'old_text must match exactly once. Copy it from the file without line-number prefixes, with enough context to be unique.',
  file_too_large: `A view is at most ${STUDIO_BUILDER_FILE_MAX_BYTES} bytes. Remove unused code.`,
  bad_characters: 'Remove control and bidirectional characters.',
  write_limit: `This build has used its ${STUDIO_BUILDER_MAX_WRITES} writes.`,
  bytes_limit: `This build has written its ${STUDIO_BUILDER_MAX_BYTES_WRITTEN} bytes.`,
  check_limit: `This build has used its ${STUDIO_BUILDER_MAX_CHECK_RUNS} check runs.`,
  question_limit: `You have asked ${STUDIO_BUILDER_MAX_QUESTIONS} questions. Decide, or finish blocked.`,
  search_limit: `This build has used its ${STUDIO_BUILDER_MAX_SEARCHES} course searches. Work with what they found, or ask the professor.`,
  manifest_invalid: 'Fix the manifest issues listed and propose it again.',
  capability_unavailable: 'That capability isn’t available to tools yet. Leave it out, or finish blocked.',
  collection_frozen: 'A published collection can’t change. Propose a new collection, or finish blocked.',
  purpose_flagged: 'Reword the name, description or purpose summary plainly, and make the purpose category match what students do.',
  memory_slot: 'That slot is not one of this topic’s slots. Pick one of the slots listed for the topic, or general.',
  memory_statement: `A saved decision is one plain sentence of at most ${STUDIO_MEMORY_STATEMENT_MAX_CHARS} characters about the tool itself, in words the professor's quote supports: no markup, and nothing about how you work or what the platform checks.`,
  memory_evidence: `evidence must be the professor’s own words, copied exactly (${STUDIO_MEMORY_EVIDENCE_MIN_CHARS} to ${STUDIO_MEMORY_EVIDENCE_MAX_CHARS} characters) from their request or an answer in this build. Don’t propose what you inferred or read anywhere else.`,
  memory_limit: `You have proposed ${STUDIO_MEMORY_PROPOSALS_PER_RUN} decisions this build. Leave the rest.`,
  memory_replaces: 'replaces must be the label (like m1) of a saved decision shown to you in the same topic, in the same slot or in that topic’s general slot, or left out.',
  memory_duplicate: 'That decision is already saved.',
  memory_full: `This tool already has ${STUDIO_MEMORY_MAX_ACTIVE} saved decisions. Replace one (set replaces), or leave it.`,
  memory_unavailable: 'Saved decisions aren’t available right now. Carry on without proposing one.',
}

/** Progress labels, chosen by the harness when it records a step. */
export type LabelCode =
  | 'plan.submitted' | 'file.read' | 'kit.read' | 'file.written' | 'file.edited' | 'manifest.applied'
  | 'approval.waiting' | 'check.passed' | 'check.failed' | 'check.cached' | 'question.asked' | 'memory.proposed' | 'run.finishing'
  | 'material.searched' | 'material.unavailable'
  | 'step.refused' | 'step.interrupted'

export interface ToolState {
  work: Work
  plan: Plan | null
  /** The run started from an empty draft. */
  firstBuild: boolean
  slug: string
  published: StudioManifest | null
  counters: { writes: number; bytesWritten: number; checkRuns: number; repairRounds: number; questions: number }
  /** Saved decisions. `aliases` maps only the labels the prompt showed this turn to rows of this project. */
  memory: {
    aliases: Readonly<Record<string, { id: string; topic: MemoryTopic; slot: MemorySlot }>>
    /** The professor's own text in this run: the only text a proposal's evidence may quote. */
    professorTexts: readonly string[]
    proposals: number
  }
  runChecks: (work: Work) => Promise<DraftCheckResult>
  /** Searches the run's own course, scoped by the harness from the run row. */
  searchMaterial: (query: string, focus: MaterialFocus | null) => Promise<SearchOutcome>
}

export type Delta = {
  writes?: number
  bytes_written?: number
  check_runs?: number
  repair_rounds?: number
}

export type Summary = Record<string, string | number | boolean | null | string[] | Record<string, number>>

export interface PendingApproval {
  proposal_id: string
  tool_call_id: string
  /** The working-copy revision the card was raised on; deciding requires it unchanged. */
  work_rev: number
  base_manifest_hash: string | null
  proposed_manifest: unknown
  items: DeltaItem[]
  direct: DeltaItem[]
  delta_hash: string
}

export type ToolOutcome =
  | {
      kind: 'done'
      label: LabelCode
      args: Summary
      result: Summary
      work?: Work
      plan?: Plan
      phase?: 'planning' | 'editing' | 'checking' | 'repairing'
      delta: Delta
      /** A check that ran (not a cached one). */
      check?: DraftCheckResult
      /** Set when this failed check ends the run. */
      exhausted?: ValidationCode
    }
  | { kind: 'refused'; code: RefusalCode; args: Summary; issues?: string[] }
  | { kind: 'error'; code: 'internal' | 'check_timeout'; args: Summary }
  | { kind: 'approval'; args: Summary; result: Summary; pending: Omit<PendingApproval, 'tool_call_id'>; delta: Delta }
  | { kind: 'question'; args: Summary; question: string }
  | { kind: 'memory'; args: Summary; proposal: MemoryProposal }
  | { kind: 'finish'; args: Summary; status: 'completed' | 'blocked'; summary: string; openQuestions: string[] }

/** A checked proposal, ready for the database function that records it as inert. */
export interface MemoryProposal {
  topic: MemoryTopic
  slot: MemorySlot
  kind: MemoryKind
  statement: string
  evidence: string
  /** The row the model's label named, or null. */
  replacesId: string | null
}

export interface ToolSpec {
  name: ToolName
  kind: 'read' | 'write' | 'check' | 'control'
  description: string
  schema: z.ZodObject
  execute: (state: ToolState, args: never) => Promise<ToolOutcome> | ToolOutcome
}

const path = z.enum(PLUGIN_PATHS)
const prose = (max: number) => z.string().min(1).max(max)
const refused = (code: RefusalCode, args: Summary, issues?: string[]): ToolOutcome => ({ kind: 'refused', code, args, issues: issues?.slice(0, 5).map((i) => i.slice(0, 160)) })

function budgetRefusal(state: ToolState, bytes: number, args: Summary): ToolOutcome | null {
  if (state.counters.writes + 1 > STUDIO_BUILDER_MAX_WRITES) return refused('write_limit', args)
  if (state.counters.bytesWritten + bytes > STUDIO_BUILDER_MAX_BYTES_WRITTEN) return refused('bytes_limit', args)
  return null
}

function withFile(work: Work, p: PluginPath, text: string): Work {
  return {
    ...work,
    work_rev: work.work_rev + 1,
    files: { ...work.files, [p]: text },
    working_set: work.working_set.includes(p) ? work.working_set : [...work.working_set, p],
    changed: work.changed.includes(p) ? work.changed : [...work.changed, p],
  }
}

/**
 * Runs the gate and accounts for it: the shared body of run_checks and the completion
 * gate. A result cached for unchanged work counts as nothing. A failed check is a repair
 * round; the run ends when repair rounds or check runs are spent, or when a blocking
 * finding has survived STUDIO_BUILDER_SAME_FINDING_LIMIT repairs.
 */
export async function checkStep(state: ToolState, args: Summary): Promise<ToolOutcome & { cached?: boolean }> {
  const hash = workHash(state.work.manifest, state.work.files)
  const last = state.work.last_check
  // A result whose roster or course-material check couldn't run is never reused: checking
  // again is how a transient read failure clears.
  const readFailed = last?.summary.roster === 'unavailable' || last?.summary.disclosure === 'unavailable'
  if (last && last.work_hash === hash && !readFailed) {
    return { kind: 'done', label: 'check.cached', args, result: { cached: true, passed: last.passed, blocking: last.findings.filter((f) => f.required).length }, delta: {}, cached: true }
  }
  if (state.counters.checkRuns >= STUDIO_BUILDER_MAX_CHECK_RUNS) return refused('check_limit', args)
  let result: DraftCheckResult
  try {
    result = await state.runChecks(state.work)
  } catch (error) {
    if (error instanceof CheckTimeout) return { kind: 'error', code: 'check_timeout', args }
    if (error instanceof CheckFault) return { kind: 'error', code: 'internal', args }
    throw error
  }
  const keys = blockingKeys(result.findings)
  const streaks: Record<string, number> = {}
  if (!result.passed) for (const k of keys) streaks[k] = (state.work.streaks[k] ?? 0) + 1
  const work: Work = {
    ...state.work,
    last_check: { work_hash: result.workHash, passed: result.passed, findings: result.findings, total: result.totalFindings, summary: result.summary },
    streaks,
  }
  const failing = Object.fromEntries(result.summary.unresolved.map((u) => [`${u.check_id}|${u.file}`, u.count]))
  const summary: Summary = { cached: false, passed: result.passed, blocking: keys.length, compile_ok: result.summary.compile === 'passed', failing }
  if (result.passed) return { kind: 'done', label: 'check.passed', args, result: summary, work, phase: 'checking', delta: { check_runs: 1 }, check: result }

  let exhausted: ValidationCode | undefined
  if (state.counters.repairRounds >= STUDIO_BUILDER_MAX_REPAIR_ROUNDS) exhausted = 'repair_rounds'
  else if (Object.values(streaks).some((n) => n - 1 >= STUDIO_BUILDER_SAME_FINDING_LIMIT)) exhausted = 'same_finding'
  else if (state.counters.checkRuns + 1 >= STUDIO_BUILDER_MAX_CHECK_RUNS) exhausted = 'check_runs'
  return {
    kind: 'done',
    label: 'check.failed',
    args,
    result: summary,
    work,
    phase: 'repairing',
    delta: { check_runs: 1, repair_rounds: exhausted ? 0 : 1 },
    check: result,
    exhausted,
  }
}

/** Whether this call needs a plan the run doesn't have yet. A workflow rule: plans grant nothing. */
export function planGate(state: ToolState, tool: ToolName, args: Record<string, unknown>): string | null {
  const writesView = tool === 'write_file' || tool === 'edit_file'
  if (tool === 'propose_manifest_change' && !state.plan) return REFUSAL_HINTS.plan_required
  if (writesView && state.firstBuild && !state.plan) return REFUSAL_HINTS.plan_required
  if (writesView && state.firstBuild && !state.work.manifest) return 'Propose the manifest with propose_manifest_change first, then write the views.'
  if (writesView && !state.plan) {
    const target = args.path as PluginPath
    const other = state.work.changed.filter((p) => p !== target)
    if (other.length > 0 && !state.work.changed.includes(target)) return REFUSAL_HINTS.plan_required
  }
  return null
}

const TOOL_LIST: ToolSpec[] = [
  {
    name: 'read_file',
    kind: 'read',
    description: 'Show one view file. Its full text appears in the next turn, with line numbers, and you may then edit it.',
    schema: z.strictObject({ path }),
    execute: (state, args: { path: PluginPath }) => {
      const text = state.work.files[args.path]
      if (typeof text !== 'string') return refused('file_missing', { path: args.path })
      const result: Summary = { bytes: utf8Bytes(text), lines: text.split('\n').length, sha16: sha16(text) }
      if (state.work.working_set.includes(args.path)) return { kind: 'done', label: 'file.read', args: { path: args.path }, result: { ...result, already_shown: true }, delta: {} }
      return { kind: 'done', label: 'file.read', args: { path: args.path }, result, work: { ...state.work, working_set: [...state.work.working_set, args.path] }, delta: {} }
    },
  },
  {
    name: 'get_kit_reference',
    kind: 'read',
    description: 'Show the props and usage notes of one kit component, hook or function.',
    schema: z.strictObject({ component: z.enum(KIT_IMPORTABLE_NAMES) }),
    execute: (state, args: { component: KitImportName }) => {
      const refs = state.work.kit_refs.filter((n) => n !== args.component)
      return { kind: 'done', label: 'kit.read', args: { component: args.component }, result: { shown: true }, work: { ...state.work, kit_refs: [...refs, args.component] }, delta: {} }
    },
  },
  {
    name: 'write_file',
    kind: 'write',
    description: 'Create or replace a whole view file in this build’s working copy.',
    schema: z.strictObject({ path, content: z.string().max(STUDIO_BUILDER_FILE_MAX_BYTES) }),
    execute: (state, args: { path: PluginPath; content: string }) => {
      const text = stripBom(args.content)
      const before = state.work.files[args.path]
      const summary: Summary = { path: args.path, bytes: utf8Bytes(text), sha16: sha16(text) }
      const problem = viewContentProblem(text)
      if (problem) return refused(problem.code, summary, [problem.detail])
      const over = budgetRefusal(state, utf8Bytes(text), summary)
      if (over) return over
      return {
        kind: 'done',
        label: 'file.written',
        args: summary,
        result: { bytes_before: typeof before === 'string' ? utf8Bytes(before) : null, bytes_after: utf8Bytes(text) },
        work: withFile(state.work, args.path, text),
        phase: 'editing',
        delta: { writes: 1, bytes_written: utf8Bytes(text) },
      }
    },
  },
  {
    name: 'edit_file',
    kind: 'write',
    description: 'Replace exactly one occurrence of old_text with new_text in a view you have read.',
    schema: z.strictObject({
      path,
      old_text: z.string().min(1).max(STUDIO_BUILDER_EDIT_OLD_TEXT_MAX_BYTES),
      new_text: z.string().max(STUDIO_BUILDER_FILE_MAX_BYTES),
    }),
    execute: (state, args: { path: PluginPath; old_text: string; new_text: string }) => {
      const summary: Summary = { path: args.path, old_bytes: utf8Bytes(args.old_text), new_bytes: utf8Bytes(args.new_text) }
      const text = state.work.files[args.path]
      if (typeof text !== 'string') return refused('file_missing', summary)
      if (!state.work.working_set.includes(args.path)) return refused('not_in_working_set', summary)
      if (args.old_text === args.new_text) return refused('match_count', summary, ['old_text and new_text are the same'])
      const matches = text.split(args.old_text).length - 1
      if (matches !== 1) return refused('match_count', { ...summary, matches }, [`old_text matched ${matches} times`])
      const index = text.indexOf(args.old_text)
      const next = text.slice(0, index) + args.new_text + text.slice(index + args.old_text.length)
      const problem = viewContentProblem(next)
      if (problem) return refused(problem.code, summary, [problem.detail])
      const over = budgetRefusal(state, utf8Bytes(args.new_text), summary)
      if (over) return over
      return {
        kind: 'done',
        label: 'file.edited',
        args: summary,
        result: { bytes_before: utf8Bytes(text), bytes_after: utf8Bytes(next), matches: 1 },
        work: withFile(state.work, args.path, next),
        phase: 'editing',
        delta: { writes: 1, bytes_written: utf8Bytes(args.new_text) },
      }
    },
  },
  {
    name: 'propose_manifest_change',
    kind: 'write',
    description:
      'Propose the whole manifest, as a JSON string. The platform validates it and sets the fields it owns. New capabilities, collections, signals, skill slots, access changes and purpose changes wait for the professor’s approval; other changes apply at once.',
    schema: z.strictObject({ manifest_json: z.string().min(2).max(STUDIO_BUILDER_MANIFEST_MAX_BYTES) }),
    execute: (state, args: { manifest_json: string }) => {
      const bytes = utf8Bytes(args.manifest_json)
      const summary: Summary = { bytes, sha16: sha16(args.manifest_json) }
      const proposal = proposeManifest(args.manifest_json, { slug: state.slug, current: state.work.manifest, published: state.published })
      if (!proposal.ok) return refused(proposal.code, summary, proposal.issues)
      if (!proposal.changed) return { kind: 'done', label: 'manifest.applied', args: summary, result: { unchanged: true, needs_approval: false, stamped: proposal.stamped }, delta: {} }
      const over = budgetRefusal(state, bytes, summary)
      if (over) return over
      const counts = Object.fromEntries(Object.entries(Object.groupBy(proposal.approval, (i) => i.kind)).map(([k, v]) => [k, v?.length ?? 0]))
      if (proposal.approval.length > 0) {
        return {
          kind: 'approval',
          args: summary,
          result: { needs_approval: true, items: proposal.approval.length, kinds: counts, stamped: proposal.stamped },
          pending: {
            proposal_id: randomUUID(),
            work_rev: state.work.work_rev,
            base_manifest_hash: state.work.manifest ? contentHash(state.work.manifest) : null,
            proposed_manifest: proposal.manifest,
            items: proposal.approval,
            direct: proposal.direct,
            delta_hash: deltaHash(state.work.work_rev, state.work.manifest, proposal.manifest),
          },
          delta: { writes: 1, bytes_written: bytes },
        }
      }
      return {
        kind: 'done',
        label: 'manifest.applied',
        args: summary,
        result: { needs_approval: false, direct: proposal.direct.length, stamped: proposal.stamped },
        work: {
          ...state.work,
          work_rev: state.work.work_rev + 1,
          manifest: proposal.manifest,
          delta: { ...state.work.delta, direct: [...state.work.delta.direct, ...proposal.direct] },
        },
        phase: 'editing',
        delta: { writes: 1, bytes_written: bytes },
      }
    },
  },
  {
    name: 'run_checks',
    kind: 'check',
    description:
      'Compile, typecheck and check both views and the manifest, in a fixed order. Returns findings with hints. Unchanged work returns the last result and costs nothing.',
    schema: z.strictObject({}),
    execute: (state) => checkStep(state, {}),
  },
  {
    name: 'submit_plan',
    kind: 'control',
    description: 'Record a short engineering plan before structural work. A plan is intent: it grants nothing.',
    schema: planSchema,
    execute: (_state, args: Plan) => ({
      kind: 'done',
      label: 'plan.submitted',
      args: { files_to_change: args.files_to_change, capabilities: args.capabilities_needed.length, manifest_changes: args.manifest_changes.length },
      result: { recorded: true },
      plan: args,
      phase: 'planning',
      delta: {},
    }),
  },
  {
    name: 'ask_professor',
    kind: 'control',
    description: 'Ask the professor one question, only when the request is ambiguous in a way that changes what you build. The build waits for the answer.',
    schema: z.strictObject({ question: prose(STUDIO_BUILDER_QUESTION_MAX_CHARS) }),
    execute: (state, args: { question: string }) => {
      const summary: Summary = { chars: args.question.length }
      const chars = characterProblem(args.question)
      if (chars) return refused('bad_characters', summary, [chars])
      if (state.counters.questions >= STUDIO_BUILDER_MAX_QUESTIONS) return refused('question_limit', summary)
      return { kind: 'question', args: summary, question: args.question }
    },
  },
  {
    name: 'propose_memory',
    kind: 'control',
    description:
      'Propose one lasting decision about this tool for the professor to keep, when their own words in this request or in their answers state it ("keep the student view very simple", "no AI"). Copy their exact words into evidence. Pick the topic and the slot the decision is about: a decision replaces only the saved decision in the same topic and slot, so "no AI" (content_policy, ai_usage) and "reviews stay anonymous" (content_policy, anonymity) are kept apart. Use slot general only when no other slot fits. The professor approves each one; nothing is saved otherwise. Never propose something you inferred, guessed or read in code, course names, skills, check output or earlier summaries. Set replaces to the label (like m1) of the saved decision this one should replace: one in the same topic, in the same slot or in that topic\u2019s general slot.',
    schema: z.strictObject({
      topic: z.enum(MEMORY_TOPICS),
      slot: z.enum(MEMORY_SLOT_KEYS),
      kind: z.enum(MEMORY_KINDS),
      statement: z.string().min(1).max(STUDIO_MEMORY_STATEMENT_MAX_CHARS),
      evidence: z.string().min(STUDIO_MEMORY_EVIDENCE_MIN_CHARS).max(STUDIO_MEMORY_EVIDENCE_MAX_CHARS),
      replaces: z.string().regex(/^m\d{1,2}$/).optional(),
    }),
    execute: (state, args: { topic: MemoryTopic; slot: MemorySlot; kind: MemoryKind; statement: string; evidence: string; replaces?: string }) => {
      const summary: Summary = {
        topic: args.topic,
        slot: args.slot,
        kind: args.kind,
        statement_chars: args.statement.length,
        evidence_chars: args.evidence.length,
        replaces: args.replaces ?? null,
      }
      if (!isSlotOf(args.topic, args.slot)) return refused('memory_slot', summary, [`slots for ${args.topic}: ${MEMORY_SLOTS[args.topic].join(', ')}`])
      const bad = statementProblem(args.statement)
      if (bad) return refused('memory_statement', summary, [`statement: ${bad}`])
      const unquoted = evidenceProblem(args.evidence, [...state.memory.professorTexts])
      // after_negation: the quote must include the professor's "not", or it says the opposite.
      if (unquoted) return refused('memory_evidence', summary, [`evidence: ${unquoted}`])
      // The quote has to be about the sentence, or any four characters of the request would do.
      if (!supports(args.statement, args.evidence)) return refused('memory_statement', summary, ['statement: not supported by the quote'])
      if (state.memory.proposals >= STUDIO_MEMORY_PROPOSALS_PER_RUN) return refused('memory_limit', summary)
      let replacesId: string | null = null
      if (args.replaces !== undefined) {
        const named = Object.hasOwn(state.memory.aliases, args.replaces) ? state.memory.aliases[args.replaces] : null
        // The decision in the same topic and slot, or the topic's general one: changing AI use
        // can retire an old general "no AI" decision, never the anonymity decision.
        if (!named || named.topic !== args.topic || (named.slot !== args.slot && named.slot !== 'general')) return refused('memory_replaces', summary)
        replacesId = named.id
      }
      return { kind: 'memory', args: summary, proposal: { topic: args.topic, slot: args.slot, kind: args.kind, statement: args.statement, evidence: args.evidence, replacesId } }
    },
  },
  {
    name: 'search_course_material',
    kind: 'read',
    description:
      'Search this course’s own material (lectures, readings, notes, the syllabus, assignment descriptions) when the request depends on what the course teaches, such as "a practice tool for this week’s lecture on transformers". Send 1 to 4 topic keywords as query. Say when only through focus: this_week, next_week or week:N, never in query. The excerpts appear in the next turn as data, each labelled with its source and whether students can see it. Use text marked "not visible to students yet" for structure and topics only, never copy its wording into the tool. Don’t search for requests about the tool’s layout, wording or behaviour.',
    schema: z.strictObject({
      query: z.string().min(1).max(STUDIO_COURSE_QUERY_MAX_BYTES),
      focus: z.string().regex(FOCUS_PATTERN).optional(),
    }),
    execute: async (state, args: { query: string; focus?: string }) => {
      const focus = (args.focus ?? null) as MaterialFocus | null
      const summary: Summary = { query_chars: args.query.length, query_sha16: sha16(args.query), focus }
      const chars = characterProblem(args.query)
      if (chars) return refused('bad_characters', summary, [chars])
      if (utf8Bytes(args.query) > STUDIO_COURSE_QUERY_MAX_BYTES) return refused('invalid_args', summary, ['query: too long'])
      const material = state.work.material
      // Every call that reaches the database counts, successful or not.
      if (material.attempts >= STUDIO_BUILDER_MAX_SEARCHES) return refused('search_limit', summary)
      // Retrieval is optional context: an outage is a result the model reads, never an error
      // that counts toward ending the run. After one, the run doesn't search again.
      if (material.unavailable) return { kind: 'done', label: 'material.unavailable', args: summary, result: { unavailable: true }, delta: {} }
      const query = cleanQuery(args.query)
      // Only time words: nothing to search for, and nothing spent.
      if (!query) return { kind: 'done', label: 'material.searched', args: summary, result: { results: 0, scheduled: 0, withheld: 0, empty_query: true }, delta: {} }
      const outcome = await state.searchMaterial(query, focus)
      if (!outcome.ok) {
        return {
          kind: 'done',
          label: 'material.unavailable',
          args: summary,
          result: { unavailable: true },
          work: { ...state.work, material: { ...material, attempts: material.attempts + 1, unavailable: true } },
          delta: {},
        }
      }
      const sources = withSources(material.sources, outcome.scheduled, STUDIO_MATERIAL_SOURCES_MAX)
      const sourcesChanged = sources.length !== material.sources.length || sources.some((k, i) => k !== material.sources[i])
      return {
        kind: 'done',
        label: 'material.searched',
        args: summary,
        result: { results: outcome.keys.length, scheduled: outcome.scheduled.length, withheld: outcome.withheld },
        work: {
          ...state.work,
          // A passing check cached before these sources were seen no longer proves the copy guard.
          last_check: sourcesChanged ? null : state.work.last_check,
          material: { ...material, attempts: material.attempts + 1, searches: [...material.searches, { query, focus, keys: outcome.keys }], sources },
        },
        delta: {},
      }
    },
  },
  {
    name: 'finish',
    kind: 'control',
    description:
      'End the build. "completed" asks the platform to check everything and save the draft for preview; it keeps working with you if a check fails. "blocked" ends it with a plain reason.',
    schema: z.strictObject({
      status: z.enum(['completed', 'blocked']),
      summary: prose(STUDIO_BUILDER_SUMMARY_MAX_CHARS),
      open_questions: z.array(prose(200)).max(STUDIO_BUILDER_OPEN_QUESTIONS_MAX),
    }),
    execute: (_state, args: { status: 'completed' | 'blocked'; summary: string; open_questions: string[] }) => {
      const summary: Summary = { status: args.status, summary_chars: args.summary.length, questions: args.open_questions.length }
      for (const text of [args.summary, ...args.open_questions]) {
        const chars = characterProblem(text)
        if (chars) return refused('bad_characters', summary, [chars])
      }
      return { kind: 'finish', args: summary, status: args.status, summary: args.summary, openQuestions: args.open_questions }
    },
  },
]

/** The registry. A name declared but not registered is a compile error. */
export const TOOLS = Object.fromEntries(TOOL_LIST.map((t) => [t.name, t])) as Record<ToolName, ToolSpec>

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name)
}

/** What the model is told exists: the same eleven tools on every turn. */
export function toolDeclarations(): ModelToolDecl[] {
  return TOOL_NAMES.map((name) => ({ name, description: TOOLS[name].description, inputSchema: TOOLS[name].schema }))
}

/** The order calls run in: as proposed, except checks after the turn's writes, and finish or ask last. */
export function orderCalls<T extends { name: string }>(calls: T[]): T[] {
  const rank = (c: T) => (c.name === 'finish' || c.name === 'ask_professor' ? 2 : c.name === 'run_checks' ? 1 : 0)
  return calls.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c)
}

export { VIEW_OF }
