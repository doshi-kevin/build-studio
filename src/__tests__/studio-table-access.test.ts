/**
 * Tripwire for the Studio server-only boundary. The admin client bypasses row-level
 * security, so the only thing that keeps a new server action from reading plugin
 * records directly is that nothing but src/lib/studio/db.ts may name the tables, and
 * nothing but the trusted service modules may import db.ts.
 * (docs/reference/studio-plugin-server.md, "Keeping the admin client honest".)
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

// Paths with forward slashes, so this behaves the same on Windows.
const files = (readdirSync(SRC, { recursive: true }) as string[])
  .map((f) => relative(ROOT, join(SRC, f)).replaceAll('\\', '/'))
  .filter((f) => /\.(ts|tsx)$/.test(f))
  // Tests may name tables to prove the database refuses things; the generated types
  // file lists every table by definition.
  .filter((f) => !f.startsWith('src/__tests__/') && f !== 'src/lib/supabase/types.ts')

const source = (f: string) => readFileSync(join(ROOT, f), 'utf8')

describe('Studio storage tables', () => {
  it('scans a realistic number of files (guards a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it('are named only by src/lib/studio/db.ts', () => {
    expect(files.filter((f) => source(f).includes('studio_plugin_'))).toEqual(['src/lib/studio/db.ts'])
  })

  // Any specifier that resolves to src/lib/studio/db: the alias, ./db from src/lib/studio,
  // or ../db (and deeper) from its subfolders.
  const importsDb = (f: string, s: string) => {
    if (/from ['"]@\/lib\/studio\/db['"]/.test(s)) return true
    if (!f.startsWith('src/lib/studio/')) return false
    const depth = f.slice('src/lib/studio/'.length).split('/').length - 1
    const relative = depth === 0 ? String.raw`\./db` : String.raw`(\.\./){` + depth + '}db'
    return new RegExp(`from ['"]${relative}['"]`).test(s)
  }

  it('db.ts is imported only by the trusted service modules', () => {
    const importers = files.filter((f) => importsDb(f, source(f)))
    expect(importers.sort()).toEqual([
      'src/lib/studio/bridge/context-get.ts',
      'src/lib/studio/bridge/registry.ts',
      'src/lib/studio/builder/course-retriever.ts',
      'src/lib/studio/builder/harness.ts',
      'src/lib/studio/builder/service.ts',
      'src/lib/studio/context.ts',
      'src/lib/studio/handles.ts',
      'src/lib/studio/lifecycle.ts',
      'src/lib/studio/navigation.ts',
      'src/lib/studio/records.ts',
      'src/lib/studio/runtime/frame.ts',
      'src/lib/studio/skill-bindings.ts',
      'src/lib/studio/student-visibility.ts',
      'src/lib/studio/validator/pipelines.ts',
      'src/lib/studio/validator/service.ts',
    ])
  })
})

describe('Studio service modules', () => {
  const SERVICE = [
    'context', 'db', 'handles', 'lifecycle', 'publication', 'records', 'runtime/frame', 'runtime/frame-ticket',
    'bridge/registry', 'bridge/dispatch', 'bridge/context-get', 'bridge/rate-limit',
    'access', 'navigation', 'prepublish', 'student-visibility', 'skill-bindings',
    'validator/service', 'validator/purpose-ai', 'validator/runtime-runner', 'validator/cloud-runner', 'validator/pipelines',
    'builder/harness', 'builder/service', 'builder/model', 'builder/check-worker',
  ].map(
    (m) => `src/lib/studio/${m}.ts`,
  )

  it.each(SERVICE)('%s is server-only', (f) => {
    expect(source(f)).toMatch(/^import 'server-only'$/m)
  })

  it('none of src/lib/studio is a server action, so none of it is a callable endpoint', () => {
    const actions = files.filter((f) => f.startsWith('src/lib/studio/') && /^\s*['"]use server['"]/m.test(source(f)))
    expect(actions).toEqual([])
  })
})
