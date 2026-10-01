-- Migration: AI kill switch — platform_settings singleton + set_institution_ai_policy RPC
--
-- Three policy layers, a feature is disabled iff ANY layer disables it:
--   platform_settings.settings.ai            (super admin — ALL institutions, incl. future ones)
--   institutions.settings.ai.platform        (super admin — one institution)
--   institutions.settings.ai.institution     (institution admin — own institution)
-- Layers never mutate each other, so an institution admin's own choices survive a
-- platform/global lock and resume when it lifts. Layer shape (validated below):
--   { "allDisabled": bool, "disabledFeatures": text[], "version": int }
-- version is an optimistic-concurrency guard: the RPC rejects a save whose expected
-- version doesn't match the stored one (stale admin tab), and stamps version+1.
--
-- All writes go through the RPC, called via the RLS-BOUND USER CLIENT — the role
-- check lives in the function itself, so Postgres re-verifies authority even if an
-- action-layer check regresses. The service role never writes these keys.
--
-- Read path: src/lib/ai/kill-switch.ts (fail-closed). Registry of valid feature
-- keys: src/lib/ai/ai-features.ts (TS is the single source of truth; SQL validates
-- shape + size + key format only, and the reader drops unknown keys, so junk from a
-- hand-crafted call is inert).

-- ══════════════════════════════════════════════════════════════════
-- 1. platform_settings — one-row singleton for platform-wide config
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.platform_settings (
  -- Singleton pattern: PK is a bool constrained to true → exactly one row can exist.
  id          BOOLEAN PRIMARY KEY DEFAULT true CHECK (id = true),
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.platform_settings IS
  'One-row singleton for platform-wide (cross-institution) config. Today: settings.ai = the global AI kill-switch layer. Written ONLY by set_institution_ai_policy (super admins). Never park secrets here.';

INSERT INTO public.platform_settings (id, settings)
VALUES (true, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- Super admins may read it client-side; everyone else reaches it only through
-- server code (service role). No INSERT/UPDATE/DELETE policies: the singleton row
-- exists from this migration on, and all writes go through the SECURITY DEFINER RPC.
DROP POLICY IF EXISTS "Super admins can view platform settings" ON public.platform_settings;
CREATE POLICY "Super admins can view platform settings"
  ON public.platform_settings FOR SELECT
  USING (public.is_super_admin());

-- Document the new key on institutions.settings (selfUnenroll precedent).
COMMENT ON COLUMN public.institutions.settings IS
  'Institution-level policy config (selfUnenroll; ai.platform + ai.institution = the AI kill-switch layers, written only via set_institution_ai_policy). READABLE BY EVERY AUTHENTICATED USER of the tenant via the row-level "view own institution" SELECT policy — never park secrets (SSO keys, LTI credentials, API keys) here; use a separate server-only table instead.';

-- ══════════════════════════════════════════════════════════════════
-- 2. set_institution_ai_policy — the ONLY write path for all three layers
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.set_institution_ai_policy(
  p_institution_id uuid,          -- NULL for layer='global'
  p_layer text,                   -- 'global' | 'platform' | 'institution'
  p_policy jsonb,                 -- { "allDisabled": bool, "disabledFeatures": text[] } — version is stamped here, not client-supplied
  p_expected_version integer      -- optimistic-concurrency guard
) RETURNS integer                 -- the new stored version
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_feature text;
  v_current jsonb;
  v_current_version integer;
  v_new_layer jsonb;
BEGIN
  -- ── Authorization FIRST. Nothing is read or validated before this gate. ──
  IF p_layer NOT IN ('global', 'platform', 'institution') THEN
    RAISE EXCEPTION 'invalid_layer';
  END IF;

  IF p_layer IN ('global', 'platform') THEN
    IF NOT public.is_super_admin() THEN
      RAISE EXCEPTION 'permission_denied';
    END IF;
  ELSE
    IF v_uid IS NULL OR p_institution_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = v_uid
        AND role = 'institution_admin'
        AND institution_id = p_institution_id
    ) THEN
      RAISE EXCEPTION 'permission_denied';
    END IF;
  END IF;

  IF p_layer <> 'global' AND p_institution_id IS NULL THEN
    RAISE EXCEPTION 'invalid_policy';
  END IF;

  -- ── Shape validation (size caps + key format; the TS registry is the key whitelist). ──
  IF p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object'
     OR jsonb_typeof(p_policy->'allDisabled') <> 'boolean'
     OR jsonb_typeof(p_policy->'disabledFeatures') <> 'array'
     OR jsonb_array_length(p_policy->'disabledFeatures') > 32
     OR (p_policy - 'allDisabled' - 'disabledFeatures') <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_policy';
  END IF;
  FOR v_feature IN SELECT jsonb_array_elements_text(p_policy->'disabledFeatures') LOOP
    IF v_feature !~ '^[a-z][a-z0-9-]{0,63}$' THEN
      RAISE EXCEPTION 'invalid_policy';
    END IF;
  END LOOP;

  -- ── Lock the row, check the version, write version+1 atomically. ──
  IF p_layer = 'global' THEN
    SELECT settings->'ai' INTO v_current
    FROM public.platform_settings WHERE id = true FOR UPDATE;
  ELSE
    SELECT settings->'ai'->p_layer INTO v_current
    FROM public.institutions WHERE id = p_institution_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  END IF;

  v_current_version := COALESCE((v_current->>'version')::integer, 1);
  IF p_expected_version IS DISTINCT FROM v_current_version THEN
    RAISE EXCEPTION 'version_conflict';
  END IF;

  v_new_layer := jsonb_build_object(
    'allDisabled', p_policy->'allDisabled',
    'disabledFeatures', p_policy->'disabledFeatures',
    'version', v_current_version + 1
  );

  IF p_layer = 'global' THEN
    UPDATE public.platform_settings
    SET settings = jsonb_set(settings, '{ai}', v_new_layer, true),
        updated_at = now()
    WHERE id = true;
  ELSE
    -- Two-step jsonb_set: create the {ai} parent first (jsonb_set only creates
    -- the LAST path element), then set the layer subkey — never clobbering the
    -- sibling layer or unrelated settings keys (selfUnenroll).
    UPDATE public.institutions
    SET settings = jsonb_set(
          jsonb_set(
            COALESCE(settings, '{}'::jsonb),
            '{ai}',
            COALESCE(settings->'ai', '{}'::jsonb),
            true
          ),
          ARRAY['ai', p_layer],
          v_new_layer,
          true
        ),
        updated_at = now()
    WHERE id = p_institution_id;
  END IF;

  RETURN v_current_version + 1;
END;
$$;

COMMENT ON FUNCTION public.set_institution_ai_policy(uuid, text, jsonb, integer) IS
  'Sole write path for the AI kill-switch layers. Role-checks the CALLER (auth.uid()) inside the function — must be invoked via the RLS-bound user client, never the service role. Raises permission_denied / version_conflict / invalid_policy / invalid_layer / not_found.';

-- Callable by signed-in admins (the function itself rejects everyone else); never by anon.
REVOKE EXECUTE ON FUNCTION public.set_institution_ai_policy(uuid, text, jsonb, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_institution_ai_policy(uuid, text, jsonb, integer) TO authenticated;
