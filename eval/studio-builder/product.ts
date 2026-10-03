/**
 * LIVE-MODEL product benchmark for the Studio builder (Step 11). Spends real money on the
 * configured Gemini model; never part of `npm run test`.
 *
 *   STUDIO_BUILDER_RENDERER=local npx tsx --tsconfig eval/tsconfig.json eval/studio-builder/product.ts \
 *     --case=G-attendance,E-office-hours-queue --max-usd=3 --out=tmp/product-bench
 *
 * Each case runs the real harness, checks, check worker and design review (with the local
 * renderer when STUDIO_BUILDER_RENDERER=local), against the in-memory store, with a
 * scripted professor who approves every card and answers questions with the case's answer.
 * Follow-ups run on the draft the build before committed, like a professor's next message.
 *
 * Written under --out (gitignored tmp/ by default), per case: both views, the manifest, the
 * sample data, final screenshots (professor and student, desktop and phone) and result.json
 * with the status, cost, turns, review outcome and the case's pass/fail checks. Nothing is
 * written anywhere else, and no prompt or model reply is kept.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { leakedSecrets } from './guard'
import { common, PRODUCT_CASES, type Built } from './product-cases'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const MAX_USD = Number(args['max-usd'] ?? 3)
const OUT = args.out ?? 'tmp/product-bench'

async function main() {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set. Export it in the shell for this command only.')
  const leaked = leakedSecrets(process.env)
  if (leaked.length > 0) throw new Error(`Refusing to run with ${leaked.join(', ')} in the environment: the benchmark needs only the model key.`)
  if (!(MAX_USD > 0)) throw new Error('--max-usd must be a positive number of dollars.')
  const { runBuilderSlice, WORST_CASE_CALL_USD } = await import('../../src/lib/studio/builder/harness')
  const { createGeminiModel } = await import('../../src/lib/studio/builder/model')
  const { runDraftChecks } = await import('../../src/lib/studio/builder/checks')
  const { runWorkerCheck } = await import('../../src/lib/studio/builder/check-worker')
  const { renderPreview } = await import('../../src/lib/studio/builder/renderer')
  const { createMemoryStore, newRun } = await import('../../src/__tests__/helpers/builder-memory-store')
  const { STUDIO_BUILDER_MAX_SLICES } = await import('../../src/lib/studio/limits')

  const wanted = args.case ? new Set(String(args.case).split(',')) : null
  const cases = PRODUCT_CASES.filter((c) => !wanted || wanted.has(c.id))
  let spent = 0
  const summary: Record<string, unknown>[] = []

  for (const c of cases) {
    if (spent + WORST_CASE_CALL_USD > MAX_USD) {
      summary.push({ id: c.id, skipped: `spend cap $${MAX_USD} reached` })
      continue
    }
    const dir = join(OUT, c.id)
    mkdirSync(dir, { recursive: true })
    const projectId = randomUUID()
    const ownerId = randomUUID()
    const shared = { project: { id: projectId, draftHeadHash: null as string | null, draftRev: 0, draftUndoHash: null }, snapshots: new Map<string, Record<string, unknown>>() }
    let base: { manifest: never; files: Record<string, string>; sample: never } | null = null
    const builds: Record<string, unknown>[] = []
    let asked = false
    let caseCost = 0
    const started = Date.now()

    for (const request of [c.request, ...(c.followUps ?? [])]) {
      const run = newRun({ request, projectId, ownerId, baseHash: shared.project.draftHeadHash, baseRev: shared.project.draftRev })
      const mem = createMemoryStore(run, undefined, shared)
      const startedFrom = base
      const corpus = c.material ?? []
      const excerpt = (p: (typeof corpus)[number]) => ({ key: p.key, label: p.label, disclosure: p.disclosure, opensAt: p.opensAt, text: p.text })
      const deps = {
        store: mem.store,
        model: createGeminiModel(),
        loadSliceData: async () => ({ slug: 'tool-bench0001', published: null, publishedVersions: [], base: startedFrom, course: { code: 'BIO 101', title: 'Introductory Biology' }, skills: ['Cell structure', 'Photosynthesis', 'Genetics'], history: [], materialSources: [] }),
        loadMemories: async () => [],
        gate: async () => (spent + mem.state.run.counters.costUsd + WORST_CASE_CALL_USD <= MAX_USD ? null : ('limit_cost' as const)),
        runChecks: async (_r: unknown, _d: unknown, work: Parameters<typeof runDraftChecks>[0]) =>
          runDraftChecks(work, { workerCheck: runWorkerCheck, rosterFullNames: ['Maria Lopez'], published: null, disclosureSources: [] }),
        searchMaterial: async (_r: unknown, query: string) => {
          const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2)
          const hits = corpus.filter((p) => terms.some((t) => `${p.label} ${p.text}`.toLowerCase().includes(t)))
          const shown = hits.length ? hits : corpus
          return { ok: true as const, shown: shown.map(excerpt), keys: shown.map((p) => p.key), scheduled: [], withheld: 0 }
        },
        rehydrateMaterial: async (_r: unknown, searches: readonly { query: string; focus: unknown; keys: string[] }[]) =>
          searches.map((sr) => ({ query: sr.query, focus: sr.focus as null, shown: sr.keys.flatMap((k) => corpus.filter((p) => p.key === k).map(excerpt)) })),
        recordUsage: async () => {},
        renderPreview,
        audit: () => {},
        kick: () => {},
        now: () => Date.now(),
        heartbeatMs: 5000,
      }
      for (let slice = 0; slice < STUDIO_BUILDER_MAX_SLICES; slice++) {
        await runBuilderSlice({ runId: run.id, sliceNo: mem.state.run.sliceNo }, { id: mem.currentJob().id, deadline: Date.now() + 14 * 60_000 }, deps as never)
        const st = mem.state.run
        if (st.status === 'waiting_for_approval') {
          const card = st.pendingApproval as { proposal_id: string; delta_hash: string }
          mem.professor.decide(card.proposal_id, card.delta_hash, true)
          continue
        }
        if (st.status === 'waiting_for_professor') {
          asked = true
          mem.professor.answer(st.questions.at(-1)!.id, c.answer ?? 'Use your best judgement for a typical university course.')
          continue
        }
        if (st.status !== 'queued') break
      }
      const s = mem.state.run
      spent += s.counters.costUsd
      caseCost += s.counters.costUsd
      const committed = s.resultHash ? (shared.snapshots.get(s.resultHash) as Record<string, unknown> | undefined) : undefined
      if (committed) base = { manifest: committed.manifest as never, files: committed.files as Record<string, string>, sample: (committed.sample_data ?? null) as never }
      const result = s.result as { summary?: string; review?: unknown; open_questions?: string[] } | null
      builds.push({
        request,
        status: s.status,
        errorCode: s.errorCode,
        costUsd: Math.round(s.counters.costUsd * 10_000) / 10_000,
        modelTurns: s.counters.modelTurns,
        repairRounds: s.counters.repairRounds,
        review: result?.review ?? null,
        summary: result?.summary ?? null,
        openQuestions: result?.open_questions ?? [],
        progress: mem.state.steps.map((st) => st.label),
        refused: mem.state.steps.filter((st) => st.status === 'refused').map((st) => String(st.resultSummary.reason)),
        refusedIssues: mem.state.steps.filter((st) => st.status === 'refused').map((st) => JSON.stringify(st.resultSummary.issues ?? null).slice(0, 400)),
      })
      console.log(JSON.stringify({ id: c.id, request: request.slice(0, 60), status: s.status, costUsd: s.counters.costUsd }))
    }

    const files = base?.files ?? {}
    const built: Built = {
      status: String(builds.at(-1)?.status),
      manifest: (base?.manifest ?? null) as Built['manifest'],
      professor: files['views/professor.tsx'] ?? '',
      student: files['views/student.tsx'] ?? '',
      sample: (base?.sample ?? null) as Built['sample'],
      statuses: builds.map((b) => String(b.status)),
      asked,
    }
    const checks = { ...common(built), ...c.checks(built) }
    if (base) {
      writeFileSync(join(dir, 'professor.tsx'), built.professor)
      writeFileSync(join(dir, 'student.tsx'), built.student)
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(base.manifest, null, 2))
      writeFileSync(join(dir, 'sample.json'), JSON.stringify(base.sample, null, 2))
      // Final screenshots of what the professor will preview. No model call.
      const snapshot = [...shared.snapshots.values()].find((x) => x.files === base!.files)
      if (snapshot) {
        const shots = await renderPreview({
          manifest: snapshot.manifest as never,
          bundles: { student: String(snapshot.student_bundle), professor: String(snapshot.professor_bundle) },
          sample: (snapshot.sample_data ?? null) as never,
        })
        if (shots.ok) shots.images.forEach((img, i) => writeFileSync(join(dir, `${i + 1}-${img.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.jpg`), img.bytes))
      }
    }
    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
    const record = { id: c.id, title: c.title, passed: failed.length === 0, failed, checks, costUsd: Math.round(caseCost * 10_000) / 10_000, seconds: Math.round((Date.now() - started) / 1000), builds }
    writeFileSync(join(dir, 'result.json'), JSON.stringify(record, null, 2))
    summary.push({ id: c.id, passed: record.passed, failed, costUsd: record.costUsd, statuses: built.statuses })
  }
  const total = { totalCostUsd: Math.round(spent * 10_000) / 10_000, cases: summary }
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(total, null, 2))
  console.log(JSON.stringify(total, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
