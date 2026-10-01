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

  it('db.ts is imported only by the trusted service modules', () => {
    const importers = files.filter((f) => {
      const s = source(f)
      return /from ['"]@\/lib\/studio\/db['"]/.test(s) || (f.startsWith('src/lib/studio/') && /from ['"]\.\/db['"]/.test(s))
    })
    expect(importers.sort()).toEqual(['src/lib/studio/context.ts', 'src/lib/studio/lifecycle.ts', 'src/lib/studio/records.ts'])
  })
})

describe('Studio service modules', () => {
  const SERVICE = ['context', 'db', 'lifecycle', 'publication', 'records'].map((m) => `src/lib/studio/${m}.ts`)

  it.each(SERVICE)('%s is server-only', (f) => {
    expect(source(f)).toMatch(/^import 'server-only'$/m)
  })

  it('none of src/lib/studio is a server action, so none of it is a callable endpoint', () => {
    const actions = files.filter((f) => f.startsWith('src/lib/studio/') && /^\s*['"]use server['"]/m.test(source(f)))
    expect(actions).toEqual([])
  })
})
