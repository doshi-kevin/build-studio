# Dev Setup — CONTEXT

Read this before touching anything in `scripts/dev-setup/`. It explains the intern
local-development workflow, why it's built this way, and how to keep it healthy.

## What this folder is for

Junior Engineers develop **only against a local Supabase stack** — never against
production. This folder gives them a one-command way to get a local database that
has (a) the **current production schema** and (b) **realistic dummy data**, with
**zero production access** and **zero real-customer data** on their machine.

## The two things that must stay current — and how each does

The whole design rests on separating **schema** from **data**. They update through
completely different channels:

| | What it is | How it stays current | Effort |
|---|---|---|---|
| **Schema** (tables, columns, RLS) | `supabase/migrations/*.sql` | `git pull` + `db reset` replays every migration → local schema == prod schema | **Automatic** |
| **Data** (the rows) | `seed-dev.ts` (generated, not pulled) | edit `seed-dev.ts` only if a migration invalidates it | Rare, manual |

**Key insight:** the migration files *are* the prod schema. Prod only changes when
someone adds a migration and an admin applies it. Those files are in git, so a
`git pull` + `db reset` makes local schema byte-for-byte current. Nobody maintains
a schema snapshot. The seed is the only static piece, and dummy data doesn't need
to match *today's prod rows* — it only needs to be **valid against today's schema**.

## Files

- **`setup-local.sh`** — the one command junior engineers run. It:
  1. preflight checks, bottom-up — Docker installed → Docker daemon running →
     Supabase CLI available. Each failure prints the exact command/link to fix it
     (so a human *or* an AI assistant reading the terminal knows the next action),
  2. ensures the local Supabase stack is up — **auto-starts it** if it isn't,
  3. confirms the stack URL is localhost (refuses otherwise),
  4. `supabase db reset` → replays all migrations = current prod schema locally
     (falls back to `supabase migration up` if reset dies partway — see below),
  5. runs `seed-dev.ts` with the local stack's env vars,
  6. prints the dev logins.
- **`seed-dev.ts`** — first ensures the **storage buckets that no migration creates**
  (`course-materials`, `proctoring-snapshots` — made by hand in the prod dashboard;
  migrations only flip them private + add RLS), then generates dummy data **top-down**
  (institution → department → course → section → users → enrollments → modules →
  assignments → projects → quizzes → skills → memory → announcements). Each child row
  uses the parent's id, so foreign keys always line up — no hand-written UUIDs, no FK
  errors. Hard-gated to localhost. Idempotent (upsert by deterministic UUID; buckets
  update-or-create). CS101 (section 1) gets real course content: 9 modules with real
  multi-page PDFs, a published assignment with graded + ungraded file submissions, a
  project with two teams, 4 skills with a real class median and mastery trend per skill,
  and Athena memory preferences for the professor and student1 — enough to exercise the
  professor grading queue, the student submission view, team membership, the Skill Index,
  and the memory panel, not just prove a page renders.
- **`fixtures/pdf.ts`** — generates two real, multi-page PDFs (a 3-page syllabus, a
  3-page lecture-notes doc) at seed time using `jspdf` (already a project dependency).
  Returns the true page count alongside the bytes, so the module list's displayed page
  count always matches what opening the file shows — earlier this fixture reused a
  1-page test file with a fabricated page-count label, which read as a bug (a module
  claiming "47 pages" that opened to 1). No binary is committed to git; the content
  regenerates fresh every run, consistent with this seed's "generate, don't pull"
  philosophy below.
- **`fixtures/modules.ts`** — the module/PDF fixture's data and insert logic, shared
  between `seed-dev.ts` and the standalone `seed-modules-tile-fixtures.ts` below. IDs are
  derived from `(sectionId, slug)`, not slug alone — seeding two different sections must
  produce two independent sets of rows, not have the second section steal the first
  one's rows out from under it (a real bug caught while building this).
- **`seed-modules-tile-fixtures.ts`** — a thin wrapper around `fixtures/modules.ts` for
  seeding the same module/PDF fixture onto an **arbitrary** section, for UI dev work on
  the student Modules page where you need it on a section other than CS101 (e.g. one you
  made by hand, or CS201). Run directly, no `.sh` wrapper:
  ```bash
  NEXT_PUBLIC_SUPABASE_URL=<local API URL> \
  SUPABASE_SERVICE_ROLE_KEY=<local service_role key> \
    npx tsx scripts/dev-setup/seed-modules-tile-fixtures.ts [sectionId]
  ```
  Both values come from `npx supabase status`. With no `sectionId` it picks the local
  section with the most enrolled students.
- **`CONTEXT.md`** — this file.

## Intern workflow (the whole loop)

```
# Prerequisite: Docker Desktop installed and running (the script checks and tells
# you if it isn't). The script auto-starts the Supabase stack — no manual start needed.
git pull                              # newest migrations + newest seed-dev.ts
./scripts/dev-setup/setup-local.sh    # preflight + start stack + schema + dummy data + logins
npm run dev                           # http://localhost:3000

# ...build the feature. If it needs a schema change, add a NEW migration file
#    in supabase/migrations/ and run setup-local.sh again to confirm it replays.

# Open a PR with the migration. NEVER apply it to prod — an admin does that.
```

**Logins** (all password `<password in .env.local>`): `admin@scholera.dev`, `professor@scholera.dev`,
`student1@scholera.dev` … `student6@scholera.dev`.

## Hard rules (why this is safe)

- **Junior Engineers never touch production.** `setup-local.sh` only ever reads the *local*
  stack's URL/key from `supabase status`, and refuses any non-localhost URL.
  `seed-dev.ts` has the same hard gate. No prod connection string, no read-only role.
- **Junior Engineers never apply migrations to prod.** They write migration files; an admin
  applies them. (This mirrors the repo-wide rule.)
- **No real-customer data anywhere.** Data is generated, not pulled from prod.

## Why it's built this way (decisions, so you don't re-litigate them)

- **Generated data, not a prod subset.** A real subset would mean walking a ~70-table
  foreign-key graph (only ~8 tables carry `institution_id`; the rest are transitive),
  which is brittle and risks copying real-customer (Stevens) PII onto laptops. The
  data is tiny and generic data is enough to populate the screens — so we generate.
- **`seed-dev.ts`, not a static `seed.sql`.** A generator inserts top-down so FK ids
  always resolve, and it's edited (not UUID-hunted) when the schema shape changes.
  This matches the existing `scripts/seed-e2e.ts` pattern — no new abstraction.
- **Scholera Dev institution (`00000000-0000-0000-0000-000000000002`)** is created by
  `seed-dev.ts` itself (idempotent upsert), so the seed works on any fresh local
  `db reset` without depending on a migration to seed the tenant.
- **`institution_id` is set explicitly** on every tenant-scoped row. The DB has
  tenant-match guard triggers (`trg_courses_tenant_match`,
  `trg_course_sections_tenant_match`) that reject rows whose `institution_id` doesn't
  match the parent — so all seeded rows use the same Scholera Dev id.
- **Every course-content date is relative to WHEN THE SEED RUNS, never a fixed calendar
  date.** `seed-dev.ts` derives a `SEMESTER_START_MS` 6 weeks before "now" and computes
  every quiz/assignment/enrollment date from `daysFromStart(n)`, so the seed always reads
  as mid-semester: material already covered is graded, material ahead is still locked
  (matching the module fixture's own relative `unlockDate`s), and nothing waiting to be
  graded is older than a couple of weeks. This was a real bug, not a hypothetical — an
  earlier version hardcoded `2026-02-08`-style dates, and by September a professor's
  grading queue showed a submission "220 days waiting." When adding new dated content,
  compute it from `daysFromStart()`, don't hardcode a calendar date.

## Known upstream issue: `db reset` can fail mid-replay

`supabase db reset` occasionally dies partway through with:

```
ERROR: cannot insert multiple commands into a prepared statement (SQLSTATE 42601)
```

This is a Supabase CLI bug ([supabase/cli#5139](https://github.com/supabase/cli/issues/5139)),
not a broken migration. Right after `db reset` recreates the local Postgres container,
the CLI can send a migration file with more than one top-level SQL statement (e.g.
`CREATE FUNCTION` followed by `COMMENT ON FUNCTION`) as if it were a single "prepared
statement," which Postgres's wire protocol only ever allows one command in. The same
file applies cleanly via `psql` directly and via `supabase migration up` against the
already-running stack — confirmed while diagnosing this, not assumed.

`setup-local.sh` handles this automatically: if `db reset` fails, it retries with
`supabase migration up`, which resumes from whatever `db reset` had already applied
(tracked in `supabase_migrations.schema_migrations`) and finishes the rest. If a
migration is genuinely broken, `migration up` hits the same real error and the script
still fails loudly — this fallback only papers over the CLI's known quirk, not actual
bugs in our SQL. Don't remove this retry as unnecessary complexity; it exists because
the failure is real and reproduces across independent machines.

## Maintaining the seed

You only edit `seed-dev.ts` when a migration makes the *existing* seed invalid —
e.g. a new `NOT NULL` column with no default on a table the seed inserts, or a
renamed/dropped column. You don't have to track this: `setup-local.sh` runs the seed
right after `db reset`, so a breaking migration makes the **next run fail loudly**.
Whoever wrote that migration updates `seed-dev.ts` in the same PR.

To enrich the dummy data (more courses, discussions, etc.), add a new top-down
`seed*()` function in `seed-dev.ts` and call it from `main()`. Keep it boring and
explicit — match the existing functions. If the new fixture is something someone would
also want to drop onto an arbitrary section for UI dev work (like modules), put its data
and insert logic in its own file under `fixtures/` and have `seed-dev.ts` call it — don't
duplicate the logic between the canonical seed and a standalone dev script.

## Hosted staging (the same seed, a different target)

There is also a hosted **staging** environment (`staging.scholera-inc.com`, Cloud Run
service `scholera-staging`) backed by its **own isolated Supabase project** — a
free-tier project that is NOT prod and NOT local. `seed-dev.ts` populates that project
too, so staging has the same Scholera Dev dummy data interns see locally.

This does **not** weaken the "never touch production" rule. `seed-dev.ts` has two
guards: it blocks the prod ref (`ywdqaoahfmmzcsczxvxn`) unconditionally, and any
non-localhost target additionally requires `SEED_CONFIRM_REF` to equal that target's
own project ref. To seed staging:

```bash
NEXT_PUBLIC_SUPABASE_URL="https://<staging-ref>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<staging service_role>" \
SEED_CONFIRM_REF="<staging-ref>" \
  npx tsx scripts/dev-setup/seed-dev.ts
```

Interns still develop **only** against local (`setup-local.sh`). Staging is the shared
QA target deployed via `infra/app/deploy-to-staging.sh`; promotion flow stays
`feature → staging → main → prod`.
