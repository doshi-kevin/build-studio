# Studio Supabase Acceptance Checklist

Which database each file and tool touches, and how to check, is in the "Which database am I about to touch?" table in [scripts/README.md](../../scripts/README.md). Step 8B ran every database test on the native PostgreSQL 17.6 and PostgREST 16.4 stand-in on loopback, with its URL and keys passed to the test process explicitly. Nothing in 8B touched a hosted project.

Studio Steps 2 to 6 were verified on a machine that can't run local Supabase. The database tests ran on PGlite, an in-process Postgres, through a stand-in for the Supabase client. That is secondary evidence: it runs the real migrations and triggers, but not PostgREST, roles or concurrency. Run this once on a machine that can. If every step passes, they change from **complete locally** to **fully accepted**, with no redesign. What was and wasn't verified is in the Verification sections of [studio-plugin-storage.md](./studio-plugin-storage.md) and [studio-plugin-server.md](./studio-plugin-server.md), and in [studio-plugin-publication.md](./studio-plugin-publication.md) and [studio-plugin-validator.md](./studio-plugin-validator.md).

Passing this checklist is necessary, not sufficient, for turning on student access in production. The full list is the publication doc's [release gate](./studio-plugin-publication.md#release-gate).

Use the local stack only. Never point any of this at production.

1. **Start local Supabase:** `supabase start`
2. **Apply all migrations:** `supabase migration up`. It must include `20260930175948_studio_plugin_storage.sql`, `20261001181829_studio_publication.sql`, `20261001192059_studio_student_quota.sql`, `20261001202323_studio_validator.sql`, `20261002160000_studio_builder.sql` and `20261002210000_studio_project_memory.sql` (project memory: one new server-only table and five functions, nothing replaced) and `20261002230000_studio_memory_slots.sql` (adds `slot_key`, moves every existing decision to its topic's `general` slot, makes uniqueness per slot, and replaces `studio_memory_propose` and `studio_memory_save` with versions that take the slot; confirm the old ten- and seven-argument versions are gone). The builder migration replaces `studio_activate_version` and `studio_set_student_visibility` with versions that take one more argument (the state the server checked); confirm the old four-argument functions are gone. Steps 9 and 10 add `20261003003000_studio_course_context.sql` (the `studio_course_*` and `studio_material_*` functions, `material_sources` and `material_incomplete` on projects and versions, and a replacement `studio_builder_end`) and `20261003020000_studio_release.sql` (dispatch columns on `studio_plugin_validations`, a replacement validations guard, `studio_validation_dispatch`, `studio_runtime_admit`, `studio_purpose_admit`, `studio_set_min_accepted_ruleset`, `updated_by` on `studio_validator_settings`, and four indexes). Confirm `studio_set_min_accepted_ruleset` is the only one of these granted to `authenticated`, and none to `anon`. Step 11 adds `20261003120000_studio_builder_quality.sql`. It replaces `studio_records_guard`, `studio_records_track_usage` and `studio_builder_end`, adds `handle_salt` to installations with a trigger that keeps it fixed, sample data on snapshots, the `reviewing` and `improving` phases, and `v2` as a bridge and runtime version. Confirm the three trigger functions are revoked from `anon` and `authenticated`, and `studio_builder_end` is granted only to `service_role`.
3. **Run the database tests:** `npm run test:db`
4. **Run the Studio server-path, bridge and publication tests against real PostgREST:** `npx vitest run --config vitest.db.config.ts src/__tests__/db/studio-storage.test.ts src/__tests__/db/studio-server-path.test.ts src/__tests__/db/studio-bridge-dispatch.test.ts src/__tests__/db/studio-publication.test.ts src/__tests__/db/studio-validator.test.ts src/__tests__/db/studio-builder.test.ts src/__tests__/db/studio-builder-budgets.test.ts src/__tests__/db/studio-builder-memory.test.ts src/__tests__/db/studio-course-context.test.ts src/__tests__/db/studio-builder-upkeep.test.ts`. The budgets suite holds the builder's real-concurrency tests (racing starts at each cap, Stop against a commit, stale claim tokens, two commits from one revision, the commit lock order, concurrent saves of one draft); like the undo race in the builder suite, they skip on PGlite. The builder suite drives one whole build through the real harness and check worker with a scripted model; no model is called. On real Postgres the two concurrency tests run too ("two concurrent writers can't both take the last slot" and "two concurrent writes by one student can't both take their last slot"); on the PGlite stand-in they are skipped, so they have never run. If the fixture has a `super_admin` profile, the kill switch function test and the validator's review tests run (a super admin's approval, and a super admin refused for their own version); otherwise they skip, and those need a manual check as a super admin. On PGlite they ran, against a stand-in super admin.
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

## Steps 9 and 10 local run (2026-10-02)

On the same native PostgreSQL 17.6 and PostgREST 16.4 stand-in, with its loopback URL and keys passed to each process explicitly and no `.env` file loaded:

| Check | Result |
|---|---|
| Migrations | `20261003003000_studio_course_context.sql` and `20261003020000_studio_release.sql` applied on top of the earlier ones, and re-applied cleanly (both are safe to run twice) |
| `npm run test:db` | 323 of 323, with a super admin in the fixture. Step 10's block covers racing admissions for the last slot, the system lane, the daily cap counting plugin-caused errors but not platform errors, the global cap, write-once dispatch, the guard on dispatch fields and the nonce hash, the review queue's SQL filter, the one-step ruleset raise, and the grants on every new function |
| Mutations | 49 for Step 10 (TypeScript and SQL), each removing one safeguard, each caught by a test. 35 for Step 9, each caught |
| Browser walkthrough | `e2e/visual/studio-release.md`: 40 of 41 on the guarded production build. The failure is the course header's contrast, outside Studio |

The Step 10 runner job, its network isolation and Chromium's sandbox on Cloud Run gen2 need a GCP project and haven't run. Real Supabase (GoTrue, Storage, the Supabase image's roles, advisors and type generation) still hasn't run either.

## Step 11 closure (2026-10-06)

**Step 11 is locally accepted.** Steps 1 to 11 are built and pass every test that can run on a machine without Docker, a GCP project or a production key. Step 12 (Generation Intelligence) can start. The items under "Still needed outside this machine" don't block Step 12. They block production release and turning on student access, as the [release gate](./studio-plugin-publication.md#release-gate) already says.

What ran, on the same native PostgreSQL 17.6 and PostgREST 16.4 stand-in, with its loopback URL and keys passed to each process and no `.env` file loaded:

| Check | Result |
|---|---|
| Studio unit tests (`studio-*` and `actions-prof-studio-*`) | 2,036 of 2,036 in 60 files. The closure added about 115 regression tests for gaps an audit found, each reviewed for whether it fails when its protection is removed |
| `npm run test:db` | 350 of 350 in 14 files, `studio-publication` included |
| `npm run e2e:studio-runtime` | 141 of 141: Chromium, Firefox and WebKit, the hostile probe on runtime `v1` and `v2` |
| `npm run e2e:studio-validator` | 15 of 15, including a `v2` tool, a crash in only the professor view, and missing loading, empty and error states |
| Typecheck and lint | Clean |
| Live build | On the guarded local server with a dedicated non-production key: an attendance build asked for the class list and staff-written records, passed its checks and the design review (rendered), and showed both previews. A follow-up added a status to the same draft (draft revision 2, Undo pointing at the first). $0.31 for both |

Four bugs were found and fixed in this pass:
- The builder could still commit a draft after a gate refusal: Studio paused, the entitlement or AI switch turned off, the professor lost the section, or the project was archived. The gate (all but the daily spend limit) now runs once more right before every commit.
- A plugin frame could flood roster or size messages. Each was parsed and dropped, and the frame ran on. Messages over the bound now count toward the same per-minute limit as refused calls, and a frame that keeps flooding is stopped.
- The draft gate threw on a capability missing from the registry instead of reporting it.
- The Stage 2 runner named a missing state with a stray quote (`no "error state`).

### Still needed outside this machine

Each needs something this machine doesn't have. None changes the design.

1. **Real Supabase.** No Docker or Supabase CLI here, so Supabase's own image (roles, extensions, GoTrue, Storage, advisors, type generation) has never run. On a machine with both, run steps 1 to 9 above. Pass: every step passes and the advisors report nothing new for `studio_*`.
2. **The Stage 2 runner on GCP.** The image has never been built or deployed. It needs a GCP project and approval to deploy. Run `node validator-runtime/build.mjs --out <tmp>` and confirm `<tmp>/studio-runtime/v2/` matches `public/studio-runtime/v2/`. Then run `bash infra/validator-runner/deploy.sh --project <id>` as a dry run, then with `--apply`, and set the six `STUDIO_VALIDATOR_*` values it prints on the app. On staging, add them to the `--set-env-vars` list in `infra/app/deploy-to-staging.sh` first, because that deploy removes every variable not on its list. Pass: the job checks in [studio-plugin-validator.md](./studio-plugin-validator.md) ("Pending before students can use Studio") hold, and a builder-made `v2` version passes Stage 2 with runner mode `cloud`.
3. **Staging.** It needs the staging project. Deploy with `infra/app/deploy-to-staging.sh`, then run `e2e/visual/studio-builder.md`, `studio-publication.md` and `studio-release.md` there, and the isolation probes against the deployed origins (release gate item 7). Start one build that runs past five minutes. Pass: every walkthrough passes, and the long build ends Preview ready after handing off to a second slice (`slice_no` 2 or more on its run row).
4. **The deployed Gemini key.** The AI purpose check and the builder on staging use the deployed secret, which must never be used locally. Pass: on staging, saving a version gets its purpose verdict from the classifier, not from a reviewer for want of a key.
5. **A screen reader.** None on this machine. With NVDA or VoiceOver, run section E of `e2e/visual/studio-builder.md` and read a plugin in both views. Pass: the announcements listed there, once each.

Out of Step 11's scope, so not pending: a production design-review renderer (deployed builds review the code without screenshots), any check that clicks through a plugin (neither Stage 2 nor the design review does), and a Bridge method for `course.weakSpots`, which stays registered and refused.

Open before student access, unchanged by this pass: rule N9 in [studio-plugin-rules.md](./studio-plugin-rules.md). A plugin can navigate its own frame to a URL carrying data. The host detects it only after the request has left, and the closure audit confirmed the name-based static scan can be routed around. The rules record whether a professor view, which reads every student's records by handle, may hold that data as an open decision.

## Paused after Step 12A.3 evaluator engineering (2026-10-07)

**Studio work is paused here.** Step 12A built a way to measure how good the builder's plugins are as products. Its evaluator is engineered and frozen. Human calibration was deliberately not done, and nothing in Step 12A changed the builder.

Done, on branch `feature/studio-generation-quality-eval` (last evaluator commit `b787b030`):

| Step | State |
|---|---|
| 12A.1 | The quality contract: rubric, cases, judge rules |
| 12A.2 | The framework in `eval/studio-quality/` (`05a983e0`) |
| 12A.3 | Evaluator engineering. Live judge on Gemini, contrast pairs, repeatability, limited live builds. Tier 2 cases added (`bae1ac1b`). The judge is grounded in what each screen actually renders (`f36305fc` and fixes), anchors every evidence source and measures cramped phone layouts (`031981a4`), and scores workflow completeness none when a requested role's core action is absent (`b787b030`) |
| 12A.3 human calibration | Deferred on purpose. The blind pack's human score sheet is blank (0 of 72). A scoring by another AI model is kept only as a cross-model reference |
| 12A.4 | Not started: the 52-build baseline |

Frozen evaluator:
- Rubric `studio-generation-quality-v1`, weights unchanged since 12A.1.
- Judge `sgq-judge-v5` (`eval/studio-quality/quality-freeze.ts`). Every result has the rendered evidence: what each screen showed, read from the live DOM, and checks for anything the source claims that never rendered.
- Suite: 28 cases. Tier 1 has 20 core workflows (6 holdout). Tier 2 has 8 deeper product cases (D02, D05 and D06 sealed). 6 variance cases.
- The sealed calibration key is `tmp/studio-quality/calibration/sealed/pack-key-final.json` (local, gitignored). All eight pack items were judged by the final evaluator.

Unchanged by Step 12A: the builder, its instructions, review instructions, model and thinking level, ScholeraKit, the runtime and the validator. No file under `src/lib`, `src/app`, `src/components`, `validator-runtime` or `supabase` changed after `05a983e0`, and the Step 11 freeze test still passes.

Checks at the pause: Studio unit tests 2,172 of 2,172 in 67 files; typecheck and lint clean. No live model call is part of these checks.

Found and recorded, not fixed (the runtime is frozen for Step 12A): the kit drops RosterTable columns whose keys aren't camelCase, so a plugin can lose its main controls while passing the draft gate and Stage 2. The evaluator now penalizes the broken result.

### Next product direction

When work resumes, the goal is not better attendance trackers, forms, queues or other record-keeping tools. Studio should understand a professor's teaching problem, course and constraints, then invent and build domain-specific educational software the professor may not have thought to ask for. Examples:
- chemistry lab companions, and reaction or equilibrium reasoning tools;
- physics prediction and simulation activities;
- circuit debugging and experimental reasoning;
- proof, strategy and counterexample tools in mathematics;
- choosing a statistical test, and designing an experiment;
- valuation, DCF, portfolio and scenario simulators in finance;
- staged case studies;
- loops where students predict, commit, see the result and reflect;
- tools that expose misconceptions rather than store records.

The intended shape, not yet designed or built:
1. Read the professor and course context, and understand the teaching problem.
2. Generate several genuinely different software concepts.
3. Critique them for product quality and pedagogy, and choose the strongest one the platform can build.
4. Design the learning loop, then the professor's workflow, the student's workflow, the data model and the interface.
5. Implement it.
6. Render, review and repair.
