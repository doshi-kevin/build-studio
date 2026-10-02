# Studio Supabase Acceptance Checklist

Studio Steps 2 to 6 were verified on a machine that can't run local Supabase. The database tests ran on PGlite, an in-process Postgres, through a stand-in for the Supabase client. That is secondary evidence: it runs the real migrations and triggers, but not PostgREST, roles or concurrency. Run this once on a machine that can. If every step passes, they change from **complete locally** to **fully accepted**, with no redesign. What was and wasn't verified is in the Verification sections of [studio-plugin-storage.md](./studio-plugin-storage.md) and [studio-plugin-server.md](./studio-plugin-server.md), and in [studio-plugin-publication.md](./studio-plugin-publication.md) and [studio-plugin-validator.md](./studio-plugin-validator.md).

Passing this checklist is necessary, not sufficient, for turning on student access in production. The full list is the publication doc's [release gate](./studio-plugin-publication.md#release-gate).

Use the local stack only. Never point any of this at production.

1. **Start local Supabase:** `supabase start`
2. **Apply all migrations:** `supabase migration up`. It must include `20260930175948_studio_plugin_storage.sql`, `20261001181829_studio_publication.sql`, `20261001192059_studio_student_quota.sql`, `20261001202323_studio_validator.sql` and `20261002160000_studio_builder.sql`. The last replaces `studio_activate_version` and `studio_set_student_visibility` with versions that take one more argument (the state the server checked); confirm the old four-argument functions are gone.
3. **Run the database tests:** `npm run test:db`
4. **Run the Studio server-path, bridge and publication tests against real PostgREST:** `npx vitest run --config vitest.db.config.ts src/__tests__/db/studio-storage.test.ts src/__tests__/db/studio-server-path.test.ts src/__tests__/db/studio-bridge-dispatch.test.ts src/__tests__/db/studio-publication.test.ts src/__tests__/db/studio-validator.test.ts src/__tests__/db/studio-builder.test.ts src/__tests__/db/studio-builder-budgets.test.ts`. The budgets suite holds the builder's real-concurrency tests (racing starts at each cap, Stop against a commit, stale claim tokens, two commits from one revision, the commit lock order, concurrent saves of one draft); like the undo race in the builder suite, they skip on PGlite. The builder suite drives one whole build through the real harness and check worker with a scripted model; no model is called. On real Postgres the two concurrency tests run too ("two concurrent writers can't both take the last slot" and "two concurrent writes by one student can't both take their last slot"); on the PGlite stand-in they are skipped, so they have never run. If the fixture has a `super_admin` profile, the kill switch function test and the validator's review tests run (a super admin's approval, and a super admin refused for their own version); otherwise they skip, and those need a manual check as a super admin. On PGlite they ran, against a stand-in super admin.
5. **Regenerate the types:** `npx supabase gen types typescript --local > src/lib/supabase/types.ts`. Confirm the Studio tables appear: the eight from Steps 2 to 5 (`studio_plugin_*`, including `_usage`, `_student_usage` and `_limits`), the five from Step 6 (`studio_validator_settings`, `studio_plugin_validations`, `studio_plugin_validation_checks`, `studio_plugin_validation_reviews`, `studio_plugin_skill_bindings`), the four from Step 7 (`studio_plugin_snapshots`, `studio_plugin_builder_runs`, `studio_plugin_builder_steps`, `studio_plugin_builder_spend`), the `student_visibility`, `artifact_sha256`, `draft_head_hash`, `draft_rev`, `draft_undo_hash` and `source_snapshot_hash` columns, and the `studio_version_sizes` function.
6. **Typecheck:** `npm run typecheck`
7. **Run the database advisors:** the Security and Performance advisors in local Supabase Studio (http://127.0.0.1:54323, Advisors). Expect no new findings for `studio_*` tables or functions. All five validator tables have row-level security on with no policies, like the other Studio tables. `set_studio_kill_switch` is `security definer` with its role check inside, like `set_institution_ai_policy`; review it if the advisor flags it.
8. **Confirm no new Studio failures:** `npm run test`. Any failure in a `studio-*` test file, or in `migration-guards`, that names a Studio file blocks acceptance. Failures that predate Studio are listed in the storage doc's Verification section.
9. **Run the validator against real tables, end to end:** with `STUDIO_VALIDATOR_RUNNER=local` in `.env.local` and `npm run dev`, publish the known-good fixture (`GOOD` in `src/lib/studio/validator/fixtures.ts`) as a plugin, open "Show to students…", and press "Run browser checks". Within a few minutes both stages read "Passed". The browser runner itself is covered by `npm run e2e:studio-validator`, which needs no database.

## Step 7C local run (2026-10-02)

The machine Step 7C was built on can't run Docker, so this checklist still hasn't run against real Supabase. What ran instead, on a native PostgreSQL 17.6 with real PostgREST 16.4, a minimal stand-in for GoTrue's sign-in and admin endpoints, and a shim for the Supabase-owned schemas (`auth`, `storage`, `realtime`, roles, default privileges; `pg_cron` and `pgvector` as record-only test stubs):

| Step | Result |
|---|---|
| 2. Apply all migrations | 294 applied in filename order with 0 errors. Two files don't match the CLI's `<digits>_name.sql` pattern and were skipped, as `supabase migration up` skips them: `00000000000033b_classroom_rls_fix_recursion.sql` and `00000000000037b_lc_drawings_drop_old_overload.sql`. Both predate Studio; check whether production ever applied them |
| 3. `npm run test:db` | 216 passed, 1 failed, 3 skipped. The failure predates Studio: `anon` can execute `roadmap_set_node_checkoff` (security invoker, revoked from `public` only, so Supabase's default privileges still grant it to `anon`). The 3 skips need a `super_admin` profile; with one added, all 88 publication and validator tests passed |
| 4. Studio suites through real PostgREST | Every Studio file passes, including both storage-quota concurrency tests, which had never run before, and the builder's undo, budget and race tests |
| 5. Regenerate types | Not run: `supabase gen types` needs the CLI's Docker image. Studio's `db.ts` uses an untyped client, so the generated file gates nothing in Studio |
| 7. Advisors | The advisor lints (Supabase's open-source `splinter.sql`) ran directly on the database. Studio has no WARN findings except the known `set_studio_kill_switch`. INFO: `rls_enabled_no_policy` on every Studio table (intended), and unindexed foreign keys, including three from Step 7 (`snapshots.institution_id` and the two draft-pointer keys) |

Two test bugs only real Postgres exposed are fixed: the builder suite passed JavaScript arrays to `jsonb` arguments (node-postgres sends a Postgres array literal), and the bridge test expected the stand-in's seed value for the course title.

Still needed on real Supabase: this whole checklist, real GoTrue and Storage, the Supabase Postgres image's own roles and extensions, and step 5.

## Step 7D: migration history and grants (2026-10-02)

**`roadmap_set_node_checkoff` was callable by `anon`.** `20260619143157` and `20260713120000` revoked it from `public` only. Supabase's default privileges grant `anon` EXECUTE directly, not through `public`, so `anon` kept it. The only caller, `setMyNodeCheckedOff`, uses the service-role client after `verifyEnrollment`. `20261002200100_revoke_anon_roadmap_checkoff.sql` revokes it from `public, anon` and keeps `authenticated` and `service_role`. On the local database, PostgREST now answers an anon call with `42501 permission denied`, and `grants-and-policy-shape.test.ts` passes (10 of 10). No other public function failed that test. `migration-guards.test.ts` gained a rule that a function revoked from `PUBLIC` must also be revoked from `anon`. It checks itself against `20260713120000`, so it can't pass vacuously.

`migration-guards.test.ts` still fails one rule, as it did before this step: `20260925220017_lc_auto_end_from_started_at.sql` has no revoke for `lc_auto_end_stale_rooms()`. That file runs `create or replace` on an existing function, which keeps the earlier ACL, and on the local database `anon` can't execute it. The guard can't tell a replacement from a new function, so this is a false positive.

**The two `b` migrations the CLI skips change nothing on a database built from the repo.** A scratch database built with every file in filename order, the `b` files included, had the same policies, functions, function ACLs and RLS flags as the CLI-built one.

- `00000000000033b_classroom_rls_fix_recursion.sql` is a back-port of a production hotfix (`20260424170256`). It drops two policies that only production had (`Professors can view enrollments in their sections` on `enrollments`, `Students view sections they are enrolled in` on `course_sections`), then recreates the helpers and policies that `32` and `33` already create, with the same names and bodies. On a database built from the repo it fails at `CREATE POLICY "Students view enrolled sections"` (already exists) and rolls back. If the two recursive policies are put back on the local database, `select count(*) from course_sections` as `authenticated` fails with `infinite recursion detected`. Without them it runs.
- `00000000000037b_lc_drawings_drop_old_overload.sql` runs `DROP FUNCTION IF EXISTS lc_send_event(uuid, text, jsonb, boolean)`, the same statement as line 16 of `37`. It is a no-op. One `lc_send_event` exists, the 5-argument one. A 3-argument call resolves to it, and with the 4-argument overload added back the same call fails with `is not unique`.

Git history starts at the repo's initial commit, so it can't show when they were applied. `00000000000069` cites "32 / 33 / 33b" as existing policies, and `00000000000070_reconcile_prod_schema_drift.sql`, which copied prod-only objects from production, added no policy on either table. That suggests production no longer had the recursive policies by then. No new migration is needed. The files are left as they are.

Run these on production and staging (read-only) to confirm:

```sql
-- Which hotfix versions are recorded
select version from supabase_migrations.schema_migrations
where version like '00000000000033%' or version like '00000000000037%' or version = '20260424170256'
order by version;

-- Expected: exactly the five policies a repo build has. Neither recursive policy name may appear.
select tablename, policyname, cmd, roles, qual from pg_policies
where schemaname = 'public' and tablename in ('enrollments', 'course_sections')
order by 1, 2;

-- Expected: three rows, all prosecdef = true
select p.oid::regprocedure, p.prosecdef, p.proconfig from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('is_professor_of_section', 'is_enrolled_in_section', 'is_staff_of_section');

-- Expected: one row, lc_send_event(uuid,text,jsonb,boolean,boolean)
select p.oid::regprocedure from pg_proc p where p.proname = 'lc_send_event';

-- Expected: false after 20261002200100 is applied
select has_function_privilege('anon', 'public.roadmap_set_node_checkoff(uuid,uuid,text,boolean)', 'execute');
```

The five policies a repo build has: `course_sections` "Professors view own sections", "Staff view assigned sections" and "Students view enrolled sections"; `enrollments` "Professors view enrollments in their sections" and "Students can view own enrollments". Any other policy on these tables whose `qual` queries the other table directly is a recursion risk, so check it before applying anything.
