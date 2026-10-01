-- Tenant isolation for feedbacks. feedbacks rows are submitted by users via
-- the FeedbackWidget; institution_admin reads them at /admin/feedback. Without
-- institution_id, an admin sees feedback from every customer.
--
-- Strategy: backfill from the submitter's profile.institution_id, then enforce
-- NOT NULL going forward. Same pattern as the Phase 1 backfill on profiles.

BEGIN;

ALTER TABLE public.feedbacks
  ADD COLUMN IF NOT EXISTS institution_id uuid
    REFERENCES public.institutions(id) ON DELETE RESTRICT;

UPDATE public.feedbacks f
SET institution_id = p.institution_id
FROM public.profiles p
WHERE p.id = f.user_id
  AND f.institution_id IS NULL;

-- If any feedback is left with no institution (orphan / deleted user), drop to
-- Stevens as the legacy default. Same fallback rationale as Phase 1.
UPDATE public.feedbacks
SET institution_id = '00000000-0000-0000-0000-000000000001'
WHERE institution_id IS NULL;

ALTER TABLE public.feedbacks ALTER COLUMN institution_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feedbacks_institution ON public.feedbacks(institution_id);

COMMIT;
