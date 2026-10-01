---
paths:
  - "src/app/**/actions.ts"
  - "src/app/**/route.ts"
  - "src/lib/**/actions.ts"
  - "supabase/migrations/**/*.sql"
---

# Data Access Rules — Concurrency, Idempotency & Performance at Scale

These rules govern how DB-touching code behaves under **concurrent requests, retries, and growing
per-tenant data** — correctness problems that pass review, pass in dev with 10 rows, and corrupt
prod under load. Authz, RLS existence, tenant-write provenance, secrets, and XSS live in the
`security-*.md` rules — do not restate them here.

Every `await` is a yield point: two double-clicks, two tabs, or a retried request can interleave
between your statements. Code that reads, decides in JS, then writes is racy by default.

## Concurrency / TOCTOU — make read-decide-write atomic
- **Never `SELECT`-then-decide-then-write across separate awaits when the read guards the write.**
  Two concurrent calls both pass the `if` before either writes. Push the decision into the DB.
  - ❌ count enrollments, `if (count < cap)` then `insert` — two students race past a full cap.
  - ✅ a guarded `UPDATE ... WHERE seats_taken < cap` (branch on rows-affected), a partial
    unique/exclusion constraint, or an RPC that `SELECT ... FOR UPDATE`s the section row.
- **Conditional state transitions go in the `WHERE`, then branch on rows-affected.**
  - ✅ `update({status:'graded',score}).eq('id',id).eq('status','pending')` → 0 rows = already
    finalized. Same shape for quiz finalize, invite accept, payment capture.
- **Can't fit one statement? lock or version-guard** — `SELECT ... FOR UPDATE` (+ `SKIP LOCKED`
  for claim-a-job), or an optimistic `version`/`updated_at` column with reload-retry on 0 rows.
- **Multi-statement all-or-nothing work goes in one RPC.** supabase-js does NOT wrap multiple
  `.from(...)` calls in a transaction — put dependent writes in a `plpgsql` function via `.rpc()`.

### Edit forms: the `updated_at` guard is the house convention (#724)

Two people editing one record was silent last-write-wins **with both shown success** — found five
separate times across the codebase (grading + final grades #610, team capacity #698, challenge
submissions #701, every admin edit form #724). It recurs because there was no named convention, so
each fix was local. There is one now — copy it rather than inventing a third shape.

**Every edit form carries the row's `updated_at` and sends it back with the save.** The guard rides in
the `WHERE`, never in a prior read:

```ts
// action — expectedUpdatedAt is the updated_at the form was rendered from
let q = adminDb.from('programs').update(data).eq('id', id)
if (expectedUpdatedAt) q = q.eq('updated_at', expectedUpdatedAt)
const { data: row, error } = await q.select('*').maybeSingle()   // NOT .single()
if (error) return { error: 'Failed to update…' }
if (!row) return { error: 'Someone else changed this while you were editing. …' }
```

- **`maybeSingle()`, not `single()`** — with the guard on, zero rows is the *expected* stale-write
  outcome; `single()` reports it as a DB error and you lose the distinction.
- **Past `assertTenantOwns`, zero rows can only mean the guard fired** — the row is known to exist, so
  no extra existence query is needed to tell "conflict" from "missing".
- **Conflict and failure need different words in front of the user.** Query helpers normally return a
  null fallback; where they take part in this, they return `{ ok: true, data } | { ok: false, reason:
  'conflict' | 'error' }` instead (same shape as `assertTenantOwns`) so the action can say which
  happened. A generic "failed to update" here is the bug, not the fix.
- **A pre-flight compare is not a fix** — read-then-compare-then-write is the same TOCTOU race.
- **The message has to reach the client.** Several actions return `{ error }` that callers discard
  (#607, #611); a conflict swallowed by the caller is indistinguishable from success.
- `updated_at` is safe to guard on because every one of these tables has an `update_*_updated_at`
  trigger calling `update_updated_at()` — **verify the trigger exists before relying on it on a new
  table.** This is not hypothetical: `institutions` had NO such trigger (#742), so the column never
  advanced on UPDATE and a copied guard would have matched forever — a silent non-fix that reads as
  fixed, which is worse than the bug. The fix was a migration adding the trigger FIRST, then the
  guard. `enrollments` has no `updated_at` at all; use a compare-and-swap on `status` there (see
  `dropSection`), which is the right primitive for a one-shot transition anyway.

```sql
-- the check, before you write the guard
select tgname from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where c.relname = '<table>' and not t.tgisinternal;
```

**One-shot actions** (book a slot, claim a job, submit once) use a DB constraint instead, and branch on
`23505`. Reference implementation: `uniq_booking_active_slot` + `createBooking`.

## Tenant-safe upserts
- **Idempotent "create if missing" uses `INSERT ... ON CONFLICT` / `.upsert()`, never a prior
  existence `SELECT`.**
- **Every `ON CONFLICT (cols)` needs a matching `UNIQUE` constraint in a migration — and on
  tenant-scoped tables that key MUST include `institution_id`** (`unique(institution_id, email)`,
  not `unique(email)`). That's the uniqueness key, not the RLS policy `security-migrations.md`
  owns — add both.

## Idempotency — retriable side-effects must dedup before firing
- **Any retriable action with an external/irreversible effect (email, enroll, charge, webhook)
  MUST atomically claim a DB-enforced dedup key before the effect runs** (`INSERT ... ON CONFLICT
  DO NOTHING`, proceed only if a row was created). Tenant-scope it: `unique(institution_id, key)`.
- **Inbound webhooks dedup on the provider's event id** (retention ≥ the provider's retry window).
- **Persist-then-act:** commit the claim row before the irreversible effect (or do both in one txn).

## Performance at scale
- **No N+1** — no awaited query inside a `for`/`map`/`forEach`. One embedded join
  (`select('*, author:profiles(name)')`) or one batched `.in('id', ids)`; bulk `insert([...])`.
  Reuse `src/lib/supabase/queries.ts`. Grep signal: `await supabase` inside a loop body.
- **Independent awaits run in parallel** — `Promise.all`, not back-to-back `await`.
- **Bound every collection read** — explicit `.order()` + `.limit()`/`.range()`, select only needed
  columns. Don't lean on PostgREST's implicit 1000-row cap — it silently truncates.
- **A new filter/sort/join column on a growing table needs a btree index in the same migration** —
  including FK columns (Postgres does NOT auto-index them) and any column an RLS policy filters on.
  Don't over-index tiny tables.
- **In RLS policies wrap `auth.uid()`/`auth.jwt()` in a scalar subquery — `(select auth.uid())`** —
  so the planner runs it once per query, not per row (the `auth_rls_initplan` advisor; 10×+ on big tables).

## Verify, don't assert
Concurrency/idempotency/perf claims need an artifact: the `UNIQUE`/`ON CONFLICT` constraint in the
migration, the guarded `WHERE` + rows-affected branch, the `create index`, or a focused test. After
a migration, run `get_advisors` and confirm it's clean. If a write can't be made atomic or a hot
query can't be indexed, STOP and flag it — don't ship "double-submit is unlikely" or "index later".
