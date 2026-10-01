---
paths:
  - "src/app/**/actions.ts"
  - "src/app/**/route.ts"
  - "src/lib/**/actions.ts"
---

# Security Rules — Server Actions & Route Handlers

**Assume every action and route is called UNAUTHENTICATED by an attacker, with arbitrary arguments.** If calling it without a valid session — or with someone else's IDs — does anything, it's a Broken Access Control / IDOR bug (OWASP API #1, the most consequential class for this app). The client is untrusted: never rely on hidden fields, disabled buttons, or client-side filtering for authorization.

## Required sequence (every mutating action)

1. **Authenticate** — `const supabase = await createClient()` then `await supabase.auth.getUser()`. Reject if no user. (`createClient` is from `@/lib/supabase/server` and MUST be `await`ed.)
2. **Authorize — verify role AND tenant ownership before the DB op:**
   - Role: `verifySuperAdmin()` / `verifyInstitutionAdmin()` / `verifySectionAccess()` from `@/lib/auth/*`.
   - Object ownership (prevents IDOR): `assertTenantOwns()` / `assertTenantOwnsVia()` from `@/lib/auth/assert-tenant-owns` — confirm the *specific* row the caller passed belongs to their institution. Verifying role alone is NOT enough; a valid professor can still pass another tenant's `id`.
3. **DB op** — use `createAdminClient()` from `@/lib/supabase/admin` only AFTER the checks above pass.
4. **Log** — `logEvent()` from `@/lib/supabase/event-logger` for every mutation (audit/analytics).
5. **Revalidate** — `revalidatePath()` from `next/cache`.

## Input handling

- **Validate all external input** (form fields, params, body) with the existing Zod schema in `src/lib/validations/` before use — do not trust shape or type from the client.
- Return `{ error: 'message' }` or `{ success: true }` — never throw, never leak internal errors/stack traces to the client.

## Multi-tenant writes

- Every tenant-scoped insert/update MUST set `institution_id` from the *verified* context — never from a client-supplied value.

If you cannot satisfy the authorize step (e.g. no ownership helper fits), STOP and flag it — do not ship "we'll add the check later."
