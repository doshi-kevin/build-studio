/**
 * LIVE-MODEL eval for the Studio builder. Spends real money on the configured Gemini
 * model; never part of `npm run test`. Each case runs the real harness, the real draft
 * gate and check worker, and the real model, against the in-memory run store the
 * deterministic suite uses (no database needed), with a scripted professor.
 *
 *   npm run eval:studio-builder                    # every live case
 *   npm run eval:studio-builder -- --case=E1-flashcards
 *   npm run eval:studio-builder -- --max-usd=3     # total spend cap (default 5)
 *   npm run eval:studio-builder -- --json=tmp/builder-eval.json
 *   npm run eval:studio-builder -- --write-baseline  # record eval/studio-builder/baseline.json
 *   npm run eval:studio-builder -- --compare         # compare this run to it
 *
 * The spend cap is hard: before every model call the harness's own gate refuses a call
 * that, at worst case, would take the eval's total past --max-usd.
 *
 * Hard invariants fail the process whatever the outcome: every run ends within the
 * harness's bounds; no approval-needed change lands without the professor's approval;
 * nothing outside the two views is written; no capability without a Bridge method; no
 * saved decision without the scripted professor's approval.
 *
 * Memory cases (M1 to M5) seed saved decisions, may run an earlier build first, and
 * read the first prompt's saved-decision lines in memory to compute named booleans. The
 * prompt is never written anywhere; the baseline keeps the check names and booleans.
 *
 * Course-material cases (R1 to R3) search a small fixed course in memory instead of a
 * database; the real copy guard checks the pages each build saw. They record named
 * booleans only, in the same field.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { buildBaseline, compareBaseline, formatComparison, parseBaseline, toBaselineEntry, type BaselineEntry } from './baseline'
import { randomUUID } from 'node:crypto'
import { CASES, MATERIAL_CASES, MEMORY_CASES, BASE_FILES, BASE_MANIFEST, type BuilderEvalCase, type MaterialPage } from './cases'
import { leakedSecrets } from './guard'
import type { MemoryRecord } from '../../src/__tests__/helpers/builder-memory-store'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const MAX_USD = Number(args['max-usd'] ?? 5)
const BASELINE_PATH = 'eval/studio-builder/baseline.json'

function git(argv: string[]): string | null {
  try {
    return execFileSync('git', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

async function main() {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set. Export it in the shell for this command only.')
  // The eval needs no database. A Supabase secret in its environment means an env file leaked in.
  const leaked = leakedSecrets(process.env)
  if (leaked.length > 0) throw new Error(`Refusing to run with ${leaked.join(', ')} in the environment: the eval needs only the model key.`)
  if (!(MAX_USD > 0)) throw new Error('--max-usd must be a positive number of dollars.')
  if ('write-baseline' in args && args.case) throw new Error('--write-baseline records every live case; drop --case.')
  const comparePath = args.compare ?? BASELINE_PATH
  const compareTo = 'compare' in args ? parseBaseline(JSON.parse(readFileSync(comparePath, 'utf8')), comparePath) : null
  const { runBuilderSlice, WORST_CASE_CALL_USD } = await import('../../src/lib/studio/builder/harness')
  const { createGeminiModel } = await import('../../src/lib/studio/builder/model')
  const { runDraftChecks } = await import('../../src/lib/studio/builder/checks')
  const { runWorkerCheck } = await import('../../src/lib/studio/builder/check-worker')
  const { proposeManifest, AVAILABLE_CAPABILITIES } = await import('../../src/lib/studio/builder/manifest-delta')
  const { activeMemoriesOf, activeMemory, createMemoryStore, newRun } = await import('../../src/__tests__/helpers/builder-memory-store')
  const limits = await import('../../src/lib/studio/limits')
  const { STUDIO_BUILDER_MAX_SLICES } = limits
  const { BUILDER_INSTRUCTIONS_VERSION } = await import('../../src/lib/studio/builder/instructions')
  const { COMPILER_ID } = await import('../../src/lib/studio/builder/compile')
  const { VALIDATOR_VERSION, STUDIO_VALIDATOR_RULESET } = await import('../../src/lib/studio/validator/ruleset')
  const { findCopies } = await import('../../src/lib/studio/builder/disclosure')

  const stamped = (m: Record<string, unknown>) => {
    const r = proposeManifest(JSON.stringify(m), { slug: 'tool-eval0001', current: null, published: null })
    if (!r.ok) throw new Error(`eval fixture manifest invalid: ${JSON.stringify(r.issues)}`)
    return r.manifest
  }

  const results: Record<string, unknown>[] = []
  const entries: BaselineEntry[] = []
  const skipped: string[] = []
  const modelIds = new Set<string>()
  let spent = 0
  let invariantFailures = 0
  const selected = [...CASES, ...MEMORY_CASES, ...MATERIAL_CASES].filter((c) => !c.deterministicOnly && (!args.case || c.id === args.case))

  // The newest behaviour runs first, course material then memory, since the spend cap may not reach every case.
  const rank = (c: BuilderEvalCase) => (c.material ? 2 : c.memory ? 1 : 0)
  selected.sort((a, b) => rank(b) - rank(a))

  for (const c of selected) {
    if (spent + WORST_CASE_CALL_USD > MAX_USD) {
      results.push({ id: c.id, skipped: `spend cap $${MAX_USD} reached` })
      skipped.push(c.id)
      continue
    }
    const firstBase = c.base ? { manifest: stamped({ ...BASE_MANIFEST, ...(c.base.manifest ?? {}) }), files: { ...BASE_FILES, ...(c.base.student ? { 'views/student.tsx': c.base.student } : {}), ...(c.base.professor ? { 'views/professor.tsx': c.base.professor } : {}) } } : null
    // The draft a build starts from: the case's base, or what an earlier build of the case committed.
    let base = firstBase
    // One tool for the case: its saved decisions are shared by every build of it, like the draft pointer.
    const projectId = randomUUID()
    const ownerId = randomUUID()
    const memories: MemoryRecord[] = (c.memory?.saved ?? []).map((m, i) => activeMemory(projectId, ownerId, m.topic, m.kind, m.statement, new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(), m.slot))
    const shared = { project: { id: projectId, draftHeadHash: base ? 'b'.repeat(64) : null, draftRev: base ? 1 : 0, draftUndoHash: null }, snapshots: new Map<string, Record<string, unknown>>(), memories }
    const tokens = { input: 0, cachedInput: 0, output: 0, reasoning: 0 }
    const approved: string[][] = []
    const declined: string[][] = []
    // Every saved decision the scripted professor activated; anything else active is a breach.
    const seeded = new Set(memories.map((m) => m.id))
    const remembered = new Set<string>()
    let cappedByEval = false
    // Course material: the pages any build of the case was shown.
    const corpus = c.material?.corpus ?? []
    const seenKeys = new Set<string>()
    const pageExcerpt = (p: MaterialPage) => ({ key: p.key, label: p.label, disclosure: p.disclosure, opensAt: p.opensAt, text: p.text })
    const searchCourse = async (_run: unknown, query: string) => {
      const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2)
      const hits = corpus.filter((p) => terms.some((t) => `${p.label} ${p.text}`.toLowerCase().includes(t))).slice(0, 6)
      for (const p of hits) seenKeys.add(p.key)
      return { ok: true as const, shown: hits.map(pageExcerpt), keys: hits.map((p) => p.key), scheduled: hits.filter((p) => p.disclosure === 'scheduled').map((p) => p.key), withheld: 0 }
    }
    const rehydrateCourse = async (_run: unknown, searches: readonly { query: string; focus: unknown; keys: string[] }[]) =>
      searches.map((sr) => ({ query: sr.query, focus: sr.focus as null, shown: sr.keys.flatMap((k) => corpus.filter((p) => p.key === k).map(pageExcerpt)) }))
    // The real guard, over every scheduled page a build of this case saw.
    const guardSources = () => corpus.filter((p) => p.disclosure === 'scheduled' && seenKeys.has(p.key)).map((p) => ({ key: p.key, label: p.label, disclosure: p.disclosure, opensAt: p.opensAt, text: p.text }))

    /** One build of the case's tool, driven to its end by the scripted professor. */
    const build = async (request: string) => {
      // Start from the tool's current draft, so a build after another one isn't a stale-draft conflict.
      const run = newRun({ request, projectId, ownerId, baseHash: shared.project.draftHeadHash, baseRev: shared.project.draftRev })
      const startedFrom = base
      const mem = createMemoryStore(run, undefined, shared)
      const gemini = createGeminiModel()
      // Token totals, model ids, and the first prompt's saved-decision lines; nothing else of a call is kept.
      let firstPrompt: string | null = null
      const addTokens = (u: { input: number; cachedInput: number; output: number; reasoning: number } | null | undefined) => {
        if (!u) return
        tokens.input += u.input
        tokens.cachedInput += u.cachedInput
        tokens.output += u.output
        tokens.reasoning += u.reasoning
      }
      const model: typeof gemini = {
        id: gemini.id,
        step: async (input) => {
          firstPrompt ??= input.prompt
          try {
            const reply = await gemini.step(input)
            addTokens(reply.usage)
            modelIds.add(reply.modelId)
            return reply
          } catch (error) {
            addTokens((error as { usage?: typeof tokens | null }).usage)
            throw error
          }
        },
      }
      const deps = {
        store: mem.store,
        model,
        loadSliceData: async () => ({ slug: 'tool-eval0001', published: null, publishedVersions: [], base: startedFrom, course: c.course ?? { code: 'BIO 101', title: 'Introductory Biology' }, skills: c.skills ?? ['Cell structure', 'Photosynthesis'], history: [], materialSources: [] }),
        loadMemories: async (r: { projectId: string }) => activeMemoriesOf(memories, r.projectId),
        gate: async () => {
          if (spent + mem.state.run.counters.costUsd + WORST_CASE_CALL_USD <= MAX_USD) return null
          cappedByEval = true
          return 'limit_cost' as const
        },
        runChecks: async (_r: unknown, _d: unknown, work: Parameters<typeof runDraftChecks>[0]) => runDraftChecks(work, { workerCheck: runWorkerCheck, rosterFullNames: ['Maria Lopez'], published: null, disclosureSources: guardSources() }),
        searchMaterial: c.material ? searchCourse : async () => ({ ok: false as const }),
        rehydrateMaterial: c.material ? rehydrateCourse : async () => [],
        recordUsage: async () => {},
        audit: () => {},
        kick: () => {},
        now: () => Date.now(),
        heartbeatMs: 5000,
      }
      for (let slice = 0; slice < STUDIO_BUILDER_MAX_SLICES; slice++) {
        await runBuilderSlice({ runId: run.id, sliceNo: mem.state.run.sliceNo }, { id: mem.currentJob().id, deadline: Date.now() + 14 * 60_000 }, deps as never)
        const st = mem.state.run
        if (st.status === 'waiting_for_approval') {
          const card = st.pendingApproval as { proposal_id: string; delta_hash: string; items: { kind: string }[] }
          const kinds = card.items.map((i) => i.kind)
          const ok = kinds.every((k) => (c.approve as string[]).includes(k))
          ;(ok ? approved : declined).push(kinds)
          mem.professor.decide(card.proposal_id, card.delta_hash, ok)
          continue
        }
        if (st.status === 'waiting_for_professor') {
          mem.professor.answer(st.questions.at(-1)!.id, c.answer ?? 'Use your best judgement for a typical university course.')
          continue
        }
        if (st.status !== 'queued') break
      }
      spent += mem.state.run.counters.costUsd
      // A committed snapshot becomes the next build's starting draft.
      const committed = mem.state.run.resultHash ? (shared.snapshots.get(mem.state.run.resultHash) as { manifest?: unknown; files?: Record<string, string> } | undefined) : undefined
      if (committed?.files && committed.manifest) base = { manifest: committed.manifest as NonNullable<typeof base>['manifest'], files: committed.files as NonNullable<typeof base>['files'] }
      return { mem, run, firstPrompt: firstPrompt as string | null, startedFrom }
    }

    const started = Date.now()
    let priorProposals = 0
    let priorCost = 0
    if (c.memory?.prior) {
      const prior = await build(c.memory.prior)
      priorCost = prior.mem.state.run.counters.costUsd
      const raised = memories.filter((m) => m.sourceRunId === prior.run.id && m.status === 'proposed')
      priorProposals = raised.length
      // The scripted professor says Remember to everything the earlier build suggested.
      for (const m of raised) if (prior.mem.professor.decideMemory(m.id, true) === 'decided') remembered.add(m.id)
    }
    const { mem, run, firstPrompt, startedFrom } = await build(c.request)
    const s = mem.state.run

    let memoryFacts: { proposals: number; checks: Record<string, boolean> } | undefined
    if (c.memory) {
      const blockText = firstPrompt ? /kind="project-memory" provenance="project-memory">\n([\s\S]*?)\n<\/data_/.exec(firstPrompt)?.[1] ?? '' : ''
      const carried = blockText ? blockText.split('\n').map((line) => line.replace(/^m\d+ (constraint|preference) \([a-z_]+\/[a-z_]+\): /, '')) : []
      const raised = memories.filter((m) => m.sourceRunId === run.id && m.origin === 'approved_proposal')
      // What approval would supersede, as the database does it: the named decision and the slot's occupant.
      const superseded = (m: MemoryRecord) =>
        memories.filter((x) => x.status === 'active' && (x.id === m.replacesId || (x.topic === m.topic && x.slot === m.slot))).map((x) => x.statement)
      const proposals = raised.map((m) => ({ topic: m.topic, slot: m.slot, statement: m.statement, replaces: superseded(m) }))
      const active = () => memories.filter((m) => m.status === 'active').map((m) => m.statement)
      const activeBefore = active()
      for (const m of raised.filter((x) => x.status === 'proposed')) if (mem.professor.decideMemory(m.id, true) === 'decided') remembered.add(m.id)
      const activeAfter = active()
      // Growth of this build's own commit over the draft it started from; none without a commit.
      const own = s.resultHash ? (shared.snapshots.get(s.resultHash) as { files?: Record<string, string> } | undefined) : undefined
      const studentGrowth = own?.files?.['views/student.tsx'] !== undefined ? Buffer.byteLength(own.files['views/student.tsx']) - Buffer.byteLength(startedFrom?.files['views/student.tsx'] ?? '') : null
      const checks = c.memory.checks({ priorProposals, carried, proposals, activeBefore, activeAfter, studentGrowth })
      memoryFacts = { proposals: raised.length, checks }
    }
    if (c.material) {
      const own = s.resultHash ? (shared.snapshots.get(s.resultHash) as { manifest?: unknown; files?: Record<string, string> } | undefined) : undefined
      const searches = mem.state.steps.filter((st) => st.tool === 'search_course_material' && st.status === 'done' && st.label === 'material.searched').length
      const disclosureRefusals = mem.state.steps.filter((st) => st.tool === 'run_checks' && Object.keys((st.resultSummary.failing as Record<string, number> | undefined) ?? {}).some((k) => k.startsWith('builder.disclosure'))).length
      const copiesScheduled = own?.files ? findCopies({ manifest: own.manifest as never, files: own.files }, guardSources()).copies.length > 0 : false
      const raised = memories.filter((m) => m.sourceRunId === run.id)
      const checks = c.material.checks({ request: c.request, searches, disclosureRefusals, studentView: own?.files?.['views/student.tsx'] ?? null, copiesScheduled, proposalEvidence: raised.map((m) => m.evidence ?? '') })
      memoryFacts = { proposals: raised.length, checks }
    }

    const snapshot = [...mem.state.snapshots.values()].at(-1) as { manifest?: { views?: Record<string, { capabilities: string[] }> }; files?: Record<string, string> } | undefined
    const caps = snapshot ? Object.values(snapshot.manifest?.views ?? {}).flatMap((v) => v.capabilities) : []
    const invariants = {
      terminal: ['preview_ready', 'completed', 'blocked', 'cancelled', 'budget_exhausted', 'failed'].includes(s.status),
      onlyTwoFiles: !snapshot || Object.keys(snapshot.files ?? {}).sort().join() === 'views/professor.tsx,views/student.tsx',
      catalogCapabilitiesOnly: caps.every((cap) => (AVAILABLE_CAPABILITIES as string[]).includes(cap)),
      // Every capability the committed manifest adds over its base came through an approved card.
      noUnapprovedCapability:
        caps.length - ((startedFrom?.manifest.views.student.capabilities.length ?? 0) + (startedFrom?.manifest.views.professor.capabilities.length ?? 0)) <=
        approved.flat().filter((k) => k === 'capability_added').length,
      // Nothing becomes an active decision unless the case saved it or the scripted professor approved that row.
      noUnapprovedMemory: memories.every((m) => m.status !== 'active' || seeded.has(m.id) || remembered.has(m.id)),
    }
    const held = Object.values(invariants).every(Boolean)
    if (!held) invariantFailures += 1
    const refused = mem.state.steps
      .filter((st) => st.status === 'refused')
      .map((st) => (Array.isArray(st.resultSummary.issues) ? `${st.resultSummary.reason}: ${(st.resultSummary.issues as string[]).join('; ')}` : String(st.resultSummary.reason)))
    // A case with an earlier build is charged for both builds.
    const counters = { ...s.counters, costUsd: s.counters.costUsd + priorCost }
    const entry = toBaselineEntry(c, { run: { ...s, counters }, approvals: { approved: approved.length, declined: declined.length }, tokens, invariantsHeld: held, cappedByEval, memory: memoryFacts })
    const result = {
      id: c.id,
      title: c.title,
      status: s.status,
      errorCode: s.errorCode,
      success: entry.passed,
      invariants,
      modelTurns: s.counters.modelTurns,
      toolCalls: s.counters.toolCalls,
      repairRounds: s.counters.repairRounds,
      checkRuns: s.counters.checkRuns,
      costUsd: Math.round(counters.costUsd * 10_000) / 10_000,
      seconds: Math.round((Date.now() - started) / 1000),
      cappedByEval,
      approvedCards: approved,
      declinedCards: declined,
      memory: entry.memory,
      refused,
    }
    results.push(result)
    entries.push(entry)
    console.log(JSON.stringify(result))
  }

  const ran = results.filter((r) => !('skipped' in r))
  const summary = {
    model: [...modelIds],
    ran: ran.length,
    succeeded: ran.filter((r) => r.success).length,
    invariantFailures,
    totalCostUsd: Math.round(spent * 10_000) / 10_000,
    deterministicOnly: [...CASES, ...MEMORY_CASES, ...MATERIAL_CASES].filter((c) => c.deterministicOnly).map((c: BuilderEvalCase) => `${c.id}: ${c.deterministicOnly}`),
  }
  console.log(JSON.stringify(summary, null, 2))
  if (args.json) writeFileSync(args.json, JSON.stringify({ summary, results }, null, 2))

  const sha = git(['rev-parse', '--short', 'HEAD'])
  const status = git(['status', '--porcelain'])
  const baseline = buildBaseline(
    {
      modelIds: [...modelIds].sort(),
      instructionsVersion: BUILDER_INSTRUCTIONS_VERSION,
      validatorVersion: VALIDATOR_VERSION,
      validatorRuleset: STUDIO_VALIDATOR_RULESET,
      compilerId: COMPILER_ID,
      limits: {
        modelTurns: limits.STUDIO_BUILDER_MAX_MODEL_TURNS,
        toolCalls: limits.STUDIO_BUILDER_MAX_TOOL_CALLS,
        toolCallsPerTurn: limits.STUDIO_BUILDER_MAX_TOOL_CALLS_PER_TURN,
        writes: limits.STUDIO_BUILDER_MAX_WRITES,
        repairRounds: limits.STUDIO_BUILDER_MAX_REPAIR_ROUNDS,
        checkRuns: limits.STUDIO_BUILDER_MAX_CHECK_RUNS,
        sameFinding: limits.STUDIO_BUILDER_SAME_FINDING_LIMIT,
        consecutiveErrors: limits.STUDIO_BUILDER_MAX_CONSECUTIVE_ERRORS,
        questions: limits.STUDIO_BUILDER_MAX_QUESTIONS,
        runCostUsd: limits.STUDIO_BUILDER_RUN_MAX_COST_USD,
        worstCaseCallUsd: Math.round(WORST_CASE_CALL_USD * 1000) / 1000,
        contextTokens: limits.STUDIO_BUILDER_CONTEXT_MAX_TOKENS,
        outputTokens: limits.STUDIO_BUILDER_MAX_OUTPUT_TOKENS,
      },
      maxUsd: MAX_USD,
      date: new Date().toISOString(),
      git: { sha, dirty: status === null ? null : status.length > 0 },
    },
    entries,
    skipped,
  )
  // Written before comparing, so a paid run is kept even if the comparison fails.
  if ('write-baseline' in args) {
    writeFileSync(args['write-baseline'] ?? BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(`Baseline written to ${args['write-baseline'] ?? BASELINE_PATH}.`)
  }
  let regressions = 0
  if (compareTo) {
    const comparison = compareBaseline(compareTo, baseline)
    regressions = comparison.regressions.length
    console.log(`\nCompared with the baseline from ${compareTo.date} (${compareTo.git.sha ?? 'unknown sha'}${compareTo.git.dirty ? ', dirty tree' : ''}):`)
    console.log(formatComparison(comparison))
  }
  if (invariantFailures > 0 || regressions > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
