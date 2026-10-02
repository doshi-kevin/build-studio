/**
 * The builder's trusted entry points: who may call them, which ids they trust (none),
 * what they refuse, and what they never do. The database functions are mocked here;
 * their own rules run against Postgres in src/__tests__/db/studio-builder.test.ts.
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/jobs/enqueue', () => ({ kickWorker: vi.fn(async () => ({ kicked: true })) }))
vi.mock('@/lib/ai/kill-switch', () => ({ checkAiFeature: vi.fn(async () => ({ allowed: true })) }))
vi.mock('@/lib/studio/access', () => ({ studioAccess: vi.fn(async () => 'full'), studioKillSwitchEngaged: vi.fn(async () => false), STUDIO_PAUSED: 'Studio is paused right now. Try again later.' }))
vi.mock('@/lib/studio/context', () => ({ requireProfessor: vi.fn(), sessionUserId: vi.fn() }))
vi.mock('@/lib/studio/db', () => ({
  builderRpcs: { start: vi.fn(), stop: vi.fn(), decide: vi.fn(), answer: vi.fn(), undo: vi.fn(), tend: vi.fn(async () => ({ outcome: 'none' })) },
  loadBuilderRun: vi.fn(),
  listBuilderSteps: vi.fn(async () => []),
  loadBuilderProject: vi.fn(),
  loadSnapshot: vi.fn(),
  loadSnapshotBundle: vi.fn(),
  loadVersionForSnapshot: vi.fn(async () => null),
  loadLatestProjectManifest: vi.fn(async () => null),
  loadOwnerRosterFullNames: vi.fn(async () => []),
  insertVersion: vi.fn(async () => ({ ok: true, value: 'version-1' })),
  installPlugin: vi.fn(),
  activateVersion: vi.fn(),
  setStudentVisibility: vi.fn(),
  listOwnedProjects: vi.fn(async () => []),
  listLatestRuns: vi.fn(async () => new Map()),
  loadDraftHeads: vi.fn(async () => new Map()),
  listProjectRuns: vi.fn(async () => []),
}))
vi.mock('@/lib/studio/validator/service', () => ({ validateAfterPublish: vi.fn(), currentVerdict: vi.fn() }))

const db = await import('@/lib/studio/db')
const { requireProfessor, sessionUserId } = await import('@/lib/studio/context')
const { studioAccess, studioKillSwitchEngaged } = await import('@/lib/studio/access')
const { checkAiFeature } = await import('@/lib/ai/kill-switch')
const service = await import('@/lib/studio/builder/service')
const { publishDraft } = await import('@/lib/studio/lifecycle')
const ticket = await import('@/lib/studio/runtime/frame-ticket')
const { draftFrameResponse } = await import('@/lib/studio/runtime/frame')
const { proposeManifest } = await import('@/lib/studio/builder/manifest-delta')
const { snapshotHash } = await import('@/lib/studio/builder/snapshot')
const { COMPILER_ID } = await import('@/lib/studio/builder/compile')
const { FLASHCARDS_MANIFEST, PROFESSOR_VIEW, STUDENT_VIEW } = await import('./helpers/builder-fixtures')

const SECTION = crypto.randomUUID()
const PROFESSOR = { userId: crypto.randomUUID(), sectionId: SECTION, institutionId: crypto.randomUUID() }
const PROJECT = crypto.randomUUID()
const RUN = crypto.randomUUID()
const project = { id: PROJECT, institutionId: PROFESSOR.institutionId, ownerId: PROFESSOR.userId, slug: 'tool-abc12345', name: 'Untitled tool', status: 'active', draftHeadHash: null as string | null, draftRev: 0, updatedAt: '' }
const run = (over: Record<string, unknown> = {}) => ({
  id: RUN, projectId: PROJECT, institutionId: PROFESSOR.institutionId, ownerId: PROFESSOR.userId, sectionId: SECTION, request: 'x', status: 'running',
  phase: 'editing', errorCode: null, plan: null, work: null, pendingApproval: null, questions: [], waitingUntil: null, result: null, baseHash: null, baseRev: 0, resultHash: null,
  counters: { modelTurns: 1, toolCalls: 1, writes: 0, bytesWritten: 0, repairRounds: 0, checkRuns: 0, consecutiveErrors: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, activeMs: 0 },
  sliceNo: 1, resumeCount: 0, cancelRequested: false, createdAt: '', endedAt: null, ...over,
})
const DENIED = { ok: false, error: 'This isn’t available.' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireProfessor).mockResolvedValue(PROFESSOR as never)
  vi.mocked(sessionUserId).mockResolvedValue(PROFESSOR.userId)
  vi.mocked(studioAccess).mockResolvedValue('full')
  vi.mocked(studioKillSwitchEngaged).mockResolvedValue(false)
  vi.mocked(checkAiFeature).mockResolvedValue({ allowed: true })
  vi.mocked(db.loadBuilderRun).mockResolvedValue(run() as never)
  vi.mocked(db.loadBuilderProject).mockResolvedValue({ ...project } as never)
})

describe('who may call the builder', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['start', () => service.startBuild({ sectionId: SECTION, pluginProjectId: null, request: 'Flashcards', clientRequestId: crypto.randomUUID() })],
    ['stop', () => service.stopBuild({ sectionId: SECTION, runId: RUN })],
    ['decide', () => service.decideApproval({ sectionId: SECTION, runId: RUN, proposalId: crypto.randomUUID(), deltaHash: 'a'.repeat(64), approve: true })],
    ['answer', () => service.answerQuestion({ sectionId: SECTION, runId: RUN, questionId: crypto.randomUUID(), answer: 'Yes' })],
    ['preview', () => service.issueDraftPreview({ sectionId: SECTION, pluginProjectId: PROJECT, snapshotHash: 'a'.repeat(64), view: 'student' })],
    ['undo', () => service.undoDraft({ sectionId: SECTION, pluginProjectId: PROJECT, expectedHead: 'a'.repeat(64), expectedRev: 2 })],
  ]
  it.each(calls)('%s: refused for anyone who isn’t the section’s professor (a TA, a student, no session)', async (_name, fn) => {
    vi.mocked(requireProfessor).mockResolvedValue(null)
    expect(await fn()).toEqual(DENIED)
    for (const rpc of Object.values(db.builderRpcs)) expect(rpc).not.toHaveBeenCalled()
  })
  it.each(calls.slice(1, 4))('%s: refused on another professor’s run, with the same answer as a missing one', async (_name, fn) => {
    vi.mocked(db.loadBuilderRun).mockResolvedValue(run({ ownerId: crypto.randomUUID() }) as never)
    expect(await fn()).toEqual(DENIED)
    for (const rpc of Object.values(db.builderRpcs)) expect(rpc).not.toHaveBeenCalled()
  })
  it('progress is the owner’s alone: a TA of the section gets nothing', async () => {
    vi.mocked(sessionUserId).mockResolvedValue(crypto.randomUUID())
    expect(await service.readProgress(RUN, 0)).toBeNull()
    expect(db.listBuilderSteps).not.toHaveBeenCalled()
  })
  it('progress lines are fixed copy: no tool names, check ids, paths or reasoning', async () => {
    vi.mocked(db.listBuilderSteps).mockResolvedValue([
      { seq: 1, kind: 'model_turn', tool: null, toolCallId: 't', status: 'done', label: 'turn.understanding', argsSummary: {}, resultSummary: { model: 'gemini' }, ms: 1 },
      { seq: 2, kind: 'tool', tool: 'edit_file', toolCallId: '1.0', status: 'done', label: 'file.edited', argsSummary: { path: 'views/student.tsx' }, resultSummary: {}, ms: 1 },
      { seq: 3, kind: 'tool', tool: 'write_file', toolCallId: '1.1', status: 'refused', label: 'step.refused', argsSummary: {}, resultSummary: { reason: 'invalid_args' }, ms: 1 },
      { seq: 4, kind: 'tool', tool: 'x', toolCallId: '1.2', status: 'done', label: 'made.up', argsSummary: {}, resultSummary: {}, ms: 1 },
    ] as never)
    const p = await service.readProgress(RUN, 0)
    expect(p!.events.map((e) => e.label)).toEqual(['Understanding your request', 'Editing the student view', 'That step didn’t work, so I’m trying another way'])
    expect(JSON.stringify(p)).not.toMatch(/edit_file|invalid_args|views\/student\.tsx|gemini/)
  })
})

describe('starting a build', () => {
  it('derives owner, school and course from the session, and names the project itself', async () => {
    vi.mocked(db.builderRpcs.start).mockResolvedValue({ outcome: 'started', run_id: RUN, project_id: PROJECT, job_id: crypto.randomUUID() })
    const r = await service.startBuild({ sectionId: SECTION, pluginProjectId: null, request: 'Flashcards', clientRequestId: crypto.randomUUID() })
    expect(r.ok).toBe(true)
    const args = vi.mocked(db.builderRpcs.start).mock.calls[0][0]
    expect(args).toMatchObject({ ownerId: PROFESSOR.userId, institutionId: PROFESSOR.institutionId, sectionId: SECTION, maxDailyRuns: 15, maxLiveRuns: 3, maxDailyCost: 100 })
    expect(args.newSlug).toMatch(/^tool-[0-9a-f]{8}$/)
  })
  it('refuses a request that names extra fields', async () => {
    const r = await service.startBuild({ sectionId: SECTION, pluginProjectId: null, request: 'x', clientRequestId: crypto.randomUUID(), ownerId: 'someone' } as never)
    expect(r.ok).toBe(false)
    expect(db.builderRpcs.start).not.toHaveBeenCalled()
  })
  it('refuses while Studio is paused, without the entitlement, or with the builder switched off', async () => {
    vi.mocked(studioAccess).mockResolvedValueOnce('off')
    expect((await service.startBuild({ sectionId: SECTION, pluginProjectId: null, request: 'x', clientRequestId: crypto.randomUUID() })).ok).toBe(false)
    vi.mocked(studioAccess).mockResolvedValueOnce('read_only')
    expect((await service.startBuild({ sectionId: SECTION, pluginProjectId: null, request: 'x', clientRequestId: crypto.randomUUID() })).ok).toBe(false)
    vi.mocked(checkAiFeature).mockResolvedValueOnce({ allowed: false, lockedBy: 'institution' })
    expect((await service.startBuild({ sectionId: SECTION, pluginProjectId: null, request: 'x', clientRequestId: crypto.randomUUID() })).ok).toBe(false)
    expect(db.builderRpcs.start).not.toHaveBeenCalled()
  })
  it('a request while a run waits for the professor is a conflict until they confirm replacing it', async () => {
    const waiting = crypto.randomUUID()
    vi.mocked(db.builderRpcs.start).mockResolvedValueOnce({ outcome: 'waiting', run_id: waiting, status: 'waiting_for_approval' })
    const r = await service.startBuild({ sectionId: SECTION, pluginProjectId: PROJECT, request: 'x', clientRequestId: crypto.randomUUID() })
    expect(r).toMatchObject({ ok: false, conflict: { kind: 'waiting', runId: waiting } })
    vi.mocked(db.builderRpcs.start).mockResolvedValueOnce({ outcome: 'started', run_id: RUN, project_id: PROJECT })
    await service.startBuild({ sectionId: SECTION, pluginProjectId: PROJECT, request: 'x', clientRequestId: crypto.randomUUID(), replaceRunId: waiting })
    expect(vi.mocked(db.builderRpcs.start).mock.calls[1][0].replaceRunId).toBe(waiting)
  })
})

describe('ending copy', () => {
  it('a blocked run points at Athena’s note only when there is one', () => {
    expect(service.endingCopy('blocked', 'agent_blocked', true)).toMatch(/My note below/)
    expect(service.endingCopy('blocked', 'agent_blocked', false)).toBe('I couldn’t do this one. Try describing the change differently, or ask for something smaller.')
  })
})

describe('draft preview', () => {
  const SECRET = 'x'.repeat(40)
  beforeEach(() => {
    vi.stubEnv('STUDIO_FRAME_TICKET_SECRET', SECRET)
    vi.stubEnv('STUDIO_RUNTIME_ORIGIN', 'http://runtime.test:3001')
    vi.stubEnv('SITE_URL', 'http://app.test:3000')
  })
  const hash = 'a'.repeat(64)

  it('draft and installation tickets never verify as each other', () => {
    const draft = ticket.signDraftFrameTicket({ projectId: PROJECT, hash, view: 'student', expiresAt: Date.now() + 60_000 }, SECRET)
    const installed = ticket.signFrameTicket({ installationId: PROJECT, versionId: PROJECT, view: 'student', expiresAt: Date.now() + 60_000 }, SECRET)
    expect(ticket.verifyDraftFrameTicket(draft, SECRET)).toMatchObject({ projectId: PROJECT, hash })
    expect(ticket.verifyFrameTicket(draft, SECRET)).toBeNull()
    expect(ticket.verifyDraftFrameTicket(installed, SECRET)).toBeNull()
    expect(ticket.verifyDraftFrameTicket(ticket.signDraftFrameTicket({ projectId: PROJECT, hash, view: 'student', expiresAt: Date.now() - 1 }, SECRET), SECRET)).toBeNull()
  })
  it('the frame route serves only the ticket’s own project, view and snapshot, and nothing while paused', async () => {
    vi.mocked(db.loadSnapshotBundle).mockResolvedValue({ code: "'use strict';(function(){})()", name: 'Cards' })
    const t = ticket.signDraftFrameTicket({ projectId: PROJECT, hash, view: 'student', expiresAt: Date.now() + 60_000 }, SECRET)
    expect((await draftFrameResponse('runtime.test:3001', PROJECT, 'student', t)).status).toBe(200)
    expect((await draftFrameResponse('runtime.test:3001', crypto.randomUUID(), 'student', t)).status).toBe(404)
    expect((await draftFrameResponse('runtime.test:3001', PROJECT, 'professor', t)).status).toBe(404)
    expect((await draftFrameResponse('app.test:3000', PROJECT, 'student', t)).status).toBe(404)
    vi.mocked(studioKillSwitchEngaged).mockResolvedValueOnce(true)
    expect((await draftFrameResponse('runtime.test:3001', PROJECT, 'student', t)).status).toBe(404)
    expect(vi.mocked(db.loadSnapshotBundle).mock.calls.every(([p, h]) => p === PROJECT && h === hash)).toBe(true)
  })
  it('a professor can only preview a snapshot of their own project', async () => {
    vi.mocked(db.loadBuilderProject).mockResolvedValue({ ...project, ownerId: crypto.randomUUID() } as never)
    expect(await service.issueDraftPreview({ sectionId: SECTION, pluginProjectId: PROJECT, snapshotHash: hash, view: 'student' })).toEqual(DENIED)
    expect(db.loadSnapshot).not.toHaveBeenCalled()
  })
})

describe('save as version (a professor action, never the builder’s)', () => {
  const m = proposeManifest(JSON.stringify(FLASHCARDS_MANIFEST), { slug: 'tool-abc12345', current: null, published: null })
  if (!m.ok) throw new Error('fixture')
  const files = { 'views/student.tsx': STUDENT_VIEW, 'views/professor.tsx': PROFESSOR_VIEW }
  const hash = snapshotHash(COMPILER_ID, m.manifest, files)
  const snapshot = { projectId: PROJECT, hash, compiler: COMPILER_ID, manifest: m.manifest, files, studentBundle: 's', professorBundle: 'p', checkSummary: {} }

  beforeEach(() => {
    vi.mocked(db.loadBuilderProject).mockResolvedValue({ ...project, draftHeadHash: hash } as never)
    vi.mocked(db.loadSnapshot).mockResolvedValue(snapshot as never)
  })

  it('saves the exact current snapshot as 1.0.0, recording where it came from, and installs nothing', async () => {
    const r = await publishDraft({ sectionId: SECTION, projectId: PROJECT, snapshotHash: hash })
    expect(r).toEqual({ ok: true, value: { versionId: 'version-1', version: '1.0.0' } })
    const row = vi.mocked(db.insertVersion).mock.calls[0][0]
    expect(row).toMatchObject({ sourceSnapshotHash: hash, version: '1.0.0', publishedBy: PROFESSOR.userId })
    expect(Object.keys(row.source as object).sort()).toEqual(['plugin.manifest.json', 'views/professor.tsx', 'views/student.tsx'])
    // Rebuilt by the trusted compiler: never the stored bundles.
    expect(row.studentBundle).toContain('ScholeraKit.render')
    expect(db.installPlugin).not.toHaveBeenCalled()
    expect(db.activateVersion).not.toHaveBeenCalled()
    expect(db.setStudentVisibility).not.toHaveBeenCalled()
  })
  it('refuses a snapshot that is no longer the draft', async () => {
    const r = await publishDraft({ sectionId: SECTION, projectId: PROJECT, snapshotHash: 'c'.repeat(64) })
    expect(r.ok).toBe(false)
    expect(db.insertVersion).not.toHaveBeenCalled()
  })
  it('refuses a draft already saved', async () => {
    vi.mocked(db.loadVersionForSnapshot).mockResolvedValueOnce({ id: 'v', version: '1.0.0' })
    expect((await publishDraft({ sectionId: SECTION, projectId: PROJECT, snapshotHash: hash })).ok).toBe(false)
  })
  it('refuses a stored snapshot whose content doesn’t match its hash', async () => {
    vi.mocked(db.loadSnapshot).mockResolvedValueOnce({ ...snapshot, files: { ...files, 'views/student.tsx': STUDENT_VIEW + '// changed' } } as never)
    expect((await publishDraft({ sectionId: SECTION, projectId: PROJECT, snapshotHash: hash })).ok).toBe(false)
    expect(db.insertVersion).not.toHaveBeenCalled()
  })
  it('re-runs the checks: a snapshot that fails them now is refused', async () => {
    vi.mocked(db.loadOwnerRosterFullNames).mockResolvedValueOnce(null)
    expect((await publishDraft({ sectionId: SECTION, projectId: PROJECT, snapshotHash: hash })).ok).toBe(false)
    expect(db.insertVersion).not.toHaveBeenCalled()
  })
  it('refuses another professor', async () => {
    vi.mocked(db.loadBuilderProject).mockResolvedValueOnce({ ...project, draftHeadHash: hash, ownerId: crypto.randomUUID() } as never)
    expect((await publishDraft({ sectionId: SECTION, projectId: PROJECT, snapshotHash: hash })).ok).toBe(false)
  })
})

describe('the builder can’t reach student visibility', () => {
  const BUILDER = ['harness', 'tools', 'context-builder', 'model', 'checks', 'manifest-delta', 'instructions', 'work', 'compile', 'typecheck', 'check-worker', 'check-worker-entry']
  it.each(BUILDER)('builder/%s imports no publication, installation, record or binding code', (name) => {
    const source = readFileSync(`src/lib/studio/builder/${name}.ts`, 'utf8')
    expect(source).not.toMatch(/from ['"](?:\.\.\/|@\/lib\/studio\/)(student-visibility|records|skill-bindings|lifecycle|publication|bridge\/registry|runtime\/frame-ticket)['"]/)
    expect(source).not.toMatch(/\b(publishVersion|publishDraft|installPlugin|approveAndActivateVersion|rollbackVersion|showToStudents|setStudentVisibility|bindSkillSlot)\b/)
  })
})

describe('the progress read’s ending reason', () => {
  it('an ended run carries its fixed error code, so the UI can tell a superseded run from a stopped one', async () => {
    vi.mocked(db.loadBuilderRun).mockResolvedValue(run({ status: 'cancelled', errorCode: 'superseded' }) as never)
    expect((await service.readProgress(RUN, 0))!.endingReason).toBe('superseded')
    vi.mocked(db.loadBuilderRun).mockResolvedValue(run({ status: 'cancelled', errorCode: null }) as never)
    expect((await service.readProgress(RUN, 0))!.endingReason).toBeNull()
  })

  it('an active run has no ending reason, even with an error code left on the row', async () => {
    vi.mocked(db.loadBuilderRun).mockResolvedValue(run({ status: 'running', errorCode: 'superseded' }) as never)
    const p = await service.readProgress(RUN, 0)
    expect(p!.ending).toBeNull()
    expect(p!.endingReason).toBeNull()
  })
})

describe('starting a build kicks the worker before answering', () => {
  it('the start resolves only once the kick has been sent (Cloud Run gives no CPU after the response)', async () => {
    const { kickWorker } = await import('@/lib/jobs/enqueue')
    let release: (v: { kicked: boolean }) => void = () => {}
    vi.mocked(kickWorker).mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    vi.mocked(db.builderRpcs.start).mockResolvedValue({ outcome: 'started', run_id: RUN, project_id: PROJECT, job_id: 'job-1' } as never)
    let settled = false
    const started = service
      .startBuild({ sectionId: SECTION, pluginProjectId: null, request: 'Flashcards', clientRequestId: crypto.randomUUID() })
      .then((r) => ((settled = true), r))
    await vi.waitFor(() => expect(kickWorker).toHaveBeenCalledWith('job-1'))
    // Drain the queue: a fire-and-forget kick would have let startBuild settle by now.
    await new Promise((r) => setImmediate(r))
    expect(settled).toBe(false)
    release({ kicked: true })
    expect(await started).toEqual({ ok: true, value: { runId: RUN, pluginProjectId: PROJECT } })
  })
})
