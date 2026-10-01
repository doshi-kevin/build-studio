# Super Admin Team

Lets the platform vendor (Scholera) team grow itself up to 5 super admins, with one designated as the **platform owner** — the topmost role that cannot be removed by other super admins.

| Path | Purpose |
|------|---------|
| `page.tsx` | Server component. Lists super admins (owner first), passes them + the current user's ownership state to `SuperAdminTeamView`. |
| `actions.ts` | Server actions: `inviteSuperAdmin`, `resendSuperAdminInvite`, `revokeSuperAdmin`, `transferPlatformOwnership`. All gated by `verifySuperAdmin()`. |

## Platform owner

- Stored as `profiles.is_platform_owner BOOLEAN` (mig 50).
- Partial unique index ensures **at most one owner** at a time.
- CHECK constraint ensures the owner is always a `super_admin` (no silent demotion leaving an inconsistent state).
- Initial owner: `patelharshil@scholera-inc.com`, backfilled by mig 50.

## Transfer flow

The current owner can transfer ownership to any accepted super admin. The action runs two updates in sequence — demote self first (frees the unique index slot), then promote target. If the second update fails, the first is rolled back so the platform never ends up ownerless. If both rollbacks fail (extremely unlikely), the error message tells the operator to contact support — recovery is via direct SQL.

## Cap behavior

The 5-cap counts pending + accepted to prevent a flood of unaccepted invites. Revoke a pending invite to free a slot.
