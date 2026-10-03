/**
 * One-step undo and the draft history, through the builder service. The undo itself runs
 * on the in-memory store, which mirrors studio_builder_end and studio_builder_undo
 * (helpers/builder-memory-store.ts); the SQL runs against Postgres in
 * src/__tests__/db/studio-builder.test.ts.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStore, newRun, type MemoryProject } from './helpers/builder-memory-store'

vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/jobs/enqueue', () => ({ kickWorker: vi.fn(async () => ({ kicked: true })) }))
vi.mock('@/lib/ai/kill-switch', () => ({ checkAiFeature: vi.fn(async () => ({ allowed: true })) }))
vi.mock('@/lib/studio/access', () => ({ studioAccess: vi.fn(async () => 'full'), studioKillSwitchEngaged: vi.fn(async () => false), STUDIO_PAUSED: 'Studio is paused right now. Try again later.' }))
vi.mock('@/lib/studio/context', () => ({ requireProfessor: vi.fn(), sessionUserId: vi.fn() }))
vi.mock('@/lib/studio/db', () => ({
  builderRpcs: { undo: vi.fn() },
  loadBuilderProject: vi.fn(),
  listDraftHistory: vi.fn(),
  insertVersion: vi.fn(),
}))
vi.mock('@/lib/studio/validator/service', () => ({ validateAfterPublish: vi.fn(), currentVerdict: vi.fn() }))

const db = await import('@/lib/studio/db')
const { requireProfessor } = await import('@/lib/studio/context')
const { studioAccess } = await import('@/lib/studio/access')
const { logEvent } = await import('@/lib/supabase/event-logger')
const service = await import('@/lib/studio/builder/service')

const SECTION = randomUUID()
const PROFESSOR = { userId: randomUUID(), sectionId: SECTION, institutionId: randomUUID() }
const PROJECT = randomUUID()
const DENIED = { ok: false, error: 'This isn’t available.' }
const hash = () => randomBytes(32).toString('hex')

let shared: { project: MemoryProject; snapshots: Map<string, Record<string, unknown>> }
let latest: ReturnType<typeof createMemoryStore> | null
let owner: string

/** One build of the project that commits `h`, through the store's own claim and end. */
async function build(h: string) {
  const run = newRun({ projectId: PROJECT, ownerId: PROFESSOR.userId, institutionId: PROFESSOR.institutionId, baseHash: shared.project.draftHeadHash, baseRev: shared.project.draftRev })
  const mem = createMemoryStore(run, undefined, shared)
  const token = await mem.store.claim(run.id, mem.currentJob().id, 1)
  if (!token) throw new Error('claim')
  expect(await mem.store.end({ runId: run.id, token, status: 'preview_ready', errorCode: null, result: { status: 'preview_ready' }, snapshot: { hash: h }, activeMs: 0 })).toEqual({ outcome: 'ended' })
  latest = mem
  return mem
}

const undo = (expectedHead: string, expectedRev: number) =>
  service.undoDraft({ sectionId: SECTION, pluginProjectId: PROJECT, expectedHead, expectedRev })

beforeEach(() => {
  vi.clearAllMocks()
  shared = { project: { id: PROJECT, draftHeadHash: null, draftRev: 0, draftUndoHash: null }, snapshots: new Map() }
  latest = null
  owner = PROFESSOR.userId
  vi.mocked(requireProfessor).mockResolvedValue(PROFESSOR as never)
  vi.mocked(studioAccess).mockResolvedValue('full')
  vi.mocked(db.loadBuilderProject).mockImplementation(async () => ({
    id: PROJECT, institutionId: PROFESSOR.institutionId, ownerId: owner, slug: 'tool-abc12345', name: 'Cards', status: 'active',
    draftHeadHash: shared.project.draftHeadHash, draftRev: shared.project.draftRev, draftUndoHash: shared.project.draftUndoHash, updatedAt: '', materialSources: [], materialIncomplete: false,
  }))
  vi.mocked(db.builderRpcs.undo).mockImplementation(async (_p, _a, head, rev) => latest!.professor.undo(head, rev))
})

describe('undo', () => {
  it('isn’t available after the first build: there is nothing before it', async () => {
    const a = hash()
    await build(a)
    expect(await undo(a, 1)).toEqual({ ok: false, error: 'There’s no earlier draft to go back to.' })
    expect(shared.project).toMatchObject({ draftHeadHash: a, draftRev: 1 })
  })

  it('goes back one build, keeps every snapshot, and is spent until the next build', async () => {
    const [a, b, c] = [hash(), hash(), hash()]
    await build(a)
    await build(b)
    expect(shared.project).toMatchObject({ draftHeadHash: b, draftUndoHash: a, draftRev: 2 })
    expect(await undo(b, 2)).toEqual({ ok: true, value: { headHash: a, rev: 3 } })
    expect(shared.project).toMatchObject({ draftHeadHash: a, draftUndoHash: null, draftRev: 3 })
    expect([...shared.snapshots.keys()].sort()).toEqual([a, b].sort())
    expect(db.insertVersion).not.toHaveBeenCalled()
    // One step only.
    expect((await undo(a, 3)).ok).toBe(false)
    // The next build can be undone again, back to the draft it started from.
    await build(c)
    expect((await undo(c, 4)).ok).toBe(true)
    expect(shared.project.draftHeadHash).toBe(a)
  })

  it('names the draft it expects: a stale head or revision changes nothing', async () => {
    const [a, b] = [hash(), hash()]
    await build(a)
    await build(b)
    const changed = { ok: false, error: 'This draft changed since you opened it. Look at the latest draft, then try again.' }
    expect(await undo(a, 2)).toEqual(changed)
    expect(await undo(b, 1)).toEqual(changed)
    expect(shared.project).toMatchObject({ draftHeadHash: b, draftUndoHash: a, draftRev: 2 })
  })

  it('refuses while a run of the project is active, and changes nothing', async () => {
    const [a, b] = [hash(), hash()]
    await build(a)
    await build(b)
    latest = createMemoryStore(newRun({ projectId: PROJECT, status: 'queued', baseHash: b, baseRev: 2 }), undefined, shared)
    expect(await undo(b, 2)).toEqual({ ok: false, error: 'Athena is still working on this tool. Wait for it to finish, or stop it, then undo.' })
    expect(shared.project).toMatchObject({ draftHeadHash: b, draftRev: 2 })
  })

  it('is the owner’s alone: a TA, another professor and no session get the same refusal', async () => {
    const [a, b] = [hash(), hash()]
    await build(a)
    await build(b)
    vi.mocked(requireProfessor).mockResolvedValueOnce(null)
    expect(await undo(b, 2)).toEqual(DENIED)
    owner = randomUUID()
    expect(await undo(b, 2)).toEqual(DENIED)
    expect(db.builderRpcs.undo).not.toHaveBeenCalled()
    expect(shared.project.draftHeadHash).toBe(b)
  })

  it('refuses while Studio is paused or the school isn’t entitled', async () => {
    vi.mocked(studioAccess).mockResolvedValueOnce('off').mockResolvedValueOnce('read_only')
    expect((await undo(hash(), 2)).ok).toBe(false)
    expect((await undo(hash(), 2)).ok).toBe(false)
    expect(db.builderRpcs.undo).not.toHaveBeenCalled()
  })

  it('is audited with the project and both short hashes, and no content', async () => {
    const [a, b] = [hash(), hash()]
    await build(a)
    await build(b)
    await undo(b, 2)
    expect(logEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logEvent).mock.calls[0][0]).toMatchObject({
      userId: PROFESSOR.userId,
      eventType: 'studio.draft.undone',
      metadata: { projectId: PROJECT, fromHash: b.slice(0, 16), toHash: a.slice(0, 16) },
    })
    expect(Object.keys(vi.mocked(logEvent).mock.calls[0][0].metadata ?? {}).sort()).toEqual(['fromHash', 'projectId', 'toHash'])
  })
})

describe('draft history', () => {
  const read = () => service.listDraftHistory({ sectionId: SECTION, pluginProjectId: PROJECT })

  it('marks the current draft, the undo target and saved versions, and shortens the request', async () => {
    const [a, b, c] = [hash(), hash(), hash()]
    shared.project = { id: PROJECT, draftHeadHash: b, draftUndoHash: a, draftRev: 4 }
    const long = 'Make flashcards for the cell biology unit, with a shuffle button and a score at the end, and let me see which cards students miss most often each week.'
    vi.mocked(db.listDraftHistory).mockResolvedValue([
      { runId: 'r3', request: 'Add a timer', hash: c, snapshotCreatedAt: '2026-10-02T10:00:00Z', savedVersion: null },
      { runId: 'r2', request: long, hash: b, snapshotCreatedAt: '2026-10-02T09:00:00Z', savedVersion: '1.1.0' },
      { runId: 'r1', request: 'Flashcards', hash: a, snapshotCreatedAt: '2026-10-02T08:00:00Z', savedVersion: '1.0.0' },
    ])
    const h = await read()
    expect(h).not.toBeNull()
    expect(h!.head).toEqual({ hash: b, rev: 4 })
    expect(h!.canUndo).toBe(true)
    expect(h!.entries.map((e) => [e.runId, e.current, e.undoTarget, e.savedVersion])).toEqual([
      ['r3', false, false, null],
      ['r2', true, false, '1.1.0'],
      ['r1', false, true, '1.0.0'],
    ])
    expect(h!.entries[1].request!.length).toBeLessThanOrEqual(120)
    expect(long.startsWith(h!.entries[1].request!.slice(0, -1))).toBe(true)
    // Only these fields: never source, manifest, bundles, plan, summaries or check details.
    for (const e of h!.entries) expect(Object.keys(e).sort()).toEqual(['createdAt', 'current', 'hash', 'request', 'runId', 'savedVersion', 'undoTarget'])
    expect(db.listDraftHistory).toHaveBeenCalledWith(PROJECT, 20)
  })

  it('says when there is nothing to undo', async () => {
    shared.project = { id: PROJECT, draftHeadHash: hash(), draftUndoHash: null, draftRev: 1 }
    vi.mocked(db.listDraftHistory).mockResolvedValue([])
    expect((await read())!.canUndo).toBe(false)
  })

  it('is the owner’s alone', async () => {
    vi.mocked(requireProfessor).mockResolvedValueOnce(null)
    expect(await read()).toBeNull()
    owner = randomUUID()
    expect(await read()).toBeNull()
    expect(db.listDraftHistory).not.toHaveBeenCalled()
  })
})
