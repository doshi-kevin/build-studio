/**
 * The design review and sample data, through the real harness with a scripted model and the
 * in-memory store (Step 11). What these prove: a review runs only after the checks pass, at
 * most STUDIO_BUILDER_MAX_REVIEW_ROUNDS times; an "improve" verdict sends its findings back
 * to the builder; and nothing about a review (a failed render, a model outage, no budget, a
 * missing answer) can fail a build that passed its checks. Stop still stops it.
 */
import { describe, expect, it, vi } from 'vitest'
import { runBuilderSlice, WORST_CASE_CALL_USD, type HarnessDeps, type SliceData } from '@/lib/studio/builder/harness'
import { runDraftChecks } from '@/lib/studio/builder/checks'
import type { RenderOutcome } from '@/lib/studio/builder/renderer'
import { REVIEW_INSTRUCTIONS } from '@/lib/studio/builder/review'
import { readPlan } from '@/lib/studio/builder/work'
import { parseManifest, type StudioManifestV2 } from '@/lib/studio/manifest'
import { STUDIO_BUILDER_MAX_REVIEW_ROUNDS, STUDIO_BUILDER_REVIEW_IMAGE_MAX_BYTES, STUDIO_BUILDER_RUN_MAX_COST_USD } from '@/lib/studio/limits'
import { createMemoryStore, newRun } from './helpers/builder-memory-store'
import { call, finish, FLASHCARDS_MANIFEST, inProcessWorkerCheck, PROFESSOR_VIEW, scriptedModel, STUDENT_VIEW, type ScriptedTurn } from './helpers/builder-fixtures'

const SLUG = 'tool-abc12345'

function stamped(m: unknown = FLASHCARDS_MANIFEST): StudioManifestV2 {
  const parsed = parseManifest({
    ...(m as object),
    manifestVersion: 2,
    id: SLUG,
    version: '0.0.0',
    bridgeVersion: 'v2',
    views: { student: { entry: 'views/student.tsx', capabilities: [] }, professor: { entry: 'views/professor.tsx', capabilities: [] } },
  })
  if (!parsed.ok || parsed.manifest.manifestVersion !== 2) throw new Error(JSON.stringify(parsed))
  return parsed.manifest
}

const views = { 'views/student.tsx': STUDENT_VIEW, 'views/professor.tsx': PROFESSOR_VIEW }
const ready = { calls: [call('submit_review', { verdict: 'ready', unmet_requirements: [], major_issues: [], minor_issues: [] })] }
const improve = (major = 'Professor desktop: the deck has no count; add a StatCard with the number of cards above the list.') => ({
  calls: [call('submit_review', { verdict: 'improve', unmet_requirements: [], major_issues: [major], minor_issues: [] })],
})
const SAMPLE = {
  cards: [{ data: { term: 'Osmosis', definition: 'Water moving across a membrane' } }, { data: { term: 'Mitosis', definition: 'Cell division' } }],
  progress: [{ student: 0, data: { cardId: 'a', known: true } }],
}
const sample = (data: unknown = SAMPLE) => call('write_sample_data', { data_json: JSON.stringify(data) })
// An edit that changes the work, so a second review has something new to look at.
const tweak = (n: number) => call('edit_file', { path: 'views/professor.tsx', old_text: n === 1 ? 'Add card' : 'Add a card', new_text: n === 1 ? 'Add a card' : 'Add one card' })

const jpeg = (label: string, bytes = 1000) => ({ label, mediaType: 'image/jpeg' as const, bytes: new Uint8Array(bytes).fill(1) })

function harness(script: ScriptedTurn[], setup: { render?: HarnessDeps['renderPreview']; costUsd?: number } = {}) {
  const run = newRun({ status: 'queued', baseHash: 'b'.repeat(64), baseRev: 1, request: 'Make the flashcards nicer' })
  if (setup.costUsd !== undefined) run.counters.costUsd = setup.costUsd
  const mem = createMemoryStore(run)
  const model = scriptedModel(script)
  const base: SliceData['base'] = { manifest: stamped(), files: { ...views } }
  const renderPreview = vi.fn(setup.render ?? (async (): Promise<RenderOutcome> => ({ ok: true, images: [jpeg('Professor view, desktop'), jpeg('Student view, phone')], failures: [] })))
  const deps: HarnessDeps = {
    store: mem.store,
    model,
    loadSliceData: async () => ({ slug: SLUG, published: null, publishedVersions: [], base, course: null, skills: null, history: [], materialSources: [] }),
    loadMemories: async () => [],
    gate: async () => null,
    runChecks: async (_run, data, work) => runDraftChecks(work, { workerCheck: inProcessWorkerCheck, rosterFullNames: ['Maria Lopez'], published: data.published, disclosureSources: [] }),
    searchMaterial: async () => ({ ok: false as const }),
    rehydrateMaterial: async () => [],
    recordUsage: vi.fn(async () => {}),
    renderPreview,
    audit: vi.fn(),
    kick: vi.fn(),
    now: () => Date.now(),
    heartbeatMs: 5,
  }
  const slice = () => runBuilderSlice({ runId: run.id, sliceNo: mem.state.run.sliceNo }, { id: mem.currentJob().id, deadline: Date.now() + 15 * 60_000 }, deps)
  const reviews = () => model.prompts.filter((p) => p.system === REVIEW_INSTRUCTIONS)
  const labels = () => mem.state.steps.map((s) => s.label)
  return { mem, model, deps, slice, reviews, labels, renderPreview }
}

const readFiles = { calls: [call('read_file', { path: 'views/professor.tsx' })] }

describe('the design review', () => {
  it('reviews a passing draft once, with its screenshots, and commits it with its sample data', async () => {
    const h = harness([readFiles, { calls: [tweak(1), sample(), call('run_checks')] }, { calls: [finish()] }, ready])
    await h.slice()
    expect(h.mem.state.run.status).toBe('preview_ready')
    expect(h.reviews()).toHaveLength(1)
    // The review saw both screenshots, labelled, and only the review tool.
    const review = h.reviews()[0]
    expect(review.images?.map((i) => i.label)).toEqual(['Professor view, desktop', 'Student view, phone'])
    expect(review.tools.map((t) => t.name)).toEqual(['submit_review'])
    expect(h.labels()).toEqual(expect.arrayContaining(['sample.written', 'preview.rendered', 'review.ready', 'run.finishing']))
    const [, snapshot] = [...h.mem.state.snapshots.entries()][0]
    expect(snapshot.sample_data).toEqual(SAMPLE)
    expect((h.mem.state.run.result as { review: { rounds: number; rendered: boolean } }).review).toMatchObject({ rounds: 1, rendered: true })
  })

  it('sends an improve verdict back to the builder as fenced data, then reviews the changed draft again', async () => {
    const h = harness([
      readFiles,
      { calls: [tweak(1), call('run_checks')] },
      { calls: [finish()] },
      improve(),
      { calls: [tweak(2), call('run_checks')] },
      { calls: [finish()] },
      ready,
    ])
    await h.slice()
    expect(h.mem.state.run.status).toBe('preview_ready')
    expect(h.reviews()).toHaveLength(2)
    // The turn after the review reads its findings, inside a data block, in the improving phase.
    const after = h.model.prompts[4].prompt
    expect(after).toMatch(/# Design review/)
    expect(after).toMatch(/<data_[a-z0-9]+ kind="review" provenance="check-output">[\s\S]*add a StatCard with the number of cards/)
    expect(after).toMatch(/Phase: improving\./)
    expect(h.labels()).toContain('review.changes')
    expect(h.labels()).toContain('improve.round')
  })

  it(`stops reviewing after ${STUDIO_BUILDER_MAX_REVIEW_ROUNDS} rounds and commits the improved draft`, async () => {
    const h = harness([
      readFiles,
      { calls: [tweak(1), call('run_checks')] },
      { calls: [finish()] },
      improve(),
      { calls: [tweak(2), call('run_checks')] },
      { calls: [finish()] },
      improve('Student phone: the button label wraps; shorten it to Flip.'),
      { calls: [call('edit_file', { path: 'views/professor.tsx', old_text: 'Add one card', new_text: 'New card' }), call('run_checks')] },
      { calls: [finish()] },
    ])
    await h.slice()
    expect(h.mem.state.run.status).toBe('preview_ready')
    expect(h.reviews()).toHaveLength(STUDIO_BUILDER_MAX_REVIEW_ROUNDS)
    expect(String((h.mem.state.snapshots.values().next().value!.files as Record<string, string>)['views/professor.tsx'])).toContain('New card')
  })

  it('reviews from the code alone when the render fails, and says so', async () => {
    const h = harness([readFiles, { calls: [tweak(1), call('run_checks')] }, { calls: [finish()] }, ready], { render: async () => ({ ok: false, reason: 'failed' }) })
    await h.slice()
    expect(h.mem.state.run.status).toBe('preview_ready')
    expect(h.reviews()[0].images).toEqual([])
    expect(h.reviews()[0].prompt).toMatch(/None this time: review from the code only/)
    expect(h.mem.state.steps.find((s) => s.label === 'preview.rendered')?.resultSummary).toMatchObject({ images: 0, renderer: 'failed' })
  })

  it('a renderer that throws is a failed render, not a failed build', async () => {
    const h = harness([readFiles, { calls: [tweak(1), call('run_checks')] }, { calls: [finish()] }, ready], {
      render: async () => {
        throw new Error('chromium crashed')
      },
    })
    await h.slice()
    expect(h.mem.state.run.status).toBe('preview_ready')
  })

  it('sends at most the image cap, and never an oversized screenshot', async () => {
    const h = harness([readFiles, { calls: [tweak(1), call('run_checks')] }, { calls: [finish()] }, ready], {
      render: async () => ({
        ok: true,
        images: [jpeg('a'), jpeg('huge', STUDIO_BUILDER_REVIEW_IMAGE_MAX_BYTES + 1), jpeg('b'), jpeg('c'), jpeg('d'), jpeg('e')],
        failures: [],
      }),
    })
    await h.slice()
    expect(h.reviews()[0].images?.map((i) => i.label)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('commits unreviewed when the review model is unavailable', async () => {
    const h = harness([readFiles, { calls: [tweak(1), call('run_checks')] }, { calls: [finish()] }, { unavailable: true }])
    await h.slice()
    expect(h.mem.state.run.status).toBe('preview_ready')
    expect(h.mem.state.steps.find((s) => s.label === 'review.skipped')?.resultSummary).toMatchObject({ reason: 'model_unavailable' })
    // The failed call is still charged at the worst case.
    expect(h.mem.state.run.counters.costUsd).toBeGreaterThanOrEqual(WORST_CASE_CALL_USD)
  })

  it('commits unreviewed when the review returns no verdict', async () => {
    const h = harness([readFiles, { calls: [tweak(1), call('run_checks')] }, { calls: [finish()] }, { calls: [call('finish', {})] }])
    await h.slice()
    expect(h.mem.state.run.status).toBe('preview_ready')
    expect(h.mem.state.steps.find((s) => s.label === 'review.skipped')?.resultSummary).toMatchObject({ reason: 'no_review' })
  })

  it('skips the review, without a model call, when the run can’t afford it and one more turn', async () => {
    const h = harness([readFiles, { calls: [tweak(1), call('run_checks')] }, { calls: [finish()] }], { costUsd: STUDIO_BUILDER_RUN_MAX_COST_USD - 1.5 * WORST_CASE_CALL_USD })
    await h.slice()
    expect(h.mem.state.run.status).toBe('preview_ready')
    expect(h.reviews()).toHaveLength(0)
    expect(h.renderPreview).not.toHaveBeenCalled()
    expect(h.mem.state.steps.find((s) => s.label === 'review.skipped')?.resultSummary).toMatchObject({ reason: 'budget' })
  })

  it('Stop during the review ends the run cancelled, with nothing committed', async () => {
    const h = harness([readFiles, { calls: [tweak(1), call('run_checks')] }, { calls: [finish()] }, { hang: true }])
    const done = h.slice()
    await vi.waitFor(() => expect(h.reviews()).toHaveLength(1))
    h.mem.state.run.cancelRequested = true
    await done
    expect(h.mem.state.run.status).toBe('cancelled')
    expect(h.mem.state.snapshots.size).toBe(0)
  })

  it('a view that crashes when rendered goes back to the builder without a model call, and is never committed', async () => {
    const crashing = async (): Promise<RenderOutcome> => ({ ok: true, images: [jpeg('student-desktop')], failures: [{ label: 'professor-desktop', reason: 'crashed' }] })
    const h = harness(
      [
        readFiles,
        { calls: [tweak(1), call('run_checks')] },
        { calls: [finish()] },
        // Back in the builder with the crash as a finding, twice more; then the crash survives the last round.
        { calls: [tweak(2), call('run_checks')] },
        { calls: [finish()] },
        { calls: [call('edit_file', { path: 'views/professor.tsx', old_text: 'Add one card', new_text: 'New card' }), call('run_checks')] },
        { calls: [finish()] },
      ],
      { render: crashing },
    )
    await h.slice()
    // The review model was never called: a crash is a finding on its own.
    expect(h.reviews()).toHaveLength(0)
    expect(h.model.prompts[3].prompt).toMatch(/professor view crashed or didn’t start[\s\S]*hook/)
    expect(h.mem.state.run.status).toBe('blocked')
    expect(h.mem.state.snapshots.size).toBe(0)
  })

  it('does not review a build that changed nothing', async () => {
    const h = harness([{ calls: [finish()] }])
    await h.slice()
    expect(h.mem.state.run.status).toBe('completed')
    expect(h.reviews()).toHaveLength(0)
  })
})

describe('sample data', () => {
  it('refuses records that don’t match their collection, naming positions, never values', async () => {
    const h = harness([
      { calls: [sample({ cards: [{ data: { term: 'x' } }], progress: [{ data: { cardId: 'a', known: true } }], nope: [] })] },
      { calls: [finish('blocked', 'Stopping.')] },
    ])
    await h.slice()
    const refused = h.mem.state.steps.find((s) => s.resultSummary.reason === 'sample_invalid')
    const issues = (refused?.resultSummary.issues as string[]).join('\n')
    expect(issues).toMatch(/nope: not a collection/)
    expect(issues).toMatch(/cards\[0\]/)
    expect(issues).toMatch(/progress\[0\]: perStudent records need "student"/)
  })

  it('checks sample text like code: a student’s full name fails the draft gate', async () => {
    const h = harness([
      { calls: [sample({ cards: [{ data: { term: 'Maria Lopez', definition: 'x' } }], progress: [] }), call('run_checks')] },
      { calls: [finish('blocked', 'Stopping.')] },
    ])
    await h.slice()
    const check = h.mem.state.steps.find((s) => s.label === 'check.failed')
    expect(JSON.stringify(check?.resultSummary.failing)).toContain('builder.roster|sample')
  })
})

describe('plan v2', () => {
  it('reads a plan saved before plan v2 with empty lists, and refuses requirements that aren’t checkable', () => {
    const legacy = { goal: 'g', files_to_change: ['views/student.tsx'], manifest_changes: [], capabilities_needed: [], checks: [] }
    expect(readPlan(legacy)?.requirements).toEqual([])
    expect(readPlan({ ...legacy, professor_view: [], student_view: [], data: [], requirements: ['Make it nice', 'Looks good'], enhancements: [] })).toBeNull()
  })
})
