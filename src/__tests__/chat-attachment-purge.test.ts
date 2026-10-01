// #678: a soft-deleted message's FILE must not outlive it.
//
// The row is redacted by a BEFORE UPDATE trigger, which is the right layer — no code path can
// bypass it. But Postgres cannot reach object storage, so the trigger orphans the file rather
// than removing it, and an orphaned object in the bucket is still fetchable by anyone who can
// get a signed URL for it. Blanking `attachment_path` hid the pointer, not the thing.
//
// The purge therefore has to live in application code, at every soft-delete site — and there
// are FOUR of them, not the three the issue assumed. That is exactly the fragility the trigger
// was chosen to avoid, so the first test below DERIVES the list of delete paths from the source
// instead of hardcoding it: a fifth path added later that forgets the purge fails by name.
//
// This is the same technique that caught a real miss on the Pinecone write guard, where an
// allowlist of five functions was asserted against a codebase that had six.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ── 1. Structural: every soft-delete path purges ──────────────────────────

const APP = join(process.cwd(), 'src/app')

/** Every .ts file under src/app, walked rather than globbed so a new folder is included. */
function allActionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) allActionFiles(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Function bodies that soft-delete a chat message, keyed by file. */
function softDeleteSites(): { file: string; purges: boolean }[] {
  return allActionFiles(APP)
    .map((file) => ({ file, src: readFileSync(file, 'utf8') }))
    // A soft-delete is an update that stamps deleted_at on a MESSAGE table.
    .filter(({ src }) =>
      /deleted_at:\s*new Date\(\)/.test(src) &&
      /from\('(discussion_messages|dm_messages|project_chat_messages)'\)/.test(src),
    )
    .map(({ file, src }) => ({
      file: file.replace(process.cwd() + '/', ''),
      purges: src.includes('purgeChatAttachment('),
    }))
}

describe('#678: every message soft-delete purges its attachment', () => {
  it('finds the delete paths by reading the source, not from a list', () => {
    /* Guards against a vacuous pass: if the detection breaks, this fails rather than the
       suite silently asserting nothing. Four are known today. */
    expect(softDeleteSites().length).toBeGreaterThanOrEqual(4)
  })

  it('leaves no soft-delete path without a purge', () => {
    const missing = softDeleteSites().filter((s) => !s.purges).map((s) => s.file)
    expect(missing).toEqual([])
  })

  it('reads attachment_path in the same file, since the trigger nulls it on update', () => {
    /* The ordering trap. The BEFORE UPDATE trigger blanks attachment_path, so a purge that
       reads the column AFTER the soft-delete always gets null and silently removes nothing —
       passing every behavioural test while fixing nothing. Each site must select the column
       up front. */
    for (const site of softDeleteSites()) {
      const src = readFileSync(join(process.cwd(), site.file), 'utf8')
      /* Check the ARGUMENT of a .select(), not the file. A loose "somewhere after a select()"
         regex passes as soon as the identifier appears anywhere at all — including in the purge
         call itself — which is how this assertion first passed vacuously. */
      const selectArgs = [...src.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)].map((m) => m[2])
      expect(
        selectArgs.some((arg) => arg.includes('attachment_path')),
        `${site.file} must request attachment_path in a .select() before deleting`,
      ).toBe(true)
    }
  })
})

// ── 2. Behavioural: the helper itself ─────────────────────────────────────

const removeSpy = vi.fn()
const warnSpy = vi.fn()

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: (...a: unknown[]) => warnSpy(...a), info: vi.fn(), debug: vi.fn() },
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
let purgeChatAttachment: any
/* eslint-enable @typescript-eslint/no-explicit-any */

function fakeDb(result: unknown = { error: null }) {
  removeSpy.mockReset()
  removeSpy.mockResolvedValue(result)
  return { storage: { from: (b: string) => ({ remove: (paths: string[]) => removeSpy(b, paths) }) } }
}

beforeEach(async () => {
  vi.resetModules()
  warnSpy.mockReset()
  const mod = await import('@/lib/supabase/chat-storage-server')
  purgeChatAttachment = mod.purgeChatAttachment
})

describe('purgeChatAttachment', () => {
  it('removes the object from the chat bucket', async () => {
    await purgeChatAttachment(fakeDb(), 'dms/chan/2026/08/file.png')
    expect(removeSpy).toHaveBeenCalledWith('chat-attachments', ['dms/chan/2026/08/file.png'])
  })

  it('does nothing when the message had no attachment', async () => {
    const db = fakeDb()
    await purgeChatAttachment(db, null)
    await purgeChatAttachment(db, undefined)
    await purgeChatAttachment(db, '')
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('swallows a storage failure rather than failing the delete', async () => {
    /* The message being gone matters more than the file being gone. Throwing here would leave
       the message visible, which is strictly worse than an orphaned object. */
    await expect(
      purgeChatAttachment(fakeDb({ error: { message: 'nope' } }), 'a/b.png'),
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('swallows a thrown storage client too', async () => {
    const db = { storage: { from: () => ({ remove: () => { throw new Error('network') } }) } }
    await expect(purgeChatAttachment(db, 'a/b.png')).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })
})
