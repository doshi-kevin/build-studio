/**
 * The student tool contract — design doc §13.1.
 *
 * Before this file, every tool was correct by author discipline: an empty
 * `inputSchema` because the author knew not to accept an id, a scoping comment
 * because the author remembered to write one, and navigation as a bespoke
 * callback wired for exactly one tool. That holds for four tools and breaks on
 * the fifth. This makes the same invariants structural:
 *
 *   1. No identifiers in tool input, ever — enforced at definition time by
 *      `assertBoundedInput`, not by review. Every id comes from the context,
 *      which is built from the verified session. This is what keeps the surface
 *      free of prompt-reachable IDOR, and it matters far more once a tool's
 *      output ends in a write (N5).
 *   2. `kind` is declared, so "does this tool propose a mutation" is a field a
 *      reviewer can read rather than a property they have to infer.
 *   3. One directive channel — a tool asks the app to move by calling
 *      `ctx.emit()`; the route resolves at most one directive per answer. A
 *      second navigating tool costs nothing here, where a second bespoke
 *      callback would have cost a parse path on the client.
 *
 * The model never sees any of it: directives are built by the route from values
 * the ranking chose, and appended after the answer (see athena-directive.ts).
 */

import { tool, type Tool } from 'ai'
import { z } from 'zod'
import type { AthenaRunEvent } from '@/lib/ai/athena-directive'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdminDb = any

// ── The directive channel ─────────────────────────────────────────────────────

/** What a tool may ask the app to do. Every field is server-chosen — in
 *  particular `route` is built by the typed registry (`@/lib/routes/student`)
 *  from ids resolved server-side, never assembled by the model. */
export type Directive =
  | { type: 'goto_node'; nodeKey: string; title: string }
  /** Drive to a pre-filled app surface. `label` is what the navigation card
   *  shows the student ("Challenges · Graph Traversal Sprint"). `prefill` is a
   *  drafted form value for surfaces that need prose rather than an id — it
   *  travels out of band, never in the URL (§14.4). */
  | {
      type: 'goto_page'
      route: string
      label: string
      /** The receipt sentence: what she did, and what is now theirs to do. */
      said: string
      prefill?: { kind: 'lc_question' | 'booking_note'; text: string }
    }

/** Higher wins when two tools ask in one turn. A proposal outranks a plain
 *  navigation: the student asked her to set something up, and landing on the
 *  roadmap instead would strand the thing she just prepared. */
const PRECEDENCE: Record<Directive['type'], number> = { goto_node: 0, goto_page: 1 }

export interface DirectiveChannel {
  emit(directive: Directive): void
  /** The one directive the route should append, or null. */
  resolve(): Directive | null
}

export function createDirectiveChannel(): DirectiveChannel {
  let held: Directive | null = null
  return {
    emit(directive) {
      // Ties go to the later emit, matching the callback it replaces.
      if (!held || PRECEDENCE[directive.type] >= PRECEDENCE[held.type]) held = directive
    },
    resolve: () => held,
  }
}

// ── The request-scoped context ────────────────────────────────────────────────

export interface AthenaStudentCtx {
  /** From the verified session — the ONLY source of identity. */
  readonly userId: string
  /** From the verified enrollment. */
  readonly sectionId: string
  /** From the verified section row — the ONLY source of tenancy for writes. */
  readonly institutionId: string
  /** The ownership-verified open thread, or null (unpersisted chat). Lets a
   *  `create` tool link what it made back to the conversation it came from. */
  readonly conversationId: string | null
  readonly adminDb: AdminDb
  /** The pages retrieved for THIS turn — the set a `create` tool grounds an
   *  artifact in (design doc §15.4). `material`/`page` come from the `[Title, p.N]`
   *  markers; `text` is the page body, used to ATTRIBUTE each generated item to
   *  the page it best matches (the same content-overlap engine quiz generation
   *  uses, `@/lib/quiz/source-citation`) when the model's own cite is wrong or
   *  missing. Empty when nothing was retrieved (an un-indexed course or an
   *  out-of-corpus question), which is what makes a fact-bearing artifact decline
   *  rather than ship ungrounded. Optional so the read/propose tools, which never
   *  cite, don't have to supply it. */
  readonly citablePages?: readonly { material: string; page: number; text?: string; moduleItemId?: string }[]
  /** The app-driving channel (§13.3). */
  emit(directive: Directive): void
}

// ── The definition helper ─────────────────────────────────────────────────────

/** Zod kinds a tool input may contain. Bounded by construction: the model can
 *  pick from a closed set, and cannot name a row. `string` is absent on
 *  purpose — it is the shape every id arrives in. */
const BOUNDED_KINDS = new Set(['enum', 'boolean', 'number', 'literal'])
/** Wrappers to look through before judging the kind. */
const WRAPPER_KINDS = new Set(['optional', 'nullable', 'default'])

function boundedKindOf(schema: z.ZodTypeAny): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let def = (schema as any)._def
  let guard = 0
  while (def && WRAPPER_KINDS.has(def.type) && guard++ < 8) def = def.innerType?._def
  return def?.type ?? 'unknown'
}

/**
 * Invariant 1, enforced. Throws at module load (tools are defined at module
 * scope), so a violation fails the build and the test run rather than shipping
 * a tool the model can hand a section id to.
 */
export function assertBoundedInput(name: string, input: z.ZodObject<z.ZodRawShape>): void {
  for (const [field, schema] of Object.entries(input.shape)) {
    const kind = boundedKindOf(schema as z.ZodTypeAny)
    if (!BOUNDED_KINDS.has(kind)) {
      throw new Error(
        `defineStudentTool("${name}"): input field "${field}" is a ${kind}. ` +
          'Student tool inputs may carry bounded enums, booleans, numbers and literals only — ' +
          'never an id, key or free text. Every identifier comes from AthenaStudentCtx (design doc §13.1).',
      )
    }
  }
}

/** Field names that smell like a row reference. A `create` tool's CONTENT is
 *  model-authored prose by nature, so the bounded-input rule can't apply — the
 *  invariant that survives is "no identifiers in tool input": the model may
 *  write flashcards, never name a row. Anchors are resolved server-side from
 *  human labels within the ctx's already-authorized scope. */
const IDENTIFIER_TOKEN = /^(id|uuid|key|ref|url|href|path)s?$/i
/** Matched per NAME TOKEN, so `moduleId` is caught as surely as `module_id` —
 *  camelCase is how every identifier in this codebase is actually spelled, and
 *  for a create tool this name check is the only guard left (the bounded-kind
 *  rule that rejects a free `z.string()` by TYPE does not run). */
const isIdentifierField = (field: string) =>
  field.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).some((t) => IDENTIFIER_TOKEN.test(t))

/**
 * The `create`-kind counterpart of `assertBoundedInput`: walks the whole input
 * schema (through wrappers, arrays, records, unions, tuples and nested objects)
 * and throws on any field whose NAME suggests it carries a reference. Same
 * load-time enforcement.
 *
 * Defense-in-depth, NOT the authorization boundary: it is a name lint, so a
 * field called `moduleName` or `slug` passes it. What actually prevents
 * prompt-reachable IDOR in a create tool is that every query in its `run` is
 * scoped by ctx (`.eq('section_id', ctx.sectionId)` etc.) — keep writing those.
 */
export function assertNoIdentifierFields(name: string, input: z.ZodObject<z.ZodRawShape>): void {
  const walk = (schema: z.ZodTypeAny, trail: string): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let def = (schema as any)._def
    let guard = 0
    while (def && WRAPPER_KINDS.has(def.type) && guard++ < 8) def = def.innerType?._def
    if (!def) return
    if (def.type === 'object') {
      const shape: Record<string, z.ZodTypeAny> =
        typeof def.shape === 'function' ? def.shape() : def.shape
      for (const [field, child] of Object.entries(shape ?? {})) {
        if (isIdentifierField(field)) {
          throw new Error(
            `defineStudentTool("${name}"): input field "${trail}${field}" looks like an identifier. ` +
              'Create-tool inputs carry content only; every id comes from AthenaStudentCtx, and anchors ' +
              'are resolved server-side from human labels (design doc §13.1).',
          )
        }
        walk(child, `${trail}${field}.`)
      }
    } else if (def.type === 'array' || def.type === 'record') {
      const el = def.element ?? def.valueType
      if (el) walk(el, `${trail}[].`)
    } else if (def.type === 'union' || def.type === 'discriminatedUnion') {
      for (const opt of def.options ?? []) walk(opt, trail)
    } else if (def.type === 'tuple') {
      for (const item of def.items ?? []) walk(item, `${trail}[].`)
    }
  }
  walk(input, '')
}

/** One declared step of a `propose` tool's plan. */
export interface PlanStep {
  id: string
  /** What the student reads: "Check what's still open", never a function name. */
  label: string
}

/**
 * Reports a declared step as it runs. Passed to a propose tool's `run`; the
 * step ids it accepts are exactly the ones the definition declared, so the plan
 * the student sees cannot drift from the plan the code executes — and the model
 * has no way to author either.
 */
export interface PlanReporter {
  step<T>(id: string, work: () => Promise<T>, describe?: (result: T) => string): Promise<T>
}

export interface StudentToolDef<TInput extends z.ZodObject<z.ZodRawShape>, TResult> {
  /** The name the model calls. */
  name: string
  description: string
  /** Bounded enums/booleans only — see `assertBoundedInput`. */
  input: TInput
  /** `'read'` has no write path — not "doesn't write today". `'propose'` drives
   *  the app to a pre-filled surface and never executes the mutation itself.
   *  `'create'` writes exactly one NEW row of Athena's own content, owned by
   *  this student (a study artifact) — never a mutation of an existing record,
   *  a grade, or anything another user can see. */
  kind: 'read' | 'propose' | 'create'
  /** Run-card row name, for the student: "Your quiz scores", never the tool's
   *  name. Written here because this is the only place that knows what ran. */
  label: string
  /** Run-card detail line, derived from the tool's own result. */
  describe: (result: TResult) => string
  /** `'propose'` only: the ordered steps this tool works through, shown to the
   *  student as a plan card (§14.5). Declared here — static, server-owned — so
   *  the card is a record of what ran and never a story about it. */
  steps?: readonly PlanStep[]
  run: (
    ctx: AthenaStudentCtx,
    input: z.infer<TInput>,
    plan: PlanReporter,
  ) => Promise<TResult>
}

export function defineStudentTool<TInput extends z.ZodObject<z.ZodRawShape>, TResult>(
  def: StudentToolDef<TInput, TResult>,
): StudentToolDef<TInput, TResult> {
  // Content-carrying create tools trade the bounded-kind rule for the
  // no-identifiers rule; everything else keeps the strict form.
  if (def.kind === 'create') assertNoIdentifierFields(def.name, def.input)
  else assertBoundedInput(def.name, def.input)
  if (def.kind === 'propose' && !def.steps?.length) {
    // A proposal is multi-step by nature, and §13.4's rule is that multi-step
    // work is visible. Silently rendering no card would make the drive look
    // like the app moving on its own.
    throw new Error(`defineStudentTool("${def.name}"): a propose tool must declare its steps.`)
  }
  return def
}

/**
 * A tool of unknown input/result shape — the existential you need to hold
 * definitions of differing result types in one array. `describe` makes
 * `StudentToolDef` contravariant in its result, so `unknown` genuinely cannot
 * stand in here; this is a variance escape hatch, not a silenced error. Each
 * definition is still fully checked at its own `defineStudentTool` call.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStudentTool = StudentToolDef<any, any>

// ── Building the AI SDK tool set ──────────────────────────────────────────────

/**
 * Bind definitions to a request. The timing wrapper lives here rather than in
 * each tool, so every tool reports itself to the run card and none can forget
 * to close a row it opened.
 */
type Emit = (event: AthenaRunEvent) => void

/**
 * Time one unit of work and report it as a row. Used for both card kinds — the
 * only difference is `group`, so a row can never open without also closing.
 */
async function reportRow<T>(
  emit: Emit | undefined,
  row: { id: string; name: string; group?: 'plan'; card?: string },
  work: () => Promise<T>,
  describe: (result: T) => string,
): Promise<T> {
  const startedAt = Date.now()
  emit?.({ phase: 'start', id: row.id, name: row.name, detail: '', group: row.group, card: row.card })
  try {
    const result = await work()
    emit?.({
      phase: 'done',
      id: row.id,
      name: row.name,
      detail: describe(result),
      ms: Date.now() - startedAt,
      group: row.group,
      card: row.card,
    })
    return result
  } catch (err) {
    // A row that opened must close, or the card spins forever on work that
    // already failed. The error still reaches the model as a tool error.
    emit?.({
      phase: 'done',
      id: row.id,
      name: row.name,
      detail: 'unavailable',
      ms: Date.now() - startedAt,
      group: row.group,
      card: row.card,
    })
    throw err
  }
}

/**
 * Bind definitions to a request. The timing wrapper lives here rather than in
 * each tool, so every tool reports itself to the run card and none can forget
 * to close a row it opened.
 *
 * A `read` tool is one row on the lookup card. A `propose` tool is a plan card
 * whose rows are its declared steps — never a row of its own, since "found you
 * a challenge" is the card's title, not a step within it.
 */
export function buildStudentTools(
  ctx: AthenaStudentCtx,
  defs: AnyStudentTool[],
  onRun?: (event: AthenaRunEvent) => void,
): Record<string, Tool> {
  const tools: Record<string, Tool> = {}
  for (const def of defs) {
    const declared = new Map((def.steps ?? []).map((s: PlanStep) => [s.id, s]))
    const plan: PlanReporter = {
      step: (id, work, describe) => {
        const step = declared.get(id)
        // Undeclared means the code and the card have drifted — the plan the
        // student reads would no longer be the plan that ran.
        if (!step) {
          throw new Error(`${def.name}: step "${id}" was reported but never declared.`)
        }
        return reportRow(
          onRun,
          { id: `${def.name}:${id}`, name: step.label, group: 'plan', card: def.label },
          work,
          (r) => (describe ? describe(r) : ''),
        )
      },
    }

    tools[def.name] = tool({
      description: def.description,
      inputSchema: def.input,
      execute: async (input: unknown) => {
        if (def.kind === 'propose') return def.run(ctx, input, plan)
        return reportRow(onRun, { id: def.name, name: def.label }, () => def.run(ctx, input, plan), def.describe)
      },
    })
  }
  return tools
}
