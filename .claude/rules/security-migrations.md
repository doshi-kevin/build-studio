---
paths:
  - "supabase/migrations/**/*.sql"
---

# Security Rules — Database Migrations

This stack (Postgres reachable from the browser via the public anon key) makes Row-Level Security the **last line of defense** against cross-tenant data leaks. A new table without RLS is a data-leak bug, not a style nit. (See `docs/research/ai-coding-assistant-security-threats.md` — missing RLS is the #1 breach vector for this exact architecture.)

## Non-negotiable checklist for every migration

- [ ] **Enable RLS in the same migration that creates the table.** Every `create table` MUST be followed by `alter table <t> enable row level security;`. No table ships without it.
- [ ] **Add at least one policy** — a table with RLS on but no policy denies everyone (silent breakage), and a table with RLS off exposes everyone (breach).
- [ ] **Scope every policy by `institution_id` AND role.** Never write a policy that returns rows to `anon`, or to any authenticated user unconditionally.
- [ ] **Tenant-scoped tables carry `institution_id`** (`not null`), and writes must set it — forgetting it leaks data across institutions.
- [ ] **No SQL built by string concatenation** in functions/triggers — use parameterized/quoted identifiers.

## The one exception to "at least one policy": server-only tables

A table that **no client ever reads or writes** may have RLS enabled with no policies at all, instead of a policy nobody needs. This is an established pattern, not a loophole: `project_proposal_applications`, the Studio plugin tables, and the 21 tables in `20260915154556_revoke_authenticated_writes_on_policyless_tables.sql`. It's allowed only when all of these hold:

- [ ] RLS is enabled in the same migration, so the default is deny.
- [ ] Client privileges are revoked explicitly: `revoke all on <t> from public, anon, authenticated;` then `grant all on <t> to service_role;`. With both locks in place, a permissive policy added later by mistake still can't open the table on its own.
- [ ] Every read and write goes through the trusted server path (a server action or route using the admin client after `getAuthUser` and the ownership or section check). No browser or cookie-based client touches the table.
- [ ] The migration comment says the table is server-only on purpose, so a reviewer knows the missing policy was deliberate.
- [ ] Functions that write these tables revoke `execute` from `public, anon, authenticated` and grant it to `service_role`.

If any client ever needs to read the table, it stops being server-only: add a scoped `FOR SELECT` policy per the rules above.

## Policy command scope — `FOR ALL` is a write hole

A client-reachable table the app writes to ONLY via the admin client must get a **read-only (`FOR SELECT`) policy** for the `authenticated`/`anon` role — never `FOR ALL`. Supabase grants DML to those roles by default, so a `FOR ALL` policy whose check is just `owner_id = auth.uid()` lets that owner write **any column** through a direct PostgREST call from the browser, bypassing your server-action checks entirely (e.g. a student setting their own `status='graded', score=<max>` to self-grade). If there is no client write path, make the policy `SELECT`-only; if clients do write, the `WITH CHECK` must constrain **every mutable column**, not just the owner id. Always check each client-reachable table's policy **command scope**, not just that a policy exists. (Real incident: PR #198.)

## Pattern to follow

Read a recent sibling migration in `supabase/migrations/` that creates a table and copy its RLS + policy shape exactly. Match the existing `using (...)` / `with check (...)` predicates that scope by `institution_id` and the caller's role/membership.

If a table is genuinely global/non-tenant (rare), still enable RLS and write an explicit read-only policy — then say so in the migration comment so the reviewer knows it was deliberate, not forgotten.
