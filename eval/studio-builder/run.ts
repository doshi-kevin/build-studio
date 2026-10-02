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
 * nothing outside the two views is written; no capability without a Bridge method.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { buildBaseline, compareBaseline, formatComparison, parseBaseline, toBaselineEntry, type BaselineEntry } from './baseline'
import { CASES, BASE_FILES, BASE_MANIFEST, type BuilderEvalCase } from './cases'

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
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set (.env.local).')
  if (!(MAX_USD > 0)) throw new Error('--max-usd must be a positive number of dollars.')
  if ('write-baseline' in args && args.case) throw new Error('--write-baseline records every live case; drop --case.')
  const comparePath = args.compare ?? BASELINE_PATH
  const compareTo = 'compare' in args ? parseBaseline(JSON.parse(readFileSync(comparePath, 'utf8')), comparePath) : null
  const { runBuilderSlice, WORST_CASE_CALL_USD } = await import('../../src/lib/studio/builder/harness')
  const { createGeminiModel } = await import('../../src/lib/studio/builder/model')
  const { runDraftChecks } = await import('../../src/lib/studio/builder/checks')
  const { runWorkerCheck } = await import('../../src/lib/studio/builder/check-worker')
  const { proposeManifest, AVAILABLE_CAPABILITIES } = await import('../../src/lib/studio/builder/manifest-delta')
  const { createMemoryStore, newRun } = await import('../../src/__tests__/helpers/builder-memory-store')
  const limits = await import('../../src/lib/studio/limits')
  const { STUDIO_BUILDER_MAX_SLICES } = limits
  const { BUILDER_INSTRUCTIONS_VERSION } = await import('../../src/lib/studio/builder/instructions')
  const { COMPILER_ID } = await import('../../src/lib/studio/builder/compile')
  const { VALIDATOR_VERSION, STUDIO_VALIDATOR_RULESET } = await import('../../src/lib/studio/validator/ruleset')

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
  const selected = CASES.filter((c) => !c.deterministicOnly && (!args.case || c.id === args.case))

  for (const c of selected) {
    if (spent + WORST_CASE_CALL_USD > MAX_USD) {
      results.push({ id: c.id, skipped: `spend cap $${MAX_USD} reached` })
      skipped.push(c.id)
      continue
    }
    const base = c.base ? { manifest: stamped({ ...BASE_MANIFEST, ...(c.base.manifest ?? {}) }), files: { ...BASE_FILES, ...(c.base.student ? { 'views/student.tsx': c.base.student } : {}), ...(c.base.professor ? { 'views/professor.tsx': c.base.professor } : {}) } } : null
    const run = newRun({ request: c.request, baseHash: base ? 'b'.repeat(64) : null, baseRev: base ? 1 : 0 })
    const mem = createMemoryStore(run)
    const gemini = createGeminiModel()
    // Token totals and model ids from each reply; nothing else of the reply is kept.
    const tokens = { input: 0, cachedInput: 0, output: 0, reasoning: 0 }
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
    let cappedByEval = false
    const approved: string[][] = []
    const declined: string[][] = []
    const deps = {
      store: mem.store,
      model,
      loadSliceData: async () => ({ slug: 'tool-eval0001', published: null, publishedVersions: [], base, course: { code: 'BIO 101', title: 'Introductory Biology' }, skills: c.skills ?? ['Cell structure', 'Photosynthesis'], history: [] }),
      // The cases don't use saved decisions; memory has its own harness tests.
      loadMemories: async () => [],
      gate: async () => {
        if (spent + mem.state.run.counters.costUsd + WORST_CASE_CALL_USD <= MAX_USD) return null
        cappedByEval = true
        return 'limit_cost' as const
      },
      runChecks: async (_r: unknown, _d: unknown, work: Parameters<typeof runDraftChecks>[0]) => runDraftChecks(work, { workerCheck: runWorkerCheck, rosterFullNames: ['Maria Lopez'], published: null }),
      recordUsage: async () => {},
      audit: () => {},
      kick: () => {},
      now: () => Date.now(),
      heartbeatMs: 5000,
    }
    const started = Date.now()
    for (let slice = 0; slice < STUDIO_BUILDER_MAX_SLICES; slice++) {
      await runBuilderSlice({ runId: run.id, sliceNo: mem.state.run.sliceNo }, { id: mem.currentJob().id, deadline: Date.now() + 14 * 60_000 }, deps as never)
      const s = mem.state.run
      if (s.status === 'waiting_for_approval') {
        const card = s.pendingApproval as { proposal_id: string; delta_hash: string; items: { kind: string }[] }
        const kinds = card.items.map((i) => i.kind)
        const ok = kinds.every((k) => (c.approve as string[]).includes(k))
        ;(ok ? approved : declined).push(kinds)
        mem.professor.decide(card.proposal_id, card.delta_hash, ok)
        continue
      }
      if (s.status === 'waiting_for_professor') {
        mem.professor.answer(s.questions.at(-1)!.id, c.answer ?? 'Use your best judgement for a typical university course.')
        continue
      }
      if (s.status !== 'queued') break
    }
    const s = mem.state.run
    spent += s.counters.costUsd
    const snapshot = [...mem.state.snapshots.values()].at(-1) as { manifest?: { views?: Record<string, { capabilities: string[] }> }; files?: Record<string, string> } | undefined
    const caps = snapshot ? Object.values(snapshot.manifest?.views ?? {}).flatMap((v) => v.capabilities) : []
    const invariants = {
      terminal: ['preview_ready', 'completed', 'blocked', 'cancelled', 'budget_exhausted', 'failed'].includes(s.status),
      onlyTwoFiles: !snapshot || Object.keys(snapshot.files ?? {}).sort().join() === 'views/professor.tsx,views/student.tsx',
      catalogCapabilitiesOnly: caps.every((cap) => (AVAILABLE_CAPABILITIES as string[]).includes(cap)),
      // Every capability the committed manifest adds over its base came through an approved card.
      noUnapprovedCapability:
        caps.length - ((base?.manifest.views.student.capabilities.length ?? 0) + (base?.manifest.views.professor.capabilities.length ?? 0)) <=
        approved.flat().filter((k) => k === 'capability_added').length,
    }
    const held = Object.values(invariants).every(Boolean)
    if (!held) invariantFailures += 1
    const refused = mem.state.steps
      .filter((st) => st.status === 'refused')
      .map((st) => (Array.isArray(st.resultSummary.issues) ? `${st.resultSummary.reason}: ${(st.resultSummary.issues as string[]).join('; ')}` : String(st.resultSummary.reason)))
    const result = {
      id: c.id,
      title: c.title,
      status: s.status,
      errorCode: s.errorCode,
      success: c.expect.includes(s.status),
      invariants,
      modelTurns: s.counters.modelTurns,
      toolCalls: s.counters.toolCalls,
      repairRounds: s.counters.repairRounds,
      checkRuns: s.counters.checkRuns,
      costUsd: Math.round(s.counters.costUsd * 10_000) / 10_000,
      seconds: Math.round((Date.now() - started) / 1000),
      cappedByEval,
      approvedCards: approved,
      declinedCards: declined,
      refused,
    }
    results.push(result)
    entries.push(toBaselineEntry(c, { run: s, approvals: { approved: approved.length, declined: declined.length }, tokens, invariantsHeld: held, cappedByEval }))
    console.log(JSON.stringify(result))
  }

  const ran = results.filter((r) => !('skipped' in r))
  const summary = {
    model: [...modelIds],
    ran: ran.length,
    succeeded: ran.filter((r) => r.success).length,
    invariantFailures,
    totalCostUsd: Math.round(spent * 10_000) / 10_000,
    deterministicOnly: CASES.filter((c) => c.deterministicOnly).map((c: BuilderEvalCase) => `${c.id}: ${c.deterministicOnly}`),
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
