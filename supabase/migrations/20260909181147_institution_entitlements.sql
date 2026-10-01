-- Feature entitlements: what an institution has bought.
--
-- Two things live here:
--   1. set_institution_entitlements, the only write path for
--      institutions.settings.entitlements (super admin only).
--   2. institution_feature_requests, where an institution admin asks for a
--      feature they do not have and a super admin approves or declines.
--
-- Entitlement is a COMMERCIAL control, not a tenant boundary. Row-level
-- security still owns tenancy and is untouched by this migration. See
-- docs/designs/entitlements/feature-entitlements.md.

-- ---------------------------------------------------------------------------
-- 1. The write path
-- ---------------------------------------------------------------------------

-- Mirrors set_institution_ai_policy: role check first, shape validation, then
-- an optimistic version guard under a row lock. Version is stamped by the
-- function and never accepted from the client.
CREATE OR REPLACE FUNCTION public.set_institution_entitlements(
  p_institution_id uuid,
  p_config jsonb,
  p_expected_version integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current jsonb;
  v_current_version integer;
  v_new_version integer;
  v_new_config jsonb;
  v_key text;
BEGIN
  -- Only Scholera staff grant or revoke. An institution admin can request a
  -- feature (see the table below) but can never entitle themselves.
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'invalid_config';
  END IF;

  -- Reject unknown top-level keys so a hand-crafted call cannot smuggle state
  -- into the blob. 'version' is deliberately absent: the function owns it.
  IF (p_config - 'granted' - 'revoked' - 'pendingRevocation') <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_config';
  END IF;

  IF p_config ? 'granted' AND jsonb_typeof(p_config->'granted') <> 'array' THEN
    RAISE EXCEPTION 'invalid_config';
  END IF;
  IF p_config ? 'revoked' AND jsonb_typeof(p_config->'revoked') <> 'array' THEN
    RAISE EXCEPTION 'invalid_config';
  END IF;
  IF p_config ? 'pendingRevocation' AND jsonb_typeof(p_config->'pendingRevocation') <> 'object' THEN
    RAISE EXCEPTION 'invalid_config';
  END IF;

  IF jsonb_array_length(COALESCE(p_config->'granted', '[]'::jsonb)) > 32
     OR jsonb_array_length(COALESCE(p_config->'revoked', '[]'::jsonb)) > 32 THEN
    RAISE EXCEPTION 'invalid_config';
  END IF;

  -- Format check only. The TypeScript registry in
  -- src/lib/entitlements/entitled-features.ts is the actual key whitelist, and
  -- the parser drops anything it does not recognise.
  FOR v_key IN
    SELECT jsonb_array_elements_text(COALESCE(p_config->'granted', '[]'::jsonb))
    UNION ALL
    SELECT jsonb_array_elements_text(COALESCE(p_config->'revoked', '[]'::jsonb))
    UNION ALL
    SELECT jsonb_object_keys(COALESCE(p_config->'pendingRevocation', '{}'::jsonb))
  LOOP
    IF v_key !~ '^[a-z][a-z0-9-]{0,63}$' THEN
      RAISE EXCEPTION 'invalid_config';
    END IF;
  END LOOP;

  -- A key cannot be granted and revoked at once. Silently preferring one would
  -- make the stored config disagree with what the admin saw when they saved.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(COALESCE(p_config->'granted', '[]'::jsonb)) AS g(k)
    WHERE g.k IN (
      SELECT jsonb_array_elements_text(COALESCE(p_config->'revoked', '[]'::jsonb))
    )
  ) THEN
    RAISE EXCEPTION 'invalid_config';
  END IF;

  SELECT settings->'entitlements' INTO v_current
  FROM public.institutions
  WHERE id = p_institution_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  v_current_version := COALESCE((v_current->>'version')::integer, 1);
  IF p_expected_version IS DISTINCT FROM v_current_version THEN
    RAISE EXCEPTION 'version_conflict';
  END IF;

  v_new_version := v_current_version + 1;
  v_new_config := jsonb_build_object(
    'granted', COALESCE(p_config->'granted', '[]'::jsonb),
    'revoked', COALESCE(p_config->'revoked', '[]'::jsonb),
    'pendingRevocation', COALESCE(p_config->'pendingRevocation', '{}'::jsonb),
    'version', to_jsonb(v_new_version)
  );

  -- Write ONLY the entitlements key. jsonb_set creates just the last path
  -- element, so settings must exist first; this is what preserves the sibling
  -- ai.* layers (the kill switch) and selfUnenroll.
  UPDATE public.institutions
  SET settings = jsonb_set(
        COALESCE(settings, '{}'::jsonb),
        '{entitlements}',
        v_new_config,
        true
      ),
      updated_at = now()
  WHERE id = p_institution_id;

  RETURN v_new_version;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_institution_entitlements(uuid, jsonb, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_institution_entitlements(uuid, jsonb, integer) TO authenticated;

COMMENT ON FUNCTION public.set_institution_entitlements(uuid, jsonb, integer) IS
  'Super-admin-only write path for institutions.settings.entitlements. Stamps its own version; '
  'callers pass the version they read and get version_conflict if it moved.';

-- ---------------------------------------------------------------------------
-- 2. The request queue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.institution_feature_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  feature_key text NOT NULL CHECK (feature_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  requested_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  message text CHECK (message IS NULL OR length(message) <= 2000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR length(review_note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One open request per feature per institution. Approved and declined rows stay
-- as history and do not block a later request.
CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_requests_pending_unique
  ON public.institution_feature_requests(institution_id, feature_key)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_feature_requests_queue
  ON public.institution_feature_requests(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feature_requests_institution
  ON public.institution_feature_requests(institution_id);

DROP TRIGGER IF EXISTS trg_feature_requests_touch ON public.institution_feature_requests;
CREATE TRIGGER trg_feature_requests_touch
  BEFORE UPDATE ON public.institution_feature_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.institution_feature_requests ENABLE ROW LEVEL SECURITY;

-- Institution admins see their own tenant's requests.
DROP POLICY IF EXISTS feature_requests_select_own_tenant ON public.institution_feature_requests;
CREATE POLICY feature_requests_select_own_tenant
  ON public.institution_feature_requests FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid())
        AND p.role = 'institution_admin'
        AND p.institution_id = institution_feature_requests.institution_id
    )
  );

-- Scholera staff see every tenant's.
DROP POLICY IF EXISTS feature_requests_select_super_admin ON public.institution_feature_requests;
CREATE POLICY feature_requests_select_super_admin
  ON public.institution_feature_requests FOR SELECT
  USING (public.is_super_admin());

-- An institution admin can open a request, only for their own tenant, only as
-- themselves. WITH CHECK re-verifies both so a forged institution_id or
-- requested_by is rejected at the database rather than trusted from the client.
DROP POLICY IF EXISTS feature_requests_insert_own_tenant ON public.institution_feature_requests;
CREATE POLICY feature_requests_insert_own_tenant
  ON public.institution_feature_requests FOR INSERT
  WITH CHECK (
    requested_by = (select auth.uid())
    AND status = 'pending'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid())
        AND p.role = 'institution_admin'
        AND p.institution_id = institution_feature_requests.institution_id
    )
  );

-- Withdrawing an open request. Only the person who opened it, only while it is
-- still pending.
DROP POLICY IF EXISTS feature_requests_delete_own_pending ON public.institution_feature_requests;
CREATE POLICY feature_requests_delete_own_pending
  ON public.institution_feature_requests FOR DELETE
  USING (requested_by = (select auth.uid()) AND status = 'pending');

-- Only Scholera staff approve or decline.
DROP POLICY IF EXISTS feature_requests_update_super_admin ON public.institution_feature_requests;
CREATE POLICY feature_requests_update_super_admin
  ON public.institution_feature_requests FOR UPDATE
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

COMMENT ON TABLE public.institution_feature_requests IS
  'An institution admin asking Scholera for a feature their plan does not include. '
  'Approving one calls set_institution_entitlements; the row itself never grants anything.';
