-- Platform owner concept for the super_admin tier.
--
-- Mirrors the institution_admin co-invite feature (5-cap, invite/resend/
-- revoke), but at the platform level. Adds a single "platform owner" who
-- cannot be removed by other super_admins — only the owner can transfer
-- ownership to another super_admin. Modeled on GitHub org owners / GCP
-- project owners.
--
--   • is_platform_owner BOOLEAN — at most one row TRUE across the table
--   • partial unique index enforces "at most one owner"
--   • CHECK constraint enforces "owner must be super_admin" (no silent
--     downgrade leaving the owner row in an inconsistent state)
--   • Backfill: the existing super_admin (patelharshil@scholera-inc.com)
--     becomes the initial platform owner.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_platform_owner BOOLEAN NOT NULL DEFAULT false;

-- At-most-one platform owner. Partial unique index over a constant so two
-- TRUE rows would conflict; FALSE rows are excluded by the predicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_platform_owner
  ON public.profiles ((1))
  WHERE is_platform_owner = true;

-- The owner must be a super_admin. Prevents a state where the owner flag
-- is true but the role has been demoted, which would let a non-super_admin
-- block ownership transfer forever.
ALTER TABLE public.profiles
  ADD CONSTRAINT platform_owner_must_be_super_admin
  CHECK (NOT is_platform_owner OR role = 'super_admin');

-- Backfill the existing sole super_admin as the initial platform owner.
UPDATE public.profiles
   SET is_platform_owner = true
 WHERE role = 'super_admin'
   AND email = 'patelharshil@scholera-inc.com';

COMMIT;
