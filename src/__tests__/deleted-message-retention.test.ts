/**
 * #678: a soft-deleted message must stay retrievable for audit and unreachable by a client.
 *
 * The guarantee lives in the DATABASE, so this file guards the parts a unit test can actually reach:
 * the migration's shape, and the client not reintroducing a redaction the schema already handles.
 *
 * Why the shape is worth asserting at all. Three properties of that migration are one-word
 * deletable and each fails silently in a different direction:
 *   - the trigger is BEFORE UPDATE. As AFTER, the row is written unblanked and the realtime frame
 *     carries the original text, which is the exact residue this design closes.
 *   - the archive lives in the `audit` schema. In `public` it is exposed over PostgREST and the
 *     archive itself becomes the leak.
 *   - it is attached to all THREE message tables. Attached to one, the siblings drift, which is
 *     precisely how discussions ended up protected and dm_messages did not (22 deleted rows,
 *     10,592 characters, no protection of any kind).
 *
 * The redaction behaviour itself is verified against production in the migration's own review:
 * every pre-existing deleted row archived with its characters intact, zero characters left in the
 * public tables, 104 live rows untouched, and the real attack returning an empty string.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase/migrations')

/** The retention migration, found by name so a rename does not silently skip these assertions. */
function retentionMigration(): string {
  const f = readdirSync(MIGRATIONS).find((n) => n.endsWith('_audit_deleted_messages.sql'))
  if (!f) throw new Error('audit_deleted_messages migration is missing')
  /* Comments stripped FIRST. This migration explains its own design at length, so a naive match on
     the whole file passes on the prose while the DDL says something else. That mistake already
     happened once on this issue: a `security_invoker` assertion matched a header comment and stayed
     green after the clause was deleted from the statement. */
  return readFileSync(join(MIGRATIONS, f), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
}

const HOOKS = readFileSync(join(process.cwd(), 'src/lib/discussion/hooks.ts'), 'utf8')

describe('#678: the retention trigger keeps its shape', () => {
  it('fires BEFORE update, so the realtime frame carries the blanked row', () => {
    const ddl = retentionMigration()
    const triggers = [...ddl.matchAll(/create trigger trg_archive_and_blank\s+(before|after) update/gi)]
    expect(triggers).toHaveLength(3)
    for (const t of triggers) expect(t[1].toLowerCase()).toBe('before')
  })

  it('archives into the audit schema, which PostgREST does not expose', () => {
    const ddl = retentionMigration()
    expect(ddl).toMatch(/create schema if not exists audit/i)
    expect(ddl).toMatch(/insert into audit\.deleted_messages/i)
    /* In `public` the archive would be readable over the API and would become the leak. */
    expect(ddl).not.toMatch(/create table[^;]*public\.deleted_messages/i)
  })

  it('covers all three message tables, not just discussions', () => {
    const ddl = retentionMigration()
    for (const t of ['discussion_messages', 'project_chat_messages', 'dm_messages']) {
      expect(ddl).toContain(`before update on public.${t}`)
    }
  })

  it('revokes the archive from anon and authenticated', () => {
    const ddl = retentionMigration()
    expect(ddl).toMatch(/revoke all on table audit\.deleted_messages from anon, authenticated/i)
    expect(ddl).toMatch(/revoke all on schema audit from anon, authenticated/i)
  })

  it('blanks the attachment columns too, not only the text', () => {
    /* The attachment columns are the worse leak: they point at stored files, and a message deleted
       BECAUSE of its attachment would otherwise still hand out the path. */
    const ddl = retentionMigration()
    for (const col of ['attachment_url', 'attachment_path', 'attachment_name', 'attachment_size', 'attachment_type']) {
      expect(ddl).toMatch(new RegExp(`new\\.${col}\\s*:=\\s*null`))
    }
  })
})

describe('#678: the client does not depend on the dropped view', () => {
  it('reads the table, which is what realtime subscribes to', () => {
    /* The interim view was dropped: with the row blanked at rest its CASE can never fire, and a
       redaction that cannot fire reads as load-bearing when it is not. */
    expect(HOOKS).not.toContain('discussion_messages_safe')
    const targets = [...HOOKS.matchAll(/\.from\((['"])([^'"]+)\1\)/g)].map((m) => m[2])
    expect(targets.filter((t) => t === 'discussion_messages')).toHaveLength(2)
  })

  it('keeps the explicit FK hint, since discussion_messages has two FKs to profiles', () => {
    /* author_id and deleted_by_id both reference profiles, so an unhinted embed is ambiguous and
       PostgREST refuses it. Dropping the hint would blank every author name in chat. */
    expect(HOOKS).toContain('author:profiles!discussion_messages_author_id_fkey')
  })
})
