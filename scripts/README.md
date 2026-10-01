# scripts/

Operational and setup scripts, run by hand. Nothing here runs automatically in CI or during a
deploy.

## Read this before you run anything

Most of these scripts load `.env.local` and use the Supabase **`service_role`** key. Two
consequences:

1. **`.env.local` points at the production database.** The local Supabase URL is commented out in
   it. So the default for a script here is production, not localhost.
2. **`service_role` bypasses row-level security completely.** None of the tenant isolation that
   protects the app applies. A missing `where` clause reaches every institution's data.

So: read the script's header comment before running it, check which environment you are actually
pointed at, and prefer the read-only script over the write one when you are still working out what
to do. `list-live-rooms.ts` exists so you do not have to guess before running `end-live-rooms.ts`.

For test data, the `Scholera Dev` institution is the sandbox. Fake data there is expected. Never
write test data into a real institution.

## Running a script

```bash
npx tsx scripts/<name>.ts

# When the script needs env vars, load the file explicitly:
npx dotenv -e .env.local -- tsx scripts/<name>.ts
```

Each script's header comment has its own exact usage line, including any flags or environment
variables it reads. That comment is the authority, not this table.

## What's here

**Backfills.** Re-run a pipeline over rows that predate it. Both are batched and resumable, and
both take a `BACKFILL_LIMIT` (default 200).

| Script | Purpose |
|---|---|
| `backfill-extraction.ts` | Re-runs the extraction pipeline on lecture items with no extraction, an old v1 extraction missing `images[]`, or a failed earlier run. |
| `backfill-concepts.ts` | Queues concept extraction for lecture items that have a finished extraction but no stored quiz concepts. One cheap LLM call per item, over pages already stored. |

**Live Classroom operations.** For when a session is stuck.

| Script | Purpose |
|---|---|
| `list-live-rooms.ts` | Lists every currently-live room in production. Read-only. Run this first. |
| `end-live-rooms.ts` | Force-ends every live room. **Only when you are certain no real class is in session**, because it will cut off a live one. |

**Pinecone.** Vector index management.

| Script | Purpose |
|---|---|
| `pinecone-create-materials-index.ts` | Creates the materials index for an environment. Run once per environment. Indexes are created **only** here and never from feature code, because metric, dimension, cloud, region, and vector type cannot be changed afterwards. Getting one wrong means re-embedding everything. |
| `pinecone-whois-namespace.ts` | Translates a namespace (`inst_{uuid}__sec_{uuid}`) into readable institution and section names. The Pinecone dashboard only shows UUIDs on purpose: names live in Postgres so vector metadata can never go stale or leak. |

**Seeding.**

| Script | Purpose |
|---|---|
| `seed-e2e.ts` | Creates the deterministic users and course data the Playwright suite expects, then writes the UUIDs to `e2e/fixtures/seed-ids.json`. Idempotent. Usually invoked through `npm run db:seed:e2e`, which points it at `.env.test`. |
| `seed-dev-students.ts` | Creates five dummy team-chat students in the `Scholera Dev` institution. Idempotent: an existing user gets its profile upserted and its auth user left alone. Reads the password from `TEST_TEAM_MEMBERS_PASSWORD` rather than hardcoding a working production credential. |

## Subfolders

- **[`dev-setup/`](./dev-setup/)** gets a local Supabase stack running with the production schema
  and realistic dummy data, and no production access. Read
  [`dev-setup/CONTEXT.md`](./dev-setup/CONTEXT.md) before changing anything in there.
- **[`archive/`](./archive/)** holds one-off scripts whose job is finished. Kept as a record, not
  as working tooling. Nothing calls them.

## Adding a script

Put a comment block at the top saying what it does, which environment it expects, whether it
writes anything, and the exact command to run it. Every script here does that, and it is the
reason you can tell at a glance whether one is safe to run. Make destructive scripts print what
they are about to do before they do it, and give anything destructive a read-only counterpart.
