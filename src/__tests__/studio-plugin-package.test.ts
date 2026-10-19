// @vitest-environment node
/**
 * Plugin packages and the plugin server runtime: a multi-file package compiles, links and
 * hashes as one unit, views can't reach server code, and a plugin's server code runs only
 * through the executor, with no secrets, under the server policy, within its limits. The
 * executor is the real one: each call spawns a node child, as on a developer machine.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { compilePackage, compileView } from '@/lib/studio/builder/compile'
import { proposeManifest } from '@/lib/studio/builder/manifest-delta'
import { snapshotHash } from '@/lib/studio/builder/snapshot'
import { parseManifest, type StudioManifestV2 } from '@/lib/studio/manifest'
import { artifactHash, canonicalJson } from '@/lib/studio/validator/artifact'
import { runStaticChecks } from '@/lib/studio/validator/static-checks'
import { createPreviewBridge, type PreviewStore } from '@/lib/studio/runtime/preview-bridge'
import { CAPABILITY_PARAMS } from '@/lib/studio/server-runtime/contract'
import { executorMode } from '@/lib/studio/server-runtime/executor'
import { LocalProcessExecutor } from '@/lib/studio/server-runtime/local-executor'
import { previewServerCall } from '@/lib/studio/server-runtime/preview'
import { PROFESSOR_VIEW, STUDENT_VIEW } from './helpers/builder-fixtures'

const VIEWS = { 'views/student.tsx': STUDENT_VIEW, 'views/professor.tsx': PROFESSOR_VIEW }

// The executor runs only beside a loopback database.
const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
  process.env.STUDIO_PLUGIN_EXECUTOR = 'local'
})
afterAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl
  delete process.env.STUDIO_PLUGIN_EXECUTOR
})

const WORKSHEET_MANIFEST = {
  name: 'Quantitative worksheet',
  description: 'Each student answers their own set of numeric questions and sees what they got right after submitting.',
  views: { student: { capabilities: [] }, professor: { capabilities: [] } },
  collections: {
    questions: { access: 'staffOnly', fields: { prompt: 'text', answer: 'number', tolerance: 'number', explanation: 'text' } },
    attempts: { access: 'perStudent', writes: 'server', fields: { score: 'number', total: 'number' } },
  },
  purpose: { category: 'assessment', summary: 'Students answer numeric questions and see which they got right after they submit.', audience: 'both' },
  signals: [],
  skillSlots: [],
  aiFallback: 'not-applicable',
  server: {
    actions: {
      myWorksheet: { roles: ['student'], args: {}, reads: ['questions'] },
      submit: { roles: ['student'], args: { answers: 'json' }, reads: ['questions'] },
      myAttempts: { roles: ['student'], args: {} },
      classResults: { roles: ['professor'], args: {} },
    },
  },
}

const WORKSHEET_SERVER = `import type { ActionContext, ServerRecord } from '@scholera/plugin-server'
import { scoreAnswer } from './grading'

interface Question { prompt: string; answer: number; tolerance: number; explanation: string }

/** The student's own two questions: seeded by their handle, so a refresh gives the same set. */
async function mine(ctx: ActionContext): Promise<ServerRecord<Question>[]> {
  const bank = await ctx.records.listAll<Question>('questions')
  const next = ctx.random(ctx.user.handle ?? 'staff')
  const order = [...bank]
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const t = order[i]
    order[i] = order[j]
    order[j] = t
  }
  return order.slice(0, 2)
}

async function myWorksheet(ctx: ActionContext) {
  return { questions: (await mine(ctx)).map((q) => ({ id: q.id, prompt: q.data.prompt })) }
}

async function submit(ctx: ActionContext, args: { answers: Record<string, number> }) {
  const questions = await mine(ctx)
  const results = questions.map((q) => ({ id: q.id, right: scoreAnswer(args.answers[q.id], q.data.answer, q.data.tolerance), explanation: q.data.explanation }))
  const score = results.filter((r) => r.right).length
  await ctx.records.create('attempts', { score, total: results.length })
  return { score, total: results.length, results }
}

async function myAttempts(ctx: ActionContext) {
  return (await ctx.records.list('attempts')).length
}

async function classResults() {
  return 'staff only'
}

export const actions = { myWorksheet, submit, myAttempts, classResults }
`
const WORKSHEET_GRADING = `export function scoreAnswer(given: number | undefined, answer: number, tolerance: number): boolean {
  return typeof given === 'number' && Math.abs(given - answer) <= tolerance
}
`
const WORKSHEET_FILES = { ...VIEWS, 'server/index.ts': WORKSHEET_SERVER, 'server/grading.ts': WORKSHEET_GRADING }

function stamped(raw: unknown): StudioManifestV2 {
  const r = proposeManifest(JSON.stringify(raw), { slug: 'worksheet-abc12345', current: null, published: null })
  if (!r.ok) throw new Error(JSON.stringify(r))
  return r.manifest
}

function compiled(files: Record<string, string>) {
  const r = compilePackage(files)
  if (!r.ok || !r.bundles) throw new Error(JSON.stringify(r.diagnostics))
  return r.bundles
}

const at = '2026-10-01T00:00:00.000Z'
const record = (id: string, data: Record<string, unknown>, owner: number | null = null) => ({ id, data, owner, byViewer: false, createdAt: at, updatedAt: at })
const BANK: PreviewStore = {
  questions: [
    record('q1', { prompt: '2 + 2', answer: 4, tolerance: 0, explanation: 'Add.' }),
    record('q2', { prompt: 'pi to 2 places', answer: 3.14, tolerance: 0.005, explanation: 'Round.' }),
    record('q3', { prompt: '10 / 4', answer: 2.5, tolerance: 0, explanation: 'Divide.' }),
  ],
  // Another student's attempt (preview student 1): a student's call must never see it.
  attempts: [record('a-other', { score: 1, total: 2 }, 1)],
}

describe('plugin packages compile as one unit', () => {
  it('links a view to its components and shared files, and an entry-only view compiles to the same bytes as before', () => {
    const files = {
      ...VIEWS,
      'views/student.tsx': `import { Screen } from '@scholera/plugin-kit'\nimport { Title } from './components/Title'\nexport default function StudentView() { return <Screen><Title /></Screen> }\n`,
      'views/components/Title.tsx': `import { Text } from '@scholera/plugin-kit'\nimport { label } from '../../shared/format'\nexport function Title() { return <Text>{label(3)}</Text> }\n`,
      'shared/format.ts': 'export function label(n: number): string { return n + " left" }\n',
    }
    const bundles = compiled(files)
    expect(bundles.student).toContain('var label = __studio_m1.label;')
    expect(bundles.student).toContain('var Title = __studio_m2.Title;')
    expect(bundles.server).toBeNull()
    const legacy = compileView('views/professor.tsx', PROFESSOR_VIEW)
    expect(legacy.ok && legacy.bundle).toBe(bundles.professor)
    // A re-exported type and an interface merged with a value: no free identifier in the bundle.
    const types = compiled({
      ...files,
      'shared/format.ts': 'export interface Row { n: number }\nexport const Row = 1\nexport function label(n: number): string { return n + " left" }\n',
      'shared/types.ts': "import { Row as R } from './format'\nexport { R }\nexport const unit = 'left'\n",
      'views/components/Title.tsx': `import { Text } from '@scholera/plugin-kit'\nimport { label } from '../../shared/format'\nimport { unit } from '../../shared/types'\nexport function Title() { return <Text>{label(3) + unit}</Text> }\n`,
    })
    expect(types.student).toContain('"Row": Row')
    expect(types.student).toContain('"R": R')
    // A type-only re-export returns nothing: its name would be a free identifier at load.
    const typeOnly = compiled({ ...files, 'shared/format.ts': 'export interface Row { n: number }\nexport function label(n: number): string { return n + " left" }\n', 'shared/types.ts': "import { Row as R } from './format'\nexport { R }\nexport const unit = 'left'\n", 'views/components/Title.tsx': `import { Text } from '@scholera/plugin-kit'\nimport { unit } from '../../shared/types'\nexport function Title() { return <Text>{unit}</Text> }\n` })
    expect(typeOnly.student).not.toMatch(/"R": R/)
  })

  it.each([
    ['a view importing server code', { 'views/student.tsx': `import { Screen } from '@scholera/plugin-kit'\nimport { secret } from '../server/key'\nexport default function S() { return <Screen>{secret}</Screen> }\n`, 'server/key.ts': 'export const secret = 42\n', 'server/index.ts': 'export const actions = {}\n' }, 'builder.import_boundary'],
    ['shared code importing the kit', { 'shared/a.ts': "import { today } from '@scholera/plugin-kit'\nexport const d = today()\n" }, 'builder.import'],
    ['server code importing React', { 'server/index.ts': "import { useState } from 'react'\nexport const actions = { useState }\n" }, 'builder.import'],
    ['an import cycle', { 'views/student.tsx': `import { Screen } from '@scholera/plugin-kit'\nimport { a } from '../shared/a'\nexport default function S() { return <Screen>{a}</Screen> }\n`, 'shared/a.ts': "import { b } from './b'\nexport const a = b\n", 'shared/b.ts': "import { a } from './a'\nexport const b = 1\nexport const c = a\n" }, 'builder.import_cycle'],
  ])('refuses %s', (_name, extra, code) => {
    const r = compilePackage({ ...VIEWS, ...extra } as Record<string, string>)
    expect(r.ok).toBe(false)
    expect(r.diagnostics.map((d) => d.code)).toContain(code)
  })

  it('the validator refuses a view importing server code at publish too', async () => {
    const manifest = stamped(WORKSHEET_MANIFEST)
    const bundles = compiled(WORKSHEET_FILES)
    const source = { ...WORKSHEET_FILES, 'views/student.tsx': `import { x } from '../server/grading'\n${STUDENT_VIEW}`, 'plugin.manifest.json': canonicalJson(manifest) }
    const artifact = { manifest, source, studentBundle: bundles.student, professorBundle: bundles.professor, serverBundle: bundles.server }
    const report = await runStaticChecks({ artifact, storedHash: artifactHash(artifact), deadline: Date.now() + 10_000, classify: async () => ({ ok: false, reason: 'disabled' }) })
    expect(report.outcomes['source.imports'].status).toBe('failed')
  })

  it('every file is part of the draft and version identity; a plugin without server code keeps its artifact hash', () => {
    const manifest = stamped(WORKSHEET_MANIFEST)
    const base = snapshotHash('c', manifest, WORKSHEET_FILES)
    expect(snapshotHash('c', manifest, { ...WORKSHEET_FILES, 'server/grading.ts': WORKSHEET_GRADING.replace('<=', '<') })).not.toBe(base)
    const plain = { manifest, source: VIEWS, studentBundle: 's', professorBundle: 'p' }
    expect(artifactHash({ ...plain, serverBundle: null })).toBe(artifactHash(plain))
    expect(artifactHash({ ...plain, serverBundle: 'code' })).not.toBe(artifactHash(plain))
  })
})

describe('the manifest contract for server code', () => {
  it('reads name staffOnly collections only, server-written collections need actions, and new actions need approval', () => {
    const readsShared = { ...WORKSHEET_MANIFEST, server: { actions: { myAttempts: { roles: ['student'], args: {}, reads: ['attempts'] } } } }
    expect(proposeManifest(JSON.stringify(readsShared), { slug: 'w-abc12345', current: null, published: null }).ok).toBe(false)
    const { server: _server, ...noServer } = WORKSHEET_MANIFEST
    void _server
    expect(parseManifest({ ...stamped(WORKSHEET_MANIFEST), server: undefined }).ok).toBe(false)
    // Before: the same collections, with attempts still written by the student's own frame.
    const before = stamped({ ...noServer, collections: { ...WORKSHEET_MANIFEST.collections, attempts: { access: 'perStudent', fields: { score: 'number', total: 'number' } } } })
    const r = proposeManifest(JSON.stringify(WORKSHEET_MANIFEST), { slug: 'w-abc12345', current: before, published: null })
    expect(r.ok && r.approval.map((i) => i.kind)).toEqual(expect.arrayContaining(['server_action_added', 'collection_access_changed']))
  })
})

describe('the plugin server runtime', () => {
  const manifest = stamped(WORKSHEET_MANIFEST)
  const server = compiled(WORKSHEET_FILES).server!
  const call = (action: string, store: PreviewStore | null, args: unknown = {}, view: 'student' | 'professor' = 'student') =>
    previewServerCall({ manifest, view, serverBundle: server, action, args, store })

  it('a worksheet round trip: deterministic questions without answers, server grading, a result the student can’t forge', async () => {
    const first = await call('myWorksheet', BANK)
    const again = await call('myWorksheet', BANK)
    if (!first.result.ok) throw new Error(JSON.stringify(first.result))
    const questions = (first.result.data as { questions: { id: string; prompt: string }[] }).questions
    expect(questions).toHaveLength(2)
    expect(again.result).toEqual(first.result)
    // No answer, tolerance or explanation reaches the student before they submit.
    expect(JSON.stringify(first.result.data)).not.toMatch(/answer|tolerance|explanation|Round|Divide|Add\./)

    const key: Record<string, number> = { q1: 4, q2: 3.14, q3: 2.5 }
    const submitted = await call('submit', BANK, { answers: Object.fromEntries(questions.map((q) => [q.id, key[q.id]])) })
    expect(submitted.result).toMatchObject({ ok: true, data: { score: 2, total: 2 } })
    // Written as the caller (preview student 0), next to the other student's attempt.
    expect(submitted.store?.attempts.map((a) => a.owner).sort()).toEqual([0, 1])
    expect((await call('myAttempts', submitted.store)).result).toEqual({ ok: true, data: 1 })

    // The student's own frame can neither write that collection nor read the key.
    const frame = createPreviewBridge(manifest, 'student', { store: BANK })
    expect((await frame.handleRequest('records.create', { collection: 'attempts', data: { score: 2, total: 2 } })).ok).toBe(false)
    expect((await frame.handleRequest('records.list', { collection: 'questions' })).ok).toBe(false)
  }, 20_000)

  it('refuses an action the caller’s view isn’t declared for, and arguments the manifest doesn’t declare', async () => {
    expect((await call('classResults', BANK)).result).toMatchObject({ ok: false, code: 'not_available' })
    expect((await call('submit', BANK, { answers: {}, extra: 1 })).result).toMatchObject({ ok: false, code: 'invalid' })
    expect((await call('classResults', BANK, {}, 'professor')).result).toEqual({ ok: true, data: 'staff only' })
    // A capability call can't name an installation, a user or a scope: strict parameters.
    expect(CAPABILITY_PARAMS['records.list'].safeParse({ collection: 'attempts', installationId: 'x' }).success).toBe(false)
  }, 20_000)
})

describe('the local executor', () => {
  const run = (bundle: string, action = 'go', timeoutMs?: number) =>
    new LocalProcessExecutor(timeoutMs).execute({ bundle, action, argsJson: '{}', caller: { role: 'student', handle: null }, now: at }, async () => ({ ok: true, data: null }))
  const plugin = (body: string) => `'use strict';\n(function () {\n${body}\nreturn { actions: { go: go } };\n})();\n`
  afterEach(() => {
    delete process.env.STUDIO_TEST_SECRET
  })

  it('gives plugin code no environment, process, require, network API or string code generation', async () => {
    process.env.STUDIO_TEST_SECRET = 'sk-should-never-leak'
    const probe = plugin(`function go() {
      var found = { process: typeof process, require: typeof require, fetch: typeof fetch, globalProcess: typeof globalThis.process }
      try { found.escape = (function () {}).constructor('return typeof process')() } catch (e) { found.escape = 'blocked' }
      try { found.ctorEscape = this === undefined ? 'no this' : 'this' } catch (e) {}
      found.buffers = typeof Uint8Array + typeof ArrayBuffer
      return found
    }`)
    const out = await run(probe)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(JSON.parse(out.resultJson)).toEqual({ process: 'undefined', require: 'undefined', fetch: 'undefined', globalProcess: 'undefined', escape: 'blocked', ctorEscape: 'no this', buffers: 'undefinedundefined' })
    // Never beside a hosted database, whatever NODE_ENV says.
    expect(executorMode({ NODE_ENV: 'development', STUDIO_PLUGIN_EXECUTOR: 'local', NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' })).toBe('unavailable')
    // And never without the explicit opt-in, even beside a loopback database.
    expect(executorMode({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' })).toBe('unavailable')
    expect(out.resultJson).not.toContain('sk-should-never-leak')
  }, 20_000)

  it('stops a runaway action at its time limit, and reports a thrown error or an unsendable result', async () => {
    expect(await run(plugin('function go() { for (;;) {} }'), 'go', 1500)).toMatchObject({ ok: false, reason: 'timeout' })
    expect(await run(plugin('function go() { throw new Error("No attempts left") }'))).toMatchObject({ ok: false, reason: 'threw', message: 'No attempts left' })
    expect(await run(plugin('function go() { var a = {}; a.self = a; return a }'))).toMatchObject({ ok: false, reason: 'unserializable' })
    expect(await run(plugin('function go() { return 1 }'), 'missing')).toMatchObject({ ok: false, reason: 'missing_action' })
  }, 30_000)
})
