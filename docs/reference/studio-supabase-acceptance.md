# Studio Supabase Acceptance Checklist

Steps 2 and 3 of Studio were verified on a machine that can't run local Supabase. Run this once on a machine that can. If every step passes, Step 2 and Step 3 change from **complete locally** to **fully accepted**, with no redesign. What was and wasn't verified is in the Verification sections of [studio-plugin-storage.md](./studio-plugin-storage.md) and [studio-plugin-server.md](./studio-plugin-server.md).

Use the local stack only. Never point any of this at production.

1. **Start local Supabase:** `supabase start`
2. **Apply all migrations:** `supabase migration up`. It must include `20260930175948_studio_plugin_storage.sql`.
3. **Run the database tests:** `npm run test:db`
4. **Run the Studio server-path tests against real PostgREST:** `npx vitest run --config vitest.db.config.ts src/__tests__/db/studio-storage.test.ts src/__tests__/db/studio-server-path.test.ts`
5. **Regenerate the types:** `npx supabase gen types typescript --local > src/lib/supabase/types.ts`. Confirm the five `studio_plugin_*` tables appear.
6. **Typecheck:** `npm run typecheck`
7. **Run the database advisors:** the Security and Performance advisors in local Supabase Studio (http://127.0.0.1:54323, Advisors). Expect no new findings for `studio_plugin_*` tables or `studio_*` functions.
8. **Confirm no new Studio failures:** `npm run test`. Any failure in a `studio-*` test file, or in `migration-guards`, that names a Studio file blocks acceptance. Failures that predate Studio are listed in the storage doc's Verification section.
