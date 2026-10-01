# supabase/

The database. `config.toml` configures the local Supabase stack, and `migrations/` holds every
schema change ever made, currently 242 files.

Postgres is the source of truth for the whole product. Supabase also provides auth, file storage,
and realtime, so a lot of what would be app logic elsewhere lives here as SQL.

## How migrations get applied

The two environments are updated through completely different channels, and this surprises people:

- **Local:** `supabase migration up` replays the files in this folder.
- **Production:** applied through the Supabase MCP `apply_migration` tool, by hand, at release time.

`infra/app/deploy-to-prod.sh` deploys the app and **does not touch the schema**. If your code
needs a migration, apply the migration first. Otherwise the new code lands on a database that
cannot support it.

Production stamps its own version numbers, so the version list in the Supabase dashboard will not
match the filenames here. That is expected and not drift.

**Applying DDL to production briefly breaks live queries.** Supabase reloads its schema cache
afterwards, and in-flight requests can fail with `PGRST002` while it does. Do not apply migrations
mid-class or during a demo.

## Writing a migration

Create it with the CLI so it gets a timestamp prefix:

```bash
supabase migration new <name>
```

**Never hand-number a file.** Two branches both reaching for the next integer is a mistake that
has already happened here: Postgres keys a migration by its leading number, so when two files
share one, the second is silently skipped. Nothing errors. You find out when a column is missing
in production.

Every migration must satisfy these, which are enforced in review:

- **Row-level security on every new table**, enabled in the same migration that creates the
  table, with policies scoped by `institution_id` **and** role. A table without RLS is reachable
  by any authenticated user of any institution.
- **`DROP POLICY IF EXISTS` before `CREATE POLICY`.** Postgres has no
  `CREATE POLICY IF NOT EXISTS`. Without the drop, re-running the migration halts partway, and
  anything after it in the file, triggers and functions included, silently never runs.
- **Server-only functions need their grants revoked.** Supabase grants `EXECUTE` to `anon` and
  `authenticated` automatically. A server-only RPC needs
  `revoke execute on function … from anon, authenticated`. Revoking from `public` alone is not
  enough. Check `role_routine_grants` to confirm.
- **Write it to work with both the old and the new app code.** Deploys and migrations are separate
  steps, so both versions of the code will run against the migrated schema at some point. This is
  also what makes an app rollback survivable, since rolling back Cloud Run does not roll back the
  database.

`migrations/00000000000000_base_schema.sql` is the starting point that everything else builds on.

## After a schema change

Regenerate the TypeScript types:

```bash
npx supabase gen types typescript --local > src/lib/supabase/types.ts
```

`src/lib/supabase/types.ts` is generated. Never edit it by hand; your change will be wiped and the
types will stop matching the database.

## The local stack

```bash
supabase start          # starts Postgres, auth, storage, and the rest in Docker
supabase migration up   # applies any migrations you do not have yet
```

Ports, taken from `config.toml`: API on 54321, Postgres on 54322, Studio on 54323, and Inbucket
(which catches outgoing email) on 54324. Local Postgres is major version 17.

`supabase db reset` replays every migration from scratch. It also **destroys all local data**,
including uploaded files and every user account, so re-seed with
`bash scripts/dev-setup/setup-local.sh` afterwards. Reach for `migration up` unless you actually
need the rebuild.

See [`../scripts/dev-setup/CONTEXT.md`](../scripts/dev-setup/CONTEXT.md) for the full local
workflow and how schema and seed data stay current.
