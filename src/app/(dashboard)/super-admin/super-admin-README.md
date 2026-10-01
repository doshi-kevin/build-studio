# Super Admin Folder

Routes for the Scholera platform-vendor admin (the team operating Scholera itself, not a customer institution). Phase 1 only ships institution provisioning + listing — RLS hardening, audit log UI, impersonation, and AI cost dashboards are deferred.

| Path | Purpose |
|------|---------|
| `layout.tsx` | Role guard. Renders Access Denied for anyone except `profile.role === 'super_admin'`. Mirrors `/admin/layout.tsx`. |
| `page.tsx` | Institutions list view. Shows name, slug, status, total users, admin count (with `⚠ No admin assigned` badge if zero), creation date, and a Create Institution CTA. |
| `institutions/new/page.tsx` | Create Institution form page. Wraps `CreateInstitutionForm` (client component). |
| `institutions/actions.ts` | Server actions. `createInstitution(input)` validates with Zod, optionally invites a primary institution_admin via the temp-password flow, logs an `institution.created` event, and revalidates `/super-admin`. |

## Auth model

Three layers, in order:
1. `middleware.ts` — redirects unauthenticated users to `/login`
2. `super-admin/layout.tsx` — verifies `role === 'super_admin'`
3. Server actions — independently re-verify role via `verifySuperAdmin()` (defense in depth, since `createAdminClient()` bypasses RLS)

## Reading material

- `docs/designs/platform/` — platform-wide governance designs (roster import, AI kill switch). The
  `docs/super-admin-feature.md` design plan this used to cite was never committed.
- `supabase/migrations/00000000000044_institutions_phase1.sql` — schema migration that introduced the `institutions` table and the `super_admin` role.
